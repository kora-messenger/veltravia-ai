# Agents

Step 6 added the **AI agent orchestration layer**: provider-neutral agents that receive a task, maintain controlled state, reason through it, request tools, process results, and complete — within hard limits. This is an ORCHESTRATION layer, not a coding agent, not a project/workspace engine, not self-development.

- Package: `agent/core` (`@veltravia/agent-core`) — depends only on `@veltravia/ai-core` + `@veltravia/tool-core`
- Mocks: `agent/mock` (`@veltravia/agent-mock`) — deterministic, offline scripted agents for tests and CI

## What an agent is (and is not)

| Layer                          | Responsibility                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI Core** (`ai/core`)        | Talks to models. A single `generate(request)` → response. It has no concept of tasks, tools, or loops.                                                                    |
| **Agent** (`agent/core`)       | REASONS ABOUT A TASK. Owns the loop: decide → request tool → read result → decide … → answer. Uses AI Core for decisions and the Tool System for actions.                 |
| **Tool System** (`tools/core`) | The ONLY path to actions. Validates input, checks permissions, connector authorization, and confirmations. The agent submits requests; it never executes anything itself. |

The difference in one sentence: **the Agent decides WHAT to do; the Tool System decides WHETHER it may happen.**

## Architecture

```
            User Request
                 │
                 ▼
              AI Agent
                 │
      ┌──────────┼──────────┐
      │          │          │
      ▼          ▼          ▼
   Planner   Tool Request  Finalizer
      │          │
      └──────────┘
                 ▼
            Tool System          (the authority)
                 │
          Permission Gate
                 │
                 ▼
         Connector Manager       (Step 5 boundary: execution beyond
                 │                authorization stays disabled)
                 ▼
             Connector
```

The agent's decision path is `Agent → AI Core → AI Router → AI Provider`. `@veltravia/agent-core` never imports a vendor SDK; swapping the mock provider for Gemini (or a future OpenAI/Claude provider) requires **no change to Agent Core**.

## The agent loop

1. Receive task (`AgentRequest`: task, optional session/project/user ids, optional tool filter, optional caller limits, plain metadata — **never secrets**).
2. Validate the request; the manager resolves limits (defaults + hard ceilings).
3. Create a run (`agent_run_created` audit event) and start from `idle → planning`.
4. Each iteration, **after checking cancellation + duration + iteration + tool-call budgets**: build the trust-tagged context and ask the `DecisionSource` for a decision.
5. Parse and structurally validate the decision (`AgentDecision`) — **raw model text is never acted on**.
6. For `request_tool` decisions: pre-validate the tool id + input against the Tool System schema, then dispatch THROUGH the Tool Manager.
7. Record the normalized result into run state and continue the loop.
8. Terminate on `answer`/`stop` (completed), `fail` (failed), limits (limit_reached), cancellation (cancelled), or pause on `awaiting_confirmation`.

There are NO unrestricted autonomous loops: every run is bounded by `AgentExecutionLimits`.

## Agent state & statuses

`AgentState` tracks: agent id, run id, status, task, iteration, tool-call count, consecutive failures, created/updated timestamps, tool invocation history, pending confirmation, final result, error info. It never stores raw secrets or hidden model reasoning.

Statuses and the controlled transition table (enforced in `state/index.ts`):

- `idle → planning / cancelled / limit_reached`
- `planning → planning (iterations) / waiting_for_tool / waiting_for_confirmation / executing / completed / failed / limit_reached / cancelled`
- `waiting_for_tool → executing / failed / limit_reached / cancelled`
- `executing → planning / waiting_for_confirmation / failed / limit_reached / cancelled`
- `waiting_for_confirmation → executing (approve) / planning (reject) / failed / limit_reached / cancelled`
- Terminal statuses (`completed`, `failed`, `cancelled`, `limit_reached`) have **empty** transition lists. `completed → executing` and `failed → executing` are impossible; a cancelled run never resumes automatically.

`AgentRegistry` rejects duplicate ids; one default agent (`DefaultAgent`) plus the mock/test agents is the intended shape — no autonomous agent personalities.

## Tool request flow

`AgentToolRequest` (tool id, validated input, invocation id, concise summary, confirmation requirement, correlation id) is submitted to the Tool System. The agent NEVER calls a connector directly:

```
Agent → ToolManager → Permission Gate → ConnectorManager → Connector
```

`AgentToolResult` normalizes invocation id, tool id, status (`success | failure | denied | awaiting_confirmation`), output, typed error, and timestamps. Tool outputs are UNTRUSTED EXTERNAL DATA.

## Confirmation flow

The Step 5 confirmation model stays authoritative:

```
Tool requested ─▶ confirmation required? ─▶ YES ─▶ agent status: waiting_for_confirmation
                                              ─▶ Human approve/reject (manager/API)
                                              ─▶ continue (execute same input) or stop
```

- The agent can never approve its own confirmations.
- The agent can never modify a confirmation request to avoid approval.
- Approvals are single-use and input-bound (Step 5 SHA-256 digest): approving input X can never execute input Y. The resume path re-submits the **stored** pending input — the model cannot swap it.
- Rejections continue the loop with a denial recorded in state, so the agent can answer or stop gracefully.

## Decision model & model-output validation

`AgentDecision` is a normalized, provider-neutral union: `answer | request_tool | request_confirmation | continue | fail | stop`. A tool decision carries only the structured invocation info plus an optional concise summary (≤ 500 chars) — **no hidden chain-of-thought is stored, returned, or audited anywhere**.

Model output is untrusted: it is parsed (JSON extraction), structurally validated, type-checked, tool-id-checked, and schema-validated BEFORE the Tool System sees it. Malformed output produces a typed `AGENT_INVALID_DECISION` / `AGENT_MODEL_ERROR` failure and counts toward the consecutive-failure limit.

## Execution limits

`AgentExecutionLimits`: max iterations (default 8, ceiling 50), max tool calls (default 8, ceiling 50), max duration (default 60 s, ceiling 10 min), max consecutive failures (default 3, ceiling 10), optional output-token budget. **There is no "unlimited"** — zero/infinite/negative values are rejected, values above the ceilings are silently capped, and the agent cannot change its own limits at runtime. A reached limit returns `limit_reached` with a safe explanation.

## Cancellation

`AgentManager.cancelRun()` sets a one-way flag: the loop stops at its next checkpoint (or immediately when paused), no further tool requests are dispatched, the run is marked cancelled, and an `agent_cancelled` audit event is produced. Cancelled runs are terminal.

## Trust boundaries (prompt-injection defense)

The context (`agent/core/src/context`) tags every entry with a role and trust level:

- `system` + `tool_metadata` + `state` → **trusted** (built from our own instructions and the Tool System registry)
- `user` → **user input** (untrusted in a different way — it is the task)
- `tool_result` → **UNTRUSTED DATA**, wrapped in explicit delimiters, and the system instructions state that tool results are never instructions

This is deliberately an architectural boundary, not a complete prompt-injection defense engine: the goal is that no future component can accidentally treat tool-returned text as trusted instructions. The context is also bounded (only the last 10 tool results are replayed; older ones are counted), leaving room for future trimming/summarization.

## Security rules (enforced + tested)

1. The agent never receives connector credentials.
2. The agent cannot grant itself permissions (permissions come only from explicit grants to the Tool System).
3. The agent cannot bypass the Tool System (the executor is the only dispatch path).
4. The agent cannot bypass the ConnectorManager.
5. The agent cannot call external services directly.
6. The agent cannot execute arbitrary code.
7. The agent cannot modify its own implementation.
8. The agent cannot change its own security limits.
9. The agent cannot approve its own confirmations.
10. Tool inputs are untrusted model output (re-validated by the Tool System).
11. Tool outputs are untrusted external data (trust-tagged, delimited).
12. Model-generated decisions require validation before action.
13. Agent loops have hard limits (no unlimited).
14. Cancellation cannot be bypassed.
15. Hidden chain-of-thought is never exposed or persisted (decisions carry concise summaries only).
16. Secrets never enter agent state or audit logs (scrubbed; secret-shaped request metadata is rejected outright).

## Project/workspace run context (Step 11C-4)

A run may carry `projectId` and `workspaceId` identifiers. They are
resolved SERVER-SIDE against the Project Engine: unknown ids are 404s, a
workspace belonging to another project is a 400, and a `workspaceId`
without a `projectId` is rejected (no unchecked association). The browser
is never trusted to supply association data.

From the validated pair the API derives a bounded, safe context and
delivers it as an explicit `project_context` block inside the run
request:

- project identity (id, name, description (length-capped), status,
  project type) and workspace identity (id, name, status, revision)
- the workspace's file tree as STRUCTURE ONLY (relative path + node
  type, capped node count with honest `total`/`included`/`truncated`
  flags, and shrunk further to fit the request's serialized-size ceiling)
- NO file contents, NO owner refs, NO root URIs, NO credentials.

The block is trust-tagged UNTRUSTED DATA and framed as "not an
instruction": hostile project text reaches the model as inert data and
can never change the system prompt or grant authority. Like every agent
input it is secret-scanned and size-capped before the loop begins.

## API (development-only)

| Endpoint                                    | Purpose                                          |
| ------------------------------------------- | ------------------------------------------------ |
| `GET /api/agents`                           | List registered agents (safe metadata)           |
| `POST /api/agents/run`                      | Create + execute a bounded run                   |
| `GET /api/agents/runs/:runId`               | Safe run snapshot (state, results, confirmation) |
| `POST /api/agents/runs/:runId/cancel`       | Cancel a run                                     |
| `POST /api/agents/runs/:runId/confirmation` | Submit the human `approve`/`reject` decision     |

**Development-only limitations (temporary, deliberate):**

- The demo agents (`agent.demo`, `agent.demo.answer`, `agent.demo.confirm`) run on deterministic, offline **scripted decision sources** — no real model is wired into the API yet. Every orchestration concern (gates, confirmations, limits, audit, cancellation) is fully real; swapping in a `ModelDecisionSource` + real provider changes nothing else.
- `agent.demo.confirm` (Step 11C-3) pauses on a real critical-risk confirmation (`mock.purge`) so the workspace's human-approval flow can be exercised end-to-end: the run pauses, the browser collects an approve/reject decision, and the Tool System — never the browser — validates and executes it (or skips it) and returns the next run state. Run views expose tool activity (recorded invocations) and confirmation METADATA only (tool id, risk level, state, expiry); the requested tool input never leaves the server.
- Runs are in-memory; there are no persistent job queues or background workers in Step 6.
- The endpoints carry no authentication beyond the app's current boundary (the app has no auth infrastructure yet).

## Future: the coding agent

The Step 6 agent is a GENERAL ORCHESTRATOR. It does not create/edit files, run terminals, install packages, compile, debug, create repos/branches/commits, or deploy — those arrive later through the Project/Workspace Engine, Sandbox, Coding Agent, and GitHub Connector, all built on top of this layer's gates.

## Project memory (Step 15)

Runs associated with a project may carry a bounded `memoryContext`:
derived server-side from the project's ACTIVE memories (never from the
browser), built by the Memory Context Builder, and delivered to the model
inside a labeled block that declares itself UNTRUSTED reference data.
Validation matches every other request surface: non-empty string, hard
size cap, secret-shaped content rejected. See [memory.md](memory.md).
