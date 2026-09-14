# Coding Agent

Step 9 added the **Coding Agent layer**: a bounded, state-machine-driven agent that can modify project files and run validations — with every mutation and execution flowing through the Tool System, and every destructive step decided by a human.

- Package: `coding-agent/core` (`@veltravia/coding-agent-core`) — depends only on `@veltravia/project-core`, `@veltravia/sandbox-core`, and `@veltravia/tool-core`
- Mocks: `coding-agent/mock` (`@veltravia/coding-agent-mock`) — deterministic, offline scripted runs and a fixture environment for tests and CI
- API: `/api/coding/runs…` (start, inspect, cancel, confirm)

## What it is (and is not)

| Layer                                      | Responsibility                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent** (`agent/core`)                   | General orchestration: decide → request tool → read result → answer. No file or execution semantics.                                                                                      |
| **Coding Agent** (`coding-agent/core`)     | The file-and-validation SPECIALIZATION of that loop: plan → act on files → validate → complete. Still reaches files and sandboxes ONLY through tools — it executes nothing itself.        |
| **Tool System** (`tools/core`)             | The ONLY path to project files and the sandbox. Input validation, permissions, connector authorization, and confirmations all apply unchanged.                                            |
| **Project Engine** (`project-engine/core`) | Owns project/workspace/file state. The coding agent's project tools are thin, typed wrappers over the engine — the engine's rules (revisions, path security, lifecycle) are not bypassed. |

The coding agent NEVER: reads or writes the host filesystem directly, spawns processes, approves its own plan or tool confirmations, changes its limits, or treats file content as instructions.

## Run lifecycle

```
idle → analyzing → (awaiting_approval) → inspecting → editing → validating → iterating → completed
                                            ↘ (any non-terminal state) → cancelled
                   (typed failure from any state) → failed  (terminal)
```

- Every transition is validated; `completed`, `failed`, and `cancelled` are terminal and never resume.
- With plan approval required (server default), the agent must produce a valid plan and a HUMAN approves or rejects it before any file is touched. Rejection fails the run typed (`CODING_PLAN_REJECTED`).
- Cancellation is one-way: committed mutations are preserved, the run stays terminal, and audit records the cancellation.

## Decisions and the plan

The decision source is provider-neutral (a scripted source in tests and in the API demo; AI routing belongs to a later step). Every decision is validated before it is acted on:

- `plan` — goal, ordered steps, files to inspect/modify, validations, acceptance criteria. Steps must be non-empty strings; `filesToModify` and `filesToInspect` must be disjoint.
- `action` — one of the registered coding tool actions (below). Unknown action types are rejected: the model cannot invent tools.
- `complete` — the run ends with a summary.

Raw model output is never acted on directly, and no chain-of-thought is stored or returned anywhere.

## The coding tool surface

Registered tool ids (all flow through the Tool System with explicit server-side grants — registration alone grants nothing):

| Tool                  | Purpose                                                   | Risk / confirmation                  |
| --------------------- | --------------------------------------------------------- | ------------------------------------ |
| `project.inspect`     | Safe project/workspace metadata (active project enforced) | low                                  |
| `project.list-files`  | List a workspace directory                                | low                                  |
| `project.read-file`   | Read file content + revision                              | low                                  |
| `project.create-file` | Create a workspace file                                   | medium                               |
| `project.update-file` | Update a file (requires a tracked, non-stale revision)    | medium                               |
| `project.delete-file` | Delete a file                                             | high → **forced human confirmation** |
| `project.move-file`   | Move/rename a file                                        | medium                               |
| `sandbox.create`      | Create the run's validation sandbox                       | low                                  |
| `sandbox.execute`     | Run a validation command in the sandbox                   | high → **forced human confirmation** |

- The agent must have read or created a file (and hold its revision) before updating or deleting it; stale revisions fail typed (`CODING_STALE_REVISION`).

### `invoke_tool` — connector tools (Step 10)

An OPTIONAL fourth action type lets a run call an explicitly allowlisted connector-backed tool (e.g. the GitHub connector's `github-demo.contents.get`):

- The allowlist is TRUSTED SERVER-SIDE config (`toolAllowlist` on the manager). An empty/absent list disables `invoke_tool` entirely; the model can never widen it, and a tool outside the list fails typed (`CODING_INVALID_DECISION`) before anything executes.
- Every invocation still passes the FULL Tool System pipeline: schema validation, explicit permissions, connector authorization (the connector's own permission gate is separate and must be granted too), risk classification, and forced single-use human confirmation for high-risk tools (`content_write`/`content_delete` pause the run exactly like plan approval).
- The tool result reaches the NEXT decision as UNTRUSTED DATA — the same delimited replay used for file content. Malicious repository content (e.g. injected instructions in a README) is visible to the run but gains NO authority; tests prove a run that reads hostile content continues unchanged.
- Tool failures are recorded honestly (bounded failures, consecutive-failure limit) and never leak connector error internals — messages are scrubbed.

Rules enforced in the manager, not in the model's hands:

- The sandbox id is NEVER taken from a decision — the manager pins it to the run's own sandbox.
- File content returned from reads is UNTRUSTED DATA: it is delimited in context and never treated as instructions (prompt-injection attempts gain no authority).
- Secret-shaped content is rejected before it reaches the workspace or the sandbox (`CODING_SECRET_REJECTED`), and errors/audit are scrubbed.

## Limits

Server-side per-run limits with hard ceilings (defaults: 8 iterations, 8 tool calls, 60s, 3 consecutive failures; ceilings 50/50/10min/10). Limit fields smuggled into decisions are ignored — limits come from trusted server config only. Exceeding a limit fails the run typed (`CODING_*_LIMIT`, `CODING_CONSECUTIVE_FAILURES`).

## API surface

- `POST /api/coding/runs` — start a run (strict schema; returns the safe run view, pauses at plan approval)
- `GET /api/coding/runs/:runId` — safe run view (no secrets, no chain-of-thought)
- `POST /api/coding/runs/:runId/cancel` — cancel (terminal)
- `POST /api/coding/runs/:runId/confirmation` — human approve/reject for plans and tool confirmations

The API's coding agent runs on a deterministic scripted decision source — no real model is wired into the API yet (a documented development-only limitation; prompt tuning belongs to a later step). The orchestration, gates, confirmation flow, limits, and audit are fully real.

## Development-only limitation

`createDemoCodingDecisionSource()` is deterministic and offline by design. Swapping it for an AI-routed decision source touches one seam (the `decisionSource` option) — the state machine, tool gates, human confirmations, and limits are identical for a real model.
