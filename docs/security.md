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

## 5h. Web UI security boundary rules (Steps 11A–11C-5, `apps/web`)

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
11. The AI workspace (Step 11C-2) submits prompts ONLY to the Veltravia Agent API (`POST /api/agents/run` with `{ agentId, task, projectId }`). It calls no provider, tool, sandbox, or connector API directly; the browser is never a provider client, and no provider credential may exist anywhere in frontend source or environment (test-enforced: `apps/web/src/security/workspace-boundary.test.ts`).
12. Workspace messages render as plain React text nodes. Untrusted origins (AI output, tool output, project file content, sandbox output) are never interpreted as HTML (`dangerouslySetInnerHTML` is not used for them) and never executed.
13. Every conversation message carries an explicit origin (user / assistant / system / tool output); the trust presentation makes data provenance visible without exposing internal security mechanics.
14. The workspace file tree is a labeled illustration, not fabricated live data; no fake filesystem API exists. Activity panels render honest empty states and never fabricate tool calls, runs, or results.
15. A workspace conversation shows an assistant message ONLY when the Agent API reports a completed run; failed, cancelled, limit-reached, and paused runs surface honest states with no fabricated output. The UI never displays "completed" unless the backend said so, and never shows chain-of-thought (the safe run view exposes only `finalOutput`).
16. Run polling is bounded (attempt and consecutive-failure ceilings), never overlaps, stops on terminal/paused states, and cleans up on unmount. A stale or mismatched run payload (wrong `runId` or a superseded generation) is discarded — an old run can never overwrite a newer one. Cancellation is requested at most once per run and is claimed only after the server confirms it.
17. The only browser-persisted value remains the theme preference. Run state, prompts, and responses live in memory; the workspace stores no tokens, no API keys, and no provider material in localStorage or sessionStorage.
18. Human confirmations (Step 11C-3) are decided by the SERVER, never the browser: the workspace submits only the decision (`approve`/`reject`) to `POST /api/agents/runs/:id/confirmation`, and every rule — expiry, input binding, permissions, single-use — is enforced by the Tool System behind the API. The UI renders only server-reported confirmation metadata (tool id, risk level, state); the requested tool input never reaches the browser. An expired confirmation is terminal in the UI: it cannot be approved, and the card says so. At most one decision is in flight per run, a failed delivery keeps the run at its last server-confirmed state with an honest note (never a fabricated outcome), and a paused run is followed on a slow cadence so server-side expiry is surfaced.
19. Tool activity (Step 11C-3) renders only what the run view reports: recorded tool invocations and the pending confirmation, in the backend's order, as bounded plain text — never HTML, never executed. Tool output is UNTRUSTED DATA; the panel truncates it with an honest note and the workspace never fabricates a tool call, result, or status.
20. Project/workspace association (Step 11C-4) is SERVER-AUTHORITATIVE: the run endpoint accepts `projectId` + `workspaceId` identifiers but resolves them against the Project Engine — unknown project/workspace → 404, a workspace from another project → 400, `workspaceId` without `projectId` → 400 (no unchecked association). The derived run context is bounded, safe metadata: project/workspace identity fields and structural file-tree entries (path + type) only — NEVER file contents, never owner refs, never the workspace root URI. Large trees are truncated with honest `total`/`included`/`truncated` flags and the whole context is shrunk to fit the agent request's serialized-size ceiling (secret-scanned like every agent input). Project text travels as an explicit `project_context` UNTRUSTED DATA block delimited as "not an instruction" — it is never concatenated into the trusted system prompt and never carries authority.
21. The web workspace (Step 11C-4) renders project context read-only: the file tree comes from `GET /api/workspaces/:id/tree` (structural metadata), and the web source never calls file-content endpoints nor mutates files (test-enforced static scan). The browser never constructs, normalizes, or re-sends paths; depth indentation is a display choice over backend-validated relative paths. A run started before a workspace switch keeps its server-pinned association; only new runs use the new selection.
22. The Step 11C-5 polish/hardening pass changed PRESENTATION ONLY and introduced no new data flow: the conversation `role="log"` region announces the same backend-confirmed messages the UI already renders (never provider text or hidden reasoning), client-side create-failure notes contain only safe copy produced by the workspace itself, and the pass must not weaken any rule in this section — a polish change that touches an endpoint, a credential path, or a trust boundary is out of scope for such a pass by definition.

## 5i. Integration layer rules (Step 12, `integrations/core` + `connectors/integration-mocks`)

1. An integration is a declarative manifest, never executable behavior: `integrations/core` contains no vendor SDKs, no network code, and no host access. Every concrete integration is its own package registering a manifest + an executor.
2. The registry accepts definitions only after STRICT manifest validation (ids, catalog shapes, duplicates, and scope references — a tool may only require scopes the integration itself declares). Registration grants nothing: it is a catalog entry, not an authorization.
3. DECLARED vs GRANTED stays sacred: the scope catalog says what an integration COULD do; a connection's granted scopes say what the owner actually ALLOWED. The runtime executes an operation only when every required scope is granted — missing scopes fail closed with a typed error and an audit event.
4. Connections are owner-scoped: every lookup and mutation resolves inside the owner boundary, and a cross-owner or unknown connection id fails closed as not-found. `disconnected` is terminal; disabled connections fail closed until re-enabled.
5. Credential material never enters a connection, a manifest, an API response, or an audit event. The `SecretStore` boundary resolves a secret inside the runtime only, as a getter handed to the executor; the value is never stored, logged, or returned in any view.
6. The runtime is the single sanctioned execution boundary and the ONLY caller is the Tool System's `connectorExecutor` seam. The agent layer never reaches it directly, and connectors can never be invoked around the Tool System.
7. The risk gate is defense-in-depth, not a second approval path: high/critical operations must arrive marked `confirmationGated` by the Tool System (which enforced the human confirmation upstream); an unconfirmed high-risk operation fails closed and is audited. This layer never invents its own approval mechanism.
8. Every execution passes the full pipeline — resolve, enable-check, owner-boundary connection, connection state, declared-operation check, scope authorization, risk gate, in-boundary credential retrieval, executor call, secret-scrubbed + shape-validated result, normalized safe view — and every outcome (executed/failed/denied) writes a bounded audit event with no raw input and no secrets.
9. Errors are typed, sanitized `IntegrationError`s; provider internals, stack traces, and credential-shaped values are scrubbed before anything surfaces in errors, audits, or API responses.
10. The API exposes catalog + connection lifecycle only (`GET /api/integrations…`, connect with explicit scopes, disable/enable, status-check, disconnect). No route accepts or returns credential material; unknown scopes and foreign connections are rejected with typed 400/404s.
11. The web Integrations page renders safe views only: scopes with risk levels, tool confirmation requirements, and connection status as text (never color-only). Connect flows offer only DECLARED scopes, actions are honest (server rejections surface as typed errors, never fabricated success), and no credential material exists anywhere in web source (test-enforced).
12. `connectors/integration-mocks` is deterministic and offline: no host code, no network, and no isolation claims. Real vendor integrations (GitHub today) register explicit hand-written definitions — never generic derivations from connector metadata — and keep their own transport rules (Step 10 §5g unchanged).

## 5j. App generation rules (Step 13, `generation/core`)

1. Planner and repair-source output is UNTRUSTED DATA: every spec and plan is re-validated server-side with strict bounded schemas (safe relative paths, known app types, server-side templates only); malformed, oversized, or secret-shaped input fails closed (`GENERATION_SECRET_REJECTED`, `GENERATION_INVALID_SPEC`, `GENERATION_INVALID_PLAN`) and is never executed, interpreted, or concatenated into prompts.
2. The plan approval and the forced high-risk `sandbox.execute` confirmation are human decisions through the API — the engine never approves itself; a resumed run re-submits the STORED pending input so no client can swap it (Tool System single-use input-bound confirmations, §5 rule set).
3. Every mutation and command flows only through the Tool System (`project.create-directory`, `project.create-file`, `project.update-file`, `project.read-file`, `sandbox.create`, `sandbox.execute`) with explicit minimal server-side grants granted at wiring time — the engine can never grant itself permissions, and registration grants nothing (§5).
4. The run's sandbox id is pinned server-side; sandbox commands follow the full Step 8 sandbox policy (allowlist, no shells, env isolation, resource ceilings), and command output is bounded and secret-scrubbed before entering run state or audit.
5. Hard limits with ceilings (files, commands, repair attempts, duration) terminate runs with typed errors — no unlimited loops, no hangs; cancellation is one-way and terminal.
6. Nested files create parent directories through the Tool System idempotently; a `PATH_CONFLICT` means "already exists" and is reused, never an error, and never a bypass around the file-tree rules (§5e unchanged).
7. Validation is structural (template-required files present and non-empty) and test-command outcomes come from the sandbox — the engine never fabricates success; validation/test failures route through the bounded repair loop and fail honestly with remaining issues listed.
8. Audit events carry phases, tool ids, and typed outcomes — never file content, raw inputs, credentials, or command stdout dumps.
9. API views (`/api/app-generations…`) expose normalized run/plan/result views only: paths and byte sizes, states, bounded warnings. No file-content dumps, no host paths, no chain-of-thought, no secrets; unknown runs 404, terminal-run mutations 409.
10. The shipped planner is the deterministic offline mock (`generation/mock`) — no model credentials in this layer, and wiring an AI-routed planner must reuse the same validation and Tool System gates with zero bypasses.

## 5k. Testing & Debugging Agent rules (Step 14, `testing/core`)

1. The Testing & Debugging Agent has NO second execution pathway: no child processes, no shells, no host filesystem. Every project read (`project.list-files`, `project.read-file`) and every command (`sandbox.create`, `sandbox.execute`) flows only through the Tool System with explicit minimal server-side grants — registration grants nothing, and the run can never grant itself anything (§5, §5e).
2. Command derivation is structural and fail-closed: shell-shaped scripts are rejected outright, only allowlisted bare executables (`node`, `npm`, `npx`, `tsc`, `vitest`) become commands, secret-shaped arguments are rejected, and nothing from a manifest is ever executed during detection — it is parsed JSON only.
3. The plan approval, every repair approval, and every forced `sandbox.execute` confirmation are human decisions through the API — nothing auto-approves, and a resumed run re-submits the STORED pending input so no client can swap it (single-use input-bound confirmations, §5).
4. Sandbox commands follow the full Step 8 sandbox policy (allowlist, no shells, env isolation, resource ceilings); command output is bounded and scrubbed and is UNTRUSTED DATA — classified deterministically into a closed failure vocabulary, never executed or interpreted as instructions.
5. File contents read for diagnosis are UNTRUSTED DATA read through the Tool System, bounded by `maxDebugFiles`; the debug agent's proposals are re-validated server-side with strict schemas (`TESTING_INVALID_DIAGNOSIS`, `TESTING_INVALID_REPAIR_PLAN`), and an invalid or declined diagnosis fails honestly — the agent NEVER executes anything itself.
6. Repairs apply only through the existing Coding Agent (`§5f`) on the SAME Tool System instance, behind its own plan approval and revision discipline; rejecting a repair cancels the coding run and fails `TESTING_REPAIR_REJECTED`; revision conflicts fail `TESTING_REVISION_CONFLICT` — no blind retries.
7. Hard limits with ceilings (`maxRepairAttempts`, `maxCommands`, `maxDebugFiles`, `maxCommandTimeoutMs`) terminate runs with typed errors; cancellation is one-way and terminal.
8. Audit events carry phases, states, tool ids, and typed outcomes — never file contents, raw command output dumps, credentials, or chain-of-thought.
9. API views (`/api/testing/runs…`) expose the normalized `TestRunView` only: bounded plan command summaries (labels, purposes, executables, arguments — never file contents), pass results, structured diagnosis/repair views, pending approval metadata, typed failures, notes. No secrets, no host paths, no chain-of-thought; unknown runs 404, terminal-run mutations 409.
10. The shipped debug agent is the deterministic offline mock (`testing/mock`) — no model credentials in this layer, and an AI-routed DebugAgent must reuse the same validation and Tool System gates with zero bypasses.

## 5l. Project memory rules (Step 15, `memory/core` + `apps/api`)

1. Memory is REFERENCE DATA, never instructions: the Memory Context Builder is the only path into an agent run, and it wraps entries in a labeled block that declares itself UNTRUSTED reference data — the same boundary as tool results (§5c).
2. Humans own the store: user-typed memory is created `active`; every AI-extracted candidate lands as a NON-AUTHORITATIVE `candidate` and only an explicit human approve promotes it — nothing auto-promotes, and rejected candidates never re-enter context.
3. Secret-shaped content is rejected at EVERY write surface (create, update, candidate, extraction products re-validated by the same manager rules); secret-shaped search text is rejected too.
4. Hard limits are enforced server-side: capacity per project with a ceiling, bounded content and titles, bounded queries, bounded context entries and characters — nothing is negotiable at runtime.
5. Extraction reads only the SAFE run views, maps only narrow structural facts (spec name/app type/template/test command; project type/framework/runtime plus FACT-only diagnosis statements), rejects non-completed runs, and rejects runs that belong to another project — raw command output, generated file content, inference, and recommendations never become memory.
6. Context injection is server-derived only: the API searches ACTIVE memories of the validated project association and passes one bounded string; the browser never supplies or shapes memory content. Memory is an enhancement, never a gate — a memory failure can never fail an otherwise valid run.
7. API responses are safe normalized views (id, fields, provenance, statuses, revision, timestamps); typed scrubbed errors map to exact HTTP codes; the audit trail records lifecycle events WITHOUT memory content.

## 5m. Codebase intelligence rules (Step 16, `codebase/core` + `apps/api`)

1. Indexes are METADATA, never content: a build reads source through the `CodebaseSourceProvider` port (a read of already-authorized project files), keeps only symbols, relationships, statuses, and bounded evidence, and retains no file contents, symbol bodies, or values — the same reference-data boundary as memory (§5l) and tool results (§5c).
2. Secret-shaped values are never read into the index, never stored, never shown: suspicious files are flagged by path only (`parseStatus` + `flaggedSecrets`), and evidence text is scrubbed so credential-shaped characters cannot ride along in search or trace output.
3. All limits are enforced server-side with hard ceilings (indexed files, symbols per file and total, relationships, per-file bytes, build duration, search results, trace depth/nodes); every truncated response says so honestly.
4. Analysis is evidence-backed: search results, references, and feature traces carry file paths and short scrubbed evidence lines; parse failures surface as honest per-file `failed`/`unsupported` statuses, never silent skips.
5. Agents reach codebase knowledge ONLY through the eight read-only Tool System tools (`codebase.*`, permission `codebase.read`); there is no direct path around the Tool System and no analysis tool mutates anything.
6. Memory candidates from a completed index are NON-AUTHORITATIVE `candidate` records under the Step 15 human-approval rules (§5l): only bounded structural facts are extracted, provenance is `system_derived` with the index id, and nothing auto-promotes.
7. API responses are safe normalized views (paths, counts, statuses, bounded evidence — never content); typed scrubbed errors map to exact HTTP codes; unknown projects/workspaces 404 before any source read.

## 5n. Preview / app runtime rules (Step 17, `runtime/core` + `apps/api`)

1. The plan is DETECTED from workspace evidence (manifest scripts, frameworks, present files, codebase index) and validated server-side — the browser never supplies commands, ports, limits, or environment values, and the strict API schema rejects command-shaped payloads with a 400.
2. The RuntimeExecutor seam is the ONLY execution path: `runtime/core` and `runtime/mock` contain no process spawning, shells, or host filesystem access, and the API server is NEVER the runtime — a production executor (container / microVM / dedicated worker) must implement the same interface with the same gates.
3. The shipped executor is the deterministic simulated mock, honestly labeled everywhere (API views, UI copy, preview page, and a project-memory candidate); it claims NO OS-level isolation, and `enforcement` reports what is and is not enforced.
4. Environment validation rejects secret-shaped keys AND secret-shaped values (`RUNTIME_ENV_REJECTED`); runtime records never carry credentials, host paths, or token-like material anywhere.
5. Revision binding is strict: a runtime is pinned to the workspace revision it was created from; advancing the workspace marks it `stale` (honest, never silently rebased), starting a stale runtime fails `RUNTIME_REVISION_MISMATCH` (409), and restart always builds at the LATEST revision.
6. Lifecycle discipline: validated state-machine transitions only (illegal transitions 409, terminal statuses never resume), cancellation is one-way, idle + lifetime deadlines expire runtimes through a sweep, and hard ceilings bound active runtimes globally and per workspace (429).
7. Failures are structured reports (kind + phase + message) from a closed vocabulary — no silent 500s or "unknown error" placeholders; health checks are bounded (max checks, never a poll loop).
8. Logs are bounded (byte budget + entry count) and scrubbed: control characters stripped, credential-shaped output redacted, oversized lines truncated with an honest marker; runtime logs are UNTRUSTED DISPLAY DATA, never executed.
9. The preview page is served ONLY through the platform-controlled `/preview/:runtimeId` URL with sandboxing headers (`nosniff`, `no-store`); the executor decides what renders, project names are escaped, and the page never embeds host paths.
10. Runtime memory candidates are NON-AUTHORITATIVE `candidate` records under the Step 15 human-approval rules (§5l), provenance-tagged `system_derived` with the runtime id — nothing auto-promotes, and the simulated-isolation limitation itself is recorded so it can never be forgotten.

## 5o. Version control rules (Step 18, `version-control/core` + `apps/api`)

1. Revisions are immutable and append-only: nothing rewrites, reorders, or deletes history; every record (including rollbacks) is a new revision with full lineage.
2. A rollback is a two-phase operation that PAUSES for a human confirmation bound to the exact stored input; the restore itself executes only through the validated step machine (one step at a time, resumable, cancellable), writes the tree through the normal file-tree operations, and appends a `rollback`-source revision.
3. Rollback runs at critical risk through the Tool System — forced human confirmation, no self-approval, no bypass path; the API can OPEN an operation but only the decision endpoint can execute it, and an expired or already-decided confirmation fails closed.
4. Optimistic-concurrency guard: every restore carries `expectedCurrentRevision`; a tree that changed underneath fails `VERSION_REVISION_CONFLICT` (409) instead of racing.
5. Snapshots are content-addressed and integrity-verified on read: a corrupt or tampered store fails closed (`VERSION_SNAPSHOT_CORRUPT`) — never silently degrades.
6. Diffs are bounded (file ceilings, line ceilings, per-file kinds) and served as safe normalized views; the API never returns unbounded content dumps.
7. Checkpoint markers are advisory references: deleting one never deletes a revision, snapshot, or file; retention evicts only the OLDEST markers beyond the cap, never markers pinned by open operations.
8. The retention sweep refuses to violate its guarantees (`VERSION_RETENTION_VIOLATION`) instead of silently breaking them, and counts protected revisions before evicting.
9. Route-level auto-captures (coding/generation/testing brackets) are BEST-EFFORT observability: a capture failure is audit-recorded and never fails the run it brackets.
10. All capture/restore/checkpoint/retention events land in the scrubbed audit trail; errors are typed and scrubbed (`VERSION_*`), and API responses are safe normalized views only.

## 7. Incident response

- Suspected secret leak → rotate first, investigate second.
- Report security issues privately to the repository owner; do not open public issues for vulnerabilities.
