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

## 6. Repository & supply-chain hygiene

- Minimal dependency surface: no dependency is added speculatively. Every dependency addition goes through review.
- `npm ci` (lockfile-exact installs) everywhere — CI and local — so all environments run identical dependency trees.
- Production builds are built from a clean CI install, never from a developer's local `node_modules`.
- Automated dependency/audit scanning will be added to CI in a later step.

## 7. Incident response

- Suspected secret leak → rotate first, investigate second.
- Report security issues privately to the repository owner; do not open public issues for vulnerabilities.
