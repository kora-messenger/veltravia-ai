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

## 4. Self-development requires controlled testing and approval

- The future self-development system (the platform proposing improvements to itself) must follow a fixed pipeline: **propose → test → review → approve → deploy**.
- Every self-proposed change runs through the same CI as human changes — lint, tests, build — plus additional review gates.
- A human approval step is **mandatory** before any self-proposed change reaches production. No autonomous deployment of self-modifications.
- All self-development attempts are recorded in an append-only audit log (what was proposed, what was tested, who approved, what was deployed).

## 5. Connector credentials are isolated

- Connector credentials (Slack, GitHub, Google, …) are held by `connectors/core/` and stored in the secret manager — never in generated project code, never in AI prompts, and never exposed to code the AI generates.
- When a user's generated project needs a connector capability, it talks to the Veltravia API, which performs the connector call on its behalf. The credential never crosses the boundary.
- Connector scopes follow least-privilege: each connector requests only the scopes it needs.

## 6. Repository & supply-chain hygiene

- Minimal dependency surface: no dependency is added speculatively. Every dependency addition goes through review.
- `npm ci` (lockfile-exact installs) everywhere — CI and local — so all environments run identical dependency trees.
- Production builds are built from a clean CI install, never from a developer's local `node_modules`.
- Automated dependency/audit scanning will be added to CI in a later step.

## 7. Incident response

- Suspected secret leak → rotate first, investigate second.
- Report security issues privately to the repository owner; do not open public issues for vulnerabilities.
