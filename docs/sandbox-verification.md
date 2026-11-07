# Sandbox test execution and evidence-based verification (Step 45)

A worker that says "tests pass" used to be believed. This step makes that claim
checkable: the server discovers what the project can actually verify, runs it in
a sandbox, stores what the process produced, and refuses to accept a worker's
report unless a stored run backs it.

## What is real

- **Discovery from the project itself** (`@veltravia/verification-core`). Operations are
  resolved from `package.json` scripts, lockfiles, framework config files, `tsconfig`,
  eslint and prettier config. Nothing is guessed from a folder name.
- **An operation allowlist, not a command allowlist.** A caller names an _operation_
  (`unit`, `integration`, `e2e`, `typecheck`, `lint`, `format`, `build`, `deps`). The
  server maps it to the exact argv the project declares. There is no path from a tool
  argument to a shell string: shell interpreters are refused by name, and extra arguments
  are refused.
- **Real execution** (`@veltravia/sandbox-local`). Child processes run with a scrubbed
  environment, an enforced timeout, an output cap and a working directory contained
  inside the run's own snapshot directory.
- **Immutable run records.** Each run stores the revision it ran against, every argv,
  exit code, duration, parsed counts and a bounded output tail. A run that executed
  nothing is recorded as such.
- **Durable storage** (migration 006): `verification_runs` and `verification_results`,
  owner-scoped, with the evidence row kept separate from the run so a report cannot be
  edited into a pass.
- **The review gate.** `POST /api/workers/:workerId/review` with `decision: "accept"`
  refuses (409 `WORKER_REVIEW_REFUSED`) when a claimed `test_run` evidence ref does not
  name a stored run for that worker, or when the stored status contradicts the claim.

## What is not real, and says so

- **No operating-system isolation.** The local runtime provides process containment
  only. Every record carries `providesOsIsolation: false` and an `unenforced` list that
  always includes the network. A report never claims more containment than it has.
- **No runtime configured means no execution.** Without `VELTRAVIA_SANDBOX_RUNTIME=local`
  the capability endpoint reports `runtimeId: null` and a plain `blockedReason`; a run is
  stored with `executed: false` and zero operations. Nothing is simulated into a pass.
- **No repair loop by itself.** A run records whether a further attempt is allowed. The
  agent that decides to repair and re-run is a later step; a worker cannot repair its own
  failure into a success.
- **Counts are parsed best-effort** from known reporters (vitest, jest, mocha, node test,
  pytest, go test, cargo). An unrecognised reporter leaves counts `null` rather than
  inventing numbers.

## Routes

| Route                                                       | Purpose                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/verification/capabilities`                        | Operations, the configured runtime, and what it cannot enforce     |
| `GET /api/verification/projects/:projectId/profile`         | Discovered operations and the exact argv, without running anything |
| `POST /api/verification/runs`                               | Run 1-6 operations against the project's current revision          |
| `GET /api/verification/runs`                                | List runs (filter by project, task, worker, status)                |
| `GET /api/verification/runs/:runId`                         | One run with results and evidence                                  |
| `POST /api/verification/runs/:runId/cancel`                 | Cancel a running run                                               |
| `GET /api/verification/runs/:runId/diagnosis`               | Structured failure diagnosis                                       |
| `GET /api/verification/runs/:runId/compare?against=<runId>` | What changed between two runs                                      |

Ownership is enforced twice: the `:projectId` guard covers the profile route, and a
body-level `projectId` on `POST /runs` is checked against the caller before anything runs.
Another owner's run answers 404, not 403, so ids cannot be probed.

## How a worker uses it

A worker may only call `tests.run` when its assignment names the tool **and** grants
`runTools`. The operations it may ask for come from the assignment's `verification.operations`
(default: `unit`, `integration`, `typecheck`, `lint`, `build`; `e2e`, `format` and `deps` are
opt-in). A request outside that list is refused before anything executes, and at most three
operations may be asked for in one call.

The handler returns the run id as its evidence ref, so the review gate can find the run.
A worker's own summary of the output is never treated as the result: the run record is.

```jsonc
// assignment excerpt
{
  "allowedTools": ["project.read", "tests.run"],
  "permissions": { "readProject": true, "writeProject": false, "runTools": true, "network": false },
  "verification": { "operations": ["unit", "typecheck"] },
  "checkpoints": ["tests run"],
  "cancellationConditions": ["two failed attempts"],
  "reporting": ["the verification run id", "which tests failed"],
}
```

## Configuration

| Variable                          | Meaning                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `VELTRAVIA_SANDBOX_RUNTIME=local` | Enable real process execution for verification                           |
| `VELTRAVIA_VERIFICATION_DIR`      | Where run snapshots are materialised (default: `<tmp>/veltravia-verify`) |

Real process execution is covered by the `@veltravia/sandbox-local` tests, which spawn
actual child processes rather than doubles. The API tests use a scripted executor on purpose,
so they prove the wiring and the honesty of the report without depending on a compiler.
