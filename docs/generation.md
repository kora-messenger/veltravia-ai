# App Generation Engine (Step 13)

> `generation/core` (`@veltravia/generation-core`) + `generation/mock` (`@veltravia/generation-mock`)

The App Generation Engine turns a natural-language **idea** into a real, validated
application project inside the Project & Workspace Engine. It is the first
idea-to-app surface: a bounded, state-machine-driven pipeline that plans, asks a
human to approve the plan, generates files, validates, executes the project's
commands in a sandbox, and repairs honest failures — or fails honestly when it
cannot.

## What it is NOT

- It is **not** a model. The engine is orchestration: the planner that turns an
  idea into a spec + plan is a provider-neutral `GenerationPlanner` interface
  (the deterministic offline mock ships today; an AI-routed planner changes
  nothing else, because every planner output is re-validated with the same
  strict schemas).
- It is **not** a shell around the filesystem. Every file mutation and every
  command flows through the Step 5 **Tool System** (`project.create-directory`,
  `project.create-file`, `project.update-file`, `project.read-file`,
  `sandbox.create`, `sandbox.execute`), which enforces schemas, explicit
  server-side grants, risk-based confirmations, and audit.
- It never approves itself. The plan approval and the forced `sandbox.execute`
  confirmation are decided by **humans** through the API.

## Pipeline

```
idea → validate → plan → AWAIT plan approval → generate (Tool System)
     → validate → commands (sandbox; human-confirmed)
     → [ repair loop on validation/test failures ]
     → completed | failed (honest typed failure) | cancelled
```

- **Specs are validated, not trusted.** The planner's output is parsed into a
  strict `AppSpecification` (bounded fields, safe paths, known app types,
  server-side templates only). A malformed or oversized spec never runs.
- **Plans are bounded views.** The `GenerationPlan` declares files to create and
  modify (paths + bytes, never content dumps), dependencies, commands, and the
  risk summary (which tools force confirmations). Humans approve THIS view.
- **Nested files build their parents through the Tool System.** Each missing
  ancestor directory is created via `project.create-directory`; an existing
  directory (`PATH_CONFLICT`) is reused idempotently — never an error.
- **Validation runs after generation.** Template-required files must exist and
  non-empty; a failure routes through the bounded repair loop.
- **Commands run in the sandbox.** The run pins its sandbox id server-side; the
  forced high-risk `sandbox.execute` confirmation pauses the run for a human,
  and a resumed run re-submits the STORED input — a browser can never swap it.
- **The repair loop is bounded.** A `RepairSource` proposes fixes for validation
  or command failures (still Tool System-gated); a source that proposes nothing
  fails the run honestly (`GENERATION_PLANNER_ERROR` / typed limit codes).
  There is no infinite retry.
- **Limits have hard ceilings.** File writes, commands, repair attempts, and
  total duration are capped server-side; a run that hits a ceiling terminates
  with a typed error, never a hang.
- **Cancellation is one-way.** A cancelled run never resumes; every later
  operation on it fails `GENERATION_RUN_TERMINAL`.

## Trust boundaries

- Planner and repair output is **UNTRUSTED DATA**: validated, bounded,
  secret-shaped values rejected (`GENERATION_SECRET_REJECTED`), never treated
  as instructions or authority.
- Sandbox command output is bounded and secret-scrubbed before it enters run
  state or audit.
- Audit events carry phases, tool ids, and outcome codes — never file content,
  raw inputs, or secrets.
- API views (`/api/app-generations…`) expose exactly the normalized run, plan,
  and result views: paths and sizes, states, bounded warnings and remaining
  issues. No file content, no host paths, no chain-of-thought.

## Mock packages

`generation/mock` ships the deterministic offline planner (`DeterministicPlanner`,
fixed clock injectable for reproducible specs/plans), a declining repair source
(fail-honest), and the built-in server-side templates (`web-react`, `api-node`,
`cli-ts`).

## Development-only limitation

The API's generation manager runs the deterministic mock planner — no real
model is wired into `/api/app-generations` yet. The orchestration, gates,
confirmations, limits, audit, and failure modes are fully real; swapping the
planner for an AI-routed implementation is a one-line change in
`apps/api/src/generation.ts`.

## Step boundary

Nothing in this step adds a new trust boundary: the engine composes the
existing Tool System, Project Engine, and Sandbox rules under human decisions.
Step 14 is **not started** — it begins only with explicit go-ahead.
