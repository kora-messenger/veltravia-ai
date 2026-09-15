# Veltravia AI — Security Architecture

This document defines the security rules for Veltravia AI from day one. It is a living document: each later development step must extend it with the specifics of what that step introduces — never weaken the rules below.

## 1. Secrets are never committed to Git

- `.env` files are git-ignored. Only `.env.example` — which contains **placeholders, never real values** — is committed.
- API keys, tokens, passwords, and private keys never appear in source code, config files, tests, scripts, documentation, or commit history.
- If a secret is ever accidentally committed, it must be treated as compromised: rotate it immediately, then clean the history.

## 2. Production secrets live in a secret-management system

- **CI (today):** GitHub Actions secrets. The CI pipeline in Step 1 requires no secrets at all; when later steps need them, they are added as repository/org-level Actions secrets, never as files.
- **Production (future):** a dedicated secret manager (platform vault — e.g. AWS Secrets Manager, GCP Secret Manager, or equivalent). Applications fetch secrets at runtime; they are never baked into images or bundles.
- Secrets are injected via environment variables at runtime. The only code that reads them is `packages/config` (via `requireEnv`/`readEnv`), which keeps a single auditable path for secret access.

## 3. AI-generated code executes only in isolation

- All AI-generated code that Veltravia AI runs will execute inside a **sandboxed environment** (containers or an equivalent isolation boundary) — never directly on a development machine, CI runner, or production host.
- The sandbox is the enforcement point of `project-engine/execution/`: restricted filesystem, restricted network access, CPU/memory/time limits, and a non-privileged user.
- **The AI must never receive unrestricted access to the host machine.** No raw shell passthrough, no host filesystem mounts, no host network access by default.

## 3a. AI Core scope — hard restrictions (Step 2)

The AI Core package (`ai/core`) and its providers are an _abstraction layer only_. They MUST NOT:

- execute shell commands
- execute generated code
- access the filesystem (arbitrarily or otherwise)
- access environment secrets (API keys are bound only inside future provider adapters, via the secret manager)
- access GitHub credentials
- modify their own source code
- modify GitHub Actions or CI configuration
- deploy themselves

Those capabilities belong exclusively to the future controlled systems (`project-engine/execution/` for sandboxed execution, `security/` for approval gates). The Step 2 core is deliberately incapable of doing any of them: it has no child-process, filesystem, or network imports, and its configuration surface contains no secrets. Code review must reject any change that introduces these capabilities outside their designated future modules.

## 3b. AI provider credentials — Gemini (Step 3)

The first real provider credential exists as of Step 3: the Gemini API key. Its handling rules:

- **Read once, in one place.** Only `ai/providers/gemini/src/config.ts` reads `GEMINI_API_KEY`. The value is handed to the Google SDK client at construction and stored privately in the provider instance.
- **Never surfaced.** The key must never appear in logs, error messages, HTTP responses, or analytics. The adapter's error normalizer redacts the key substring from every message and detail it produces (`src/errors.ts`), and unit tests assert the redaction. Code review must reject any change that logs or returns provider credentials.
- **Never client-side.** The key is a server-environment secret. It must never be shipped to the web app, baked into a build, or referenced in client code.
- **Never in the repository.** `.env` is git-ignored; only `.env.example` (placeholders) is committed. CI is intentionally keyless — the optional live integration test (`tests/live/gemini.live.test.ts`) is skipped unless explicitly enabled locally.
- **Disable switch.** `GEMINI_ENABLED=false` un-registers the adapter at boot even when a key exists.
- **No vendor leakage.** Vendor SDK types and errors never leave the adapter package; everything crossing the boundary is a normalized Veltravia type or `AIError`.

The same rules apply to every future provider adapter (OpenAI, Anthropic, …): credentials are bound inside the adapter, scrubbed from all surfaces, and never trusted to the prompt stream.

## 4. Self-development requires controlled testing and approval

- The future self-development system (the platform proposing improvements to itself) must follow a fixed pipeline: **propose → test → review → approve → deploy**.
- Every self-proposed change runs through the same CI as human changes — lint, tests, build — plus additional review gates.
- A human approval step is **mandatory** before any self-proposed change reaches production. No autonomous deployment of self-modifications.
- All self-development attempts are recorded in an append-only audit log (what was proposed, what was tested, who approved, what was deployed).

## 5. Connector credentials are isolated

- Connector credentials (Slack, GitHub, Google, …) are held by a **Secure Credential Store** — never in generated project code, never in AI prompts, and never exposed to code the AI generates.
- When a user's generated project needs a connector capability, it talks to the Veltravia API, which performs the connector call on its behalf. The credential never crosses the boundary.
- Connector scopes follow least-privilege: each connector requests only the scopes it needs.

## 5a. Connector framework rules (Step 4, `connectors/core`)

The connector framework enforces the following principles — structurally where possible, all of them tested:

1. Connector credentials are never committed to Git. (`.env` is git-ignored; only placeholders ship.)
2. Connector credentials are never hard-coded. (A `CredentialReference` is a metadata-only pointer; the core has no field capable of holding a value.)
3. Connector credentials are never returned through API responses. (The read-only connector endpoints omit credential data entirely; tests assert no token-shaped material appears in payloads.)
4. Connector credentials are never logged. (Every error message and audit event is scrubbed of secret-like strings at construction; tests feed known token shapes and assert redaction.)
5. Generated code never automatically receives unrestricted connector credentials. (The AI holds references only; a future secure store fetches secrets at approved-operation time.)
6. Connector operations are permission-gated. (`authorizeOperation` checks grants; an ungranted operation is blocked and audited.)
7. High-risk operations require explicit user confirmation eventually. (Any operation requiring a `high`/`critical` permission is marked confirmation-mandatory — even if its declaration says otherwise.)
8. Connector execution happens only through controlled tooling. (The core cannot execute anything; Step 5's Tool/Function System routes through the manager's gate.)
9. The AI cannot invent arbitrary connector operations. (Only declared, validated, registered operations exist; unknown operations are rejected with typed errors.)
10. Every future connector declares its supported capabilities and permissions. (Registry validation rejects metadata that is incomplete or references undeclared permissions.)
11. Registration never grants permissions. (A connector's granted-permission set starts empty; grants are explicit, auditable, and revocable.)

## 5b. Tool System rules (Step 5, `tools/core`)

The tool layer enforces these principles — all of them tested:

1. AI-generated tool requests are untrusted input.
2. Tool ids are validated (the registry rejects malformed definitions).
3. Tool inputs are schema-validated before execution; problems name fields, never values.
4. Tools have explicit definitions (no anonymous or ad-hoc tools).
5. Tools must declare required permissions.
6. Registration does not grant permission — grants are explicit and auditable.
7. Tools cannot access raw credentials (they hold references at most).
8. Tools cannot bypass the ConnectorManager (connector-backed tools authorize through it and cannot have local handlers).
9. Tools cannot execute arbitrary code.
10. Tools cannot dynamically create unrestricted executable functions (handlers are typed, validated, pre-registered, and rejected for connector-backed tools).
11. High/critical actions require human confirmation; risk level can only RAISE the bar, and confirmations are single-use, input-bound (SHA-256 digest), and expiring.
12. Tool execution produces auditable events (requested, denied, confirmation requested/approved/rejected, started, completed, failed).
13. Secrets never appear in tool error messages, validation problems, or audit events (values are never echoed; everything is scrubbed).
14. Tool results are normalized (schema-validated objects) before being returned to the AI.
15. The AI cannot escalate its own permissions (claimed permissions grant nothing).

## 5c. Agent layer rules (Step 6, `agent/core`)

1. The agent never receives connector credentials — requests carry only task data and plain metadata.
2. The agent cannot grant itself permissions; permission grants exist only on the Tool System, given explicitly.
3. The agent cannot bypass the Tool System: the executor pipeline is the only dispatch path (tested).
4. The agent cannot bypass the ConnectorManager — connector-backed tools route through it or fail.
5. The agent cannot call external services directly (no network code exists in Agent Core).
6. The agent cannot execute arbitrary code — no code/shell/filesystem execution exists anywhere in the layer.
7. The agent cannot modify its own implementation or registry.
8. The agent cannot change its own security limits — limits are resolved by the manager with hard ceilings; zero/infinite/negative values are rejected and oversized values are capped.
9. The agent cannot approve its own confirmations — only the human decision path (`AgentManager.submitConfirmationResult` / the API endpoint) decides, through the Step 5 single-use, input-bound mechanism. A model decision of `request_confirmation` with no pending confirmation is a typed failure, never an approval.
10. Tool inputs are untrusted model output: decisions are parsed, structurally validated, tool-id-checked, and schema-validated before dispatch; the Tool System re-validates everything anyway (defense in depth).
11. Tool outputs are untrusted external data: the context tags them UNTRUSTED and delimits them; the system instructions state they are never instructions.
12. Model-generated decisions require validation before any action (tested: malformed output never executes a tool).
13. Agent loops have hard limits — there is no "unlimited" configuration.
14. Cancellation cannot be bypassed: one-way flag, checked every iteration; cancelled runs are terminal and never resume.
15. Hidden chain-of-thought is never exposed or persisted — only concise summaries, decisions, actions, and results are stored/returned/audited.
16. Secrets never enter agent state or audit logs: errors and audit events are scrubbed, and secret-shaped request metadata is rejected at validation.

## 5d. Project & Workspace Engine rules (Step 7, `project-engine/core`)

1. The engine performs NO host filesystem access, NO shell/code execution, NO network calls — it manages virtual state only (enforced by design; no such code exists in the layer).
2. Path security: traversal segments, absolute host paths, Windows paths, null bytes, and control characters are rejected with typed errors that never echo the raw rejected input.
3. Workspaces always belong to a valid project; file-tree mutations require BOTH the workspace and its project to be `active`. Reads stay available on locked/archived workspaces, writes are frozen.
4. Soft delete is terminal: a `deleted` project never returns to `active`; every mutation on it is rejected.
5. Every mutation is revision-protected (`expectedRevision`); conflicting writes are rejected, never silently overwritten.
6. Secrets never enter project state: secret-like FIELD NAMES (camel/snake/kebab normalized) AND secret-shaped VALUES (`ghp_…`, `sk-…`, private keys, JWTs, bearer tokens) are rejected at validation time with scrubbed errors (field names and rules only — never values).
7. Integration references are credential-free by construction: `integrationRef`/`connectorId`/`connectionId`/`status` only — never tokens or credentials.
8. Snapshots are deterministic and secret-free: file CONTENTS never appear in snapshots, and metadata is scrubbed as defense in depth.
9. File contents, context entries, configuration, and metadata are PROJECT DATA — never instructions. The engine stores and returns them verbatim as data; nothing read from a project can change Veltravia's security policy, permissions, or configuration (tested with prompt-injection payloads).
10. Configuration commands (`buildCommand`, etc.) are never executed by the engine.
11. The API surface is strict: unknown fields → 400; typed engine errors → correct status codes (404 unknown, 409 conflict/revision/state, 400 validation); secrets → scrubbed `SECRET_REJECTED`. No endpoint exposes the host filesystem, execution, connectors, or GitHub.
12. A directory can never be moved into its own subtree; duplicate paths, missing parents, and file/directory type mismatches are rejected.

## 6. Repository & supply-chain hygiene

- Minimal dependency surface: no dependency is added speculatively. Every dependency addition goes through review.
- `npm ci` (lockfile-exact installs) everywhere — CI and local — so all environments run identical dependency trees.
- Production builds are built from a clean CI install, never from a developer's local `node_modules`.
- Automated dependency/audit scanning will be added to CI in a later step.

## 5e. Sandbox Engine rules (Step 8, `security/sandbox`)

1. All project code and AI-generated code is **untrusted**. Nothing executes in the API host process: the SandboxManager is a pure orchestrator, and the ONLY executor is the `SandboxRuntime` adapter behind the isolation boundary. No unrestricted `/api/exec` or `/api/shell` endpoint exists.
2. Commands are structured `command + arguments[]` — never a shell string. `sh -c` / `bash -c` / `cmd /c` / `powershell -Command` do not exist as an execution path; shell interpreters are denied unless an explicitly reviewed policy exists (Step 8 never enables one).
3. Command policy is **allowlist-first**: a command runs only when it is a valid executable name AND is allowlisted AND is not on the hard denylist (`rm`, `sudo`, `kill`, `chmod`, … — the denylist is code and always wins over data-driven profiles).
4. The host environment is **never inherited** (source-scan enforced): the execution environment is built only from validated explicit entries; loader/hijack names (`LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV`, …) and secret-shaped values are rejected.
5. Network is **disabled by default**; only an explicit hostname allowlist exists. Unrestricted internet access is not a policy state.
6. Every execution carries complete, positive, ceiling-bounded resource limits (timeout, memory, cpu, output, processes, file bytes); zero/negative/absurd values are rejected, never clamped. Timeouts terminate work and orphan nothing.
7. Cancellation is one-way: `running → stopping → cancelled` is terminal, the `cancelRequested` flag wins over late completions, and a cancelled execution can never resume.
8. Sandbox stdout/stderr are untrusted data: bounded, truncation-marked, and secret-scrubbed before storage/return/audit. Prompt-injection payloads in output have zero authority (tested).
9. Sandbox permissions (`sandbox.create/execute/stop/destroy`) are granted only via the Tool System; `sandbox.execute` is high risk and always requires the Step 5 single-use input-bound human confirmation. The sandbox cannot grant itself anything — profiles and limits are immutable after creation.
10. The sandbox references a Project Engine workspace only by opaque id (validated, path-like values rejected); execution requests carry no workspace field, so cross-workspace access is impossible by construction.
11. Lifecycle transitions are validated (`destroyed` terminal; `stopped`/`expired` only lead to `destroyed`); sandboxes have a TTL and expire lazily, cancelling active work.
12. The mock runtime provides **NO OS-level isolation** and claims none (`providesOsIsolation: false`; enforcement reports are honest `enforced`/`requested`/`unavailable`). JavaScript restrictions are not a security boundary; a production runtime requires real isolation (container/microVM) — see docs/sandbox.md.

## 5f. Coding Agent rules (Step 9, `coding-agent/core`)

1. The coding agent reaches project files and sandboxes ONLY through the Tool System — there is no direct filesystem, execution, or engine access, and no tool id outside the registered coding surface can be invoked. Unknown action types are rejected: the model cannot invent tools.
2. Plans require HUMAN approval before any mutation when plan approval is enabled (the server default). The agent never approves its own plan or tool confirmations; rejections fail the run typed and terminal.
3. File content is UNTRUSTED DATA: read results are delimited in context and never treated as instructions. Prompt-injection attempts in file content or sandbox output gain zero authority (tested).
4. Revision discipline is enforced manager-side: the agent must have read or created a file before updating or deleting it, stale revisions fail typed, and the sandbox id is NEVER taken from decisions — it is pinned to the run's own sandbox.
5. Secret-shaped content is rejected before it reaches the workspace, the sandbox, errors, or audit (`CODING_SECRET_REJECTED`); all surfaces are scrubbed.
6. Every run is bounded by server-side limits with hard ceilings (iterations, tool calls, duration, consecutive failures). Limits from decisions are ignored; no run is unlimited.
7. Runs are state-machine-driven with terminal statuses (`completed`/`failed`/`cancelled`); cancellation is one-way, committed mutations are preserved, and audit records everything.
8. API responses carry the safe run view only — no file contents, no secrets, no chain-of-thought. The demo decision source is offline and scripted; no real model is wired into the API yet (documented development-only limitation).

## 5g. GitHub connector & invoke_tool rules (Step 10, `connectors/github` + `coding-agent/core`)

1. The connection scope (`owner/repository@branch` list) is enforced on EVERY operation — out-of-scope repositories are invisible even with a token that could read them.
2. Registration grants nothing. The API wiring grants GitHub tool permissions AND connector permissions explicitly, server-side; the model can never grant, widen, or bypass either gate.
3. `invoke_tool` is disabled unless the trusted server-side `toolAllowlist` is non-empty; the model can name an allowlisted tool but never add one, and every invocation re-passes the full Tool System pipeline (schema → permissions → connector auth → confirmation → execute).
4. High/critical-risk GitHub tools (`content_write`, `content_delete`) force single-use, input-bound human confirmation — the agent never self-approves.
5. File writes/deletes require the current `sha` (revision protection); stale writes fail typed. Branch names, paths, and shas are validated (traversal, null bytes, control characters rejected).
6. The production transport is HTTPS-only to `api.github.com` with fixed headers, no redirects, and a hard timeout; the token is read per request via provider callback, never retained, never logged, scrubbed from every error and audit event.
7. Remote repository content is UNTRUSTED DATA: delimited replay in coding context, never instructions — prompt injection gains no authority.
8. The API's demo mode (offline fake transport when env vars are absent) is a documented development-only limitation; gates are real, the remote end is a fixture. Real mode is enabled ONLY by `GITHUB_API_TOKEN` + `GITHUB_REPOSITORIES` env.
9. The live harness (`tests/live/github.live.test.ts`) is strictly read-only and off unless explicitly enabled locally (`RUN_GITHUB_INTEGRATION_TESTS=true` + env); CI never sets it.

## 5h. Web UI security boundary rules (Steps 11A–11C-1, `apps/web`)

1. The web app is a rendering surface only: no credential material (tokens, API keys, database credentials, OAuth access tokens, secrets, private keys) may enter React state, localStorage, sessionStorage, frontend source, HTML, URL parameters, or browser-visible API responses.
2. The only client-persisted value today is the theme preference (`veltravia.theme-preference`) — UI state, never credential material.
3. Future integrations surface credential references and connection status only; the UI never displays or stores raw credentials.
4. Unimplemented backend features render as clearly-unavailable UI (disabled items, placeholder pages); the UI never fabricates a successful operation.
5. All styling flows through centralized design tokens (`apps/web/src/design/tokens.css`); no raw color or secret-shaped literals are scattered through components.
6. Every network call goes through `src/api/client.ts`; failures are normalized to typed `ApiError`s with scrubbed messages — provider internals, stack traces, and raw error payloads never reach the screen.
7. API responses are validated and mapped to safe view models before React state (`src/api/projects.ts`, `src/api/workspaces.ts`): `metadata`, `ownerRef`, and logical `root` are dropped; the frontend renders server-derived data only.
8. The frontend NEVER hardcodes a user identity: project creation sends no `ownerRef`; the API assigns one server-side (`VELTRAVIA_DEFAULT_OWNER_REF`, development default `veltravia-dev-user`) until authentication exists. `ownerRef` is identity metadata, never a credential.
9. Mutating writes are revision-safe in the UI: project edits send `expectedRevision`; a 409 `REVISION_CONFLICT` is surfaced to the user and the latest server state is reloaded — the UI never silently overwrites.
10. Consequential actions (archive/restore) require an explicit confirmation dialog and report server rejections honestly; the UI never fakes success or retries destructively.
11. The AI workspace (Step 11C-1) is a visual shell only: it calls no AI, agent, coding-agent, tool, sandbox, or connector API. Submitted text stays in local React state and is never transmitted; the UI says so explicitly rather than implying delivery.
12. Workspace messages render as plain React text nodes. Untrusted origins (AI output, tool output, project file content, sandbox output) are never interpreted as HTML (`dangerouslySetInnerHTML` is not used for them) and never executed.
13. Every conversation message carries an explicit origin (user / assistant / system / tool output); the trust presentation makes data provenance visible without exposing internal security mechanics.
14. The workspace file tree is a labeled illustration, not fabricated live data; no fake filesystem API exists. Activity panels render honest empty states and never fabricate tool calls, runs, or results.

## 7. Incident response

- Suspected secret leak → rotate first, investigate second.
- Report security issues privately to the repository owner; do not open public issues for vulnerabilities.
