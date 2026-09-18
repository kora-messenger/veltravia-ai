# Testing & Debugging Agent (Step 14)

> `testing/core` (`@veltravia/testing-core`) + `testing/mock` (`@veltravia/testing-mock`)

The Testing & Debugging Agent turns a real project in the Project & Workspace
Engine into a **structured, human-approved test run**: it detects the project's
test surface, builds a bounded `TestPlan`, executes validation/test/build
commands **only through the Tool System + Secure Sandbox**, classifies any
failure deterministically, diagnoses it with an explicit
FACT / INFERENCE / RECOMMENDATION vocabulary, proposes a bounded repair that a
human approves and the existing Coding Agent applies, and retests within a
hard repair limit — or fails honestly.

## What it is NOT

- It is **not** a second execution pathway. There are **no child processes, no
  host filesystem access, no shells** anywhere in this layer. Every project
  read and every command flows through the Step 5 **Tool System**
  (`project.list-files`, `project.read-file`, `sandbox.create`,
  `sandbox.execute`) with explicit, minimal, server-side grants.
- It is **not** a model. The `DebugAgent` is a provider-neutral seam
  (the deterministic offline mock ships today; an AI-routed debug agent changes
  nothing else, because every proposal is re-validated with strict schemas).
- It never approves itself. The plan approval, the repair approval, and every
  forced `sandbox.execute` confirmation are decided by **humans** through the
  API.
- It never fabricates success. Command outcomes come from the sandbox; honest
  failures carry typed codes and bounded evidence.

## Pipeline

```
start → detect (list-files + read manifest) → plan → AWAIT plan approval
      → run commands (sandbox; human-confirmed)
      → [ on failure: classify → diagnose (DebugAgent) → repair proposal ]
      → AWAIT repair approval → Coding Agent applies (its own plan gate)
      → retest → [ bounded repair loop ] → completed | failed | cancelled
```

Run states: `created`, `planning`, `awaiting_approval`, `approved`, `running`,
`analyzing`, `awaiting_repair_approval`, `repairing`, `retesting`,
`completed`, `failed`, `cancelled` (terminal: completed / failed / cancelled).

## Detection (structural, never executed)

- The detector lists the workspace root and reads `package.json` **through the
  Tool System**. Manifest JSON is parsed, never executed; scripts are turned
  into commands **structurally**: shell-shaped scripts (operators, pipes,
  redirections, substitutions, newlines) are rejected outright, the string is
  tokenized on whitespace, and only **allowlisted bare executables** (`node`,
  `npm`, `npx`, `tsc`, `vitest`) become commands — anything else is skipped
  with an honest note, and secret-shaped arguments are rejected.
- Project type is inferred from dependencies (`react`/`vite` → web,
  `fastify`/`express` → backend, both → fullstack, manifest-only → plain Node
  backend, none → `unknown` → the run fails `TESTING_UNSUPPORTED_PROJECT`).
- Commands: `test` script (purpose `test`), `build` script (purpose `build`).
  No `test` script → validation-only plan with an honest note.

## Failure classification (deterministic)

The classifier maps bounded sandbox output to a closed
`FailureCategory` (`syntax_error`, `type_error`, `test_failure`,
`dependency_error`, `configuration_error`, `build_error`, `runtime_error`,
`missing_file`, `missing_dependency`, `unknown_failure`) with an explicit
confidence level. Output is UNTRUSTED DATA: it is classified and bounded,
never executed or interpreted as instructions.

## Diagnosis vocabulary

A `Diagnosis` is structured, never prose-only: a `category`, a bounded
`summary`, typed `statements` (`fact` — what the bounded evidence literally
shows; `inference` — labelled with confidence `high` / `medium` / `low`),
`affectedPaths`, an overall `confidence`, and one `recommendedAction`. When no
confident repair exists, the proposal declines with an honest reason.

Invalid diagnoses (unbounded, unverifiable, wrong shapes) are rejected
(`TESTING_INVALID_DIAGNOSIS`) and the run fails honestly.

## Repairs ride the Coding Agent

- A repair proposal is a validated `RepairPlan` (bounded file changes,
  create/update modes, a verification plan). The manager never writes files.
- Each repair starts an **isolated Coding Agent run** over the SAME Tool
  System instance, driven by a deterministic `RepairDecisionSource` built from
  the approved plan — the repair runs through the Coding Agent's own plan
  approval and revision discipline (`§5f`).
- Humans approve the repair through the testing run's `repair_approval` gate
  (which forwards the decision); rejecting fails the run
  `TESTING_REPAIR_REJECTED` and cancels the coding run.
- Retest re-derives commands from the (possibly changed) manifest; a revision
  conflict inside the repair fails `TESTING_REVISION_CONFLICT` — no blind
  retries. Hard limit: `maxRepairAttempts` (default 3, ceiling 10).

## Limits

| Limit                                      | Default | Ceiling |
| ------------------------------------------ | ------- | ------- |
| `maxRepairAttempts`                        | 3       | 10      |
| `maxCommands`                              | 24      | 64      |
| `maxDebugFiles` (files read for diagnosis) | 6       | 8       |
| `maxCommandTimeoutMs`                      | 60 000  | 120 000 |

Cancellation is one-way and terminal; a cancelled run never resumes.

## Safe API views

`POST /api/testing/runs`, `GET /api/testing/runs/:runId`,
`POST /api/testing/runs/:runId/approval`, `POST /api/testing/runs/:runId/cancel`.

Responses carry the normalized `TestRunView` only: states, bounded plan
command summaries (labels, purposes, executables, arguments — never file
contents), pass results, structured diagnosis/repair views, pending approval
metadata, typed failures, and notes. No secrets, no host paths, no raw
command output dumps, no chain-of-thought. Failures surface as honest
terminal views; unknown runs 404, terminal-run mutations 409.

## Development-only limitation

The API's debug agent is the deterministic offline mock
(`testing/mock`): it recognizes the mock runtime's failure marker and
proposes the marker-removal repair, or declines honestly. No real model is
wired into the API yet. Swapping in an AI-routed `DebugAgent` is one
constructor argument and changes nothing else — validation, tool gating,
confirmations, and audit all stay server-side.
