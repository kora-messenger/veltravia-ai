# Veltravia AI — The Tool System (Step 5)

## What is a tool?

A **tool** is a _controlled, declared operation_ that Veltravia AI's future agent layer may request — summarizing data, reading a resource through a connector, eventually creating a repository or charging a payment. Tools are the ONLY sanctioned way for AI orchestration to _do_ anything: every request flows through one gated pipeline that re-checks everything, every time.

The tool system shipped in Step 5 (`tools/core` + `tools/mock`) is **infrastructure, not an agent**. It does not decide when or why to use a tool, does not call an LLM, does not touch the network by itself, and does not autonomously execute anything.

## Tool vs. Connector vs. (future) Agent

| Concept       | Definition                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Connector** | Connection/integration with an external service (Step 4). Owns credentials (by reference), permission grants, and declared operations.                                   |
| **Tool**      | Controlled operation that can eventually use a connector. Owns input/output schemas, tool-level permissions, risk level, and confirmation requirements.                  |
| **AI Agent**  | Future orchestration layer that decides when and why to use tools. NOT implemented in Step 5 — the tool system is built so the agent layer arrives without core changes. |

The final architecture:

```
         AI Core
            │
      Future Agent            (does not exist yet)
            │
       Tool System
            │
      Permission Gate
            │
            ▼
    Connector Manager        (Step 4)
            │
            ▼
   Specific Connector
            │
            ▼
   External Service
```

The Tool System sits ABOVE the connector architecture and **must never bypass the ConnectorManager** — connector-backed tools authorize through it (there is no other path), and they cannot have local handlers.

## Tool definitions

A `ToolDefinition` is pure metadata: `id`, `name`, `description`, `version`, `category`, `inputSchema`, `outputSchema`, `requiredPermissions`, optional `connector` reference (`connectorId` + `operationId`), `riskLevel`, and `requiresConfirmation`. Registration validates the whole structure and grants NOTHING — a registered tool is only a definition.

Categories are provider-neutral (`data`, `filesystem`, `source_control`, `code`, `communication`, `deployment`, `storage`, `payments`, `search`, `ai`, `system`, `other`). A category never implies executability — availability is a separate runtime concept.

## Validation

Inputs and outputs are described by a tiny dependency-free schema vocabulary (in `validation/schema.ts`): required fields, optional fields, field types, enums, string lengths, numeric ranges, array items, and nested objects. Validation runs BEFORE any execution (rejecting missing required fields, wrong types, malformed input, and unexpected fields) and output validation runs BEFORE any result reaches the AI. Problem messages name **fields, never values** — input values are untrusted and may contain secrets.

## Permissions

A tool declares `requiredPermissions`; an operator explicitly grants them per-tool (`grantPermission` — only declared permissions are grantable). **Registration grants nothing.** Claims by the requester (`requestedPermissions` on an invocation) are recorded but grant nothing. The AI cannot escalate its own permissions.

For connector-backed tools there is a second, mandatory layer: the ConnectorManager's own permission gate (`authorizeOperation`). Both gates must pass.

## Invocation

A `ToolInvocation` records an AI request: invocation id, tool id, input, requestedAt, requester, claimed permissions, confirmation state, and a correlation id. A request is **never automatically permission to execute**. The pipeline for every invocation:

```
AI requests tool
  ↓ tool exists?
  ↓ runtime availability?          (disabled / connector state / grants)
  ↓ input valid?                   (schema validation)
  ↓ required permissions granted?
  ↓ connector available & authorized?   (connector-backed tools only)
  ↓ confirmation required?          (definition flag OR high/critical risk)
  ↓ execute only if authorized
  ↓ output validated & normalized
  ↓ result: success | failure | denied | awaiting_confirmation
```

## Human confirmation

Confirmations are explicit human decisions (`confirmation/`): `not_required → required → approved | rejected | expired`. The framework **never auto-approves** — a future UI/agent layer asks "Veltravia AI wants permission to perform this action" and records the decision through `ToolManager.confirm()`. Approvals are bound to one tool, one invocation, and one exact input (SHA-256 digest), expire after a TTL (default 5 minutes), and are **single-use** — a consumed approval can never be replayed. High- and critical-risk tools force confirmation even when their definition says otherwise (the flag can only raise the bar).

## Availability

`getAvailability()` answers "may this tool run RIGHT NOW?": `available`, `disabled`, `unavailable`, `misconfigured`, `permission_denied`, `awaiting_configuration`. A registered tool is never automatically executable.

## Execution boundary (Step 5)

The `ToolExecutor` runs the pipeline above, but with an explicit boundary:

- **Local safe tools** (the mock) execute deterministically through typed, pre-registered handlers — never anonymous functions, never per-invocation registration, and handlers only exist for non-connector tools.
- **Connector-backed tools** stop at authorization: execution is deliberately NOT enabled for external services yet — an invocation that passes every gate fails with a typed "execution not enabled" error. Real connector operation execution arrives with the connector execution layer.

## Audit events

Every decision emits a scrubbed `ToolAuditEvent` to a registered sink (same philosophy as the Step 4 connector audit): `tool_registered`, `tool_unregistered`, `tool_permission_granted`, `tool_permission_revoked`, `tool_invocation_requested`, `tool_invocation_denied`, `tool_confirmation_requested`, `tool_confirmation_approved`, `tool_confirmation_rejected`, `tool_execution_started`, `tool_execution_completed`, `tool_execution_failed`. Events never contain credentials, secrets, or raw input/output values. No persistent audit database exists yet — persistence is a future sink swap.

## Security model

1. AI-generated tool requests are untrusted input.
2. Tool ids are validated.
3. Tool inputs are schema-validated before execution.
4. Tools have explicit, validated definitions.
5. Tools must declare required permissions.
6. Registration does not grant permission.
7. Tools cannot access raw credentials (they hold references at most).
8. Tools cannot bypass the ConnectorManager.
9. Tools cannot execute arbitrary code.
10. Tools cannot dynamically create unrestricted executable functions (handlers are typed, validated, pre-registered, and rejected for connector-backed tools).
11. High/critical actions require confirmation (risk level can only raise the bar).
12. Tool execution produces auditable events.
13. Secrets never appear in tool inputs' _error messages_, audit events, or validation problems (values are never echoed; everything is scrubbed).
14. Tool results are normalized (schema-validated objects) before returning to the AI.
15. The AI cannot escalate its own permissions.

## The API surface (read-only, for now)

`GET /api/tools` and `GET /api/tools/:id` expose safe metadata only: id, name, description, category, permissions, risk level, availability, confirmation requirement. There is **no execution endpoint** — invocation arrives only with the future agent layer, behind the full gate. No credentials are ever exposed.

## Mock tools (`tools/mock`)

Three deterministic, offline, credential-free mock tools prove the system: `mock.summarize` (executable: input validation + normalized output), `mock.purge` (critical-risk: proves risk-forced confirmation), and `mock.connector.read` (connector-backed: proves the Tool → ConnectorManager → Connector relationship, authorization-only). Nothing simulates GitHub or production infrastructure.

## Future relationship with AI agents

When the agent layer is built, it will: receive tool metadata (definitions, availability), decide which tool to request, build input, call `ToolManager.invoke()`, handle `awaiting_confirmation` by surfacing the request to the human, and consume normalized results. No agent code exists in Step 5 — but every seam it needs (inspection, invocation, confirmation decisions, audit) is already in place and tested.
