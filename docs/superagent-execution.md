# Model-powered Superagent execution (Step 44)

A Superagent is a bounded worker that thinks with a real model. It is not a second
agent architecture: the Primary Agent still plans, monitors, reviews and delivers,
and everything a worker does arrives through the Step 42 task door and the Step 43
worker lifecycle.

## Simulated versus real

|                                | Simulated executor                                   | Model executor                                        |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------- |
| Where                          | `SimulatedExecutor` in `@veltravia/worker-core`      | `ModelWorkerExecutor` in `@veltravia/superagent-core` |
| Thinks                         | No. It returns fixed text.                           | Yes, through the AI gateway.                          |
| Touches files                  | Never                                                | Only through assigned tools, inside its scope         |
| `simulated` flag on the result | `true`                                               | `false`                                               |
| Chosen when                    | `VELTRAVIA_WORKER_EXECUTOR=simulated` (tests, demos) | default                                               |

The default is the real executor. If no provider is connected for the owner, a worker
fails with `WORKER_PROVIDER_UNAVAILABLE`; it never falls back to a simulation and
calls it done. Every worker result carries `usage` (`providerId`, `modelId`,
`modelCalls`, `toolCalls`, `inputTokens`, `outputTokens`, `live`), so a review can
tell a real run from a cheap one at a glance.

## Worker types

`frontend`, `backend`, `database`, `testing`, `documentation`, `analysis`, `ui`,
`security`, `research`, `review`, `performance`, `general`.

A type sets three things and nothing else: the instruction the model gets, the tools
suggested for that kind of work, and the answer shape expected. The Primary Agent
picks the type when it writes the assignment.

## Provider selection

Providers are not re-implemented. The executor calls the existing gateway
(`AIProviderGateway.generate`), so credentials stay in the encrypted vault, the
router chooses the model by task category, and daily ceilings apply. `VELTRAVIA_WORKER_MODEL`
pins one model for deployments whose router choice returns no text.

## The loop

1. Build a prompt from the assignment: objective, scope, exclusions, deliverables,
   acceptance criteria, allowed tools, limits, plus a few files from the scope.
2. Ask the model. It must answer one JSON object: `{"action": {...}}` or `{"final": {...}}`.
3. Authorise the action on the server: known tool, named in the assignment, permission
   granted, every path inside scope and outside exclusions.
4. Run it, feed the result back, charge the budget.
5. On `final`, verify the claims: a deliverable outside scope is dropped, a claimed
   file that was never written is not a deliverable, and a "completed" with nothing
   produced is sent back once for the actual work.

A model that wanders off protocol is corrected, then cut off.

## Tool permissions

| Tool                                                                  | Permission | Mutating            |
| --------------------------------------------------------------------- | ---------- | ------------------- |
| `project.list`, `project.read`, `project.search`, `project.structure` | read       | no                  |
| `project.write`, `docs.write`                                         | write      | yes                 |
| `tests.run`                                                           | test       | no                  |
| `schema.inspect`                                                      | read       | no                  |
| `performance.inspect`                                                 | read       | no (no handler yet) |

Refusals are recorded as evidence (`ref: "refusals"`) and returned to the model as an
error, so a worker cannot quietly escalate. Every write is listed in `changedPaths`.

## Sandbox boundaries

Tools are implemented over the project engine the coding agent already uses. No
generated code is executed in the API process, there is no shell, no host filesystem
and no production write. `tests.run` currently refuses (`WORKER_TOOL_UNAVAILABLE`)
because no sandbox runner is attached to workers yet; a worker therefore cannot claim
a test result it did not produce.

## Resource limits

Per worker, enforced in `governance.ts`: model calls (default 6, ceiling 12), tool
calls (default 40, ceiling 60), tokens (default 24k, ceiling 60k), tool output bytes
(default 160k, ceiling 400k), plus the runner's duration limit and Step 43's bounded
retries with backoff. A model cannot raise its own budget, and a worker cannot create
workers; only the Primary Agent's orchestration path can.

## Secrets

Prompts are scrubbed before they leave the process (keys, bearer tokens, database
URLs, `*_SECRET`/`*_API_KEY` assignments), context is capped and truncated, and
provider credentials never enter a prompt, event, log or result. Worker records store
provider and model identifiers and token counts, never a key.

## Progress events and failure handling

Progress rows are written through the existing Step 36/43 reporting path: model request
initiated, model response received, tool requested, tool ran or was refused, answer
rejected, completion claimed without work. No chain-of-thought is stored or shown.

Provider outages, 429s, quota exhaustion, unusable answers, tool failures, refusals,
timeouts and cancellation all surface as worker failures with a code, and partial work
is kept: a worker that wrote files but never produced a final report comes back
`partial` for review.

## Verification

Deterministic: `orchestration/superagent/src/executor.test.ts` (18) and
`apps/api/src/worker-execution.test.ts` (8) run with a scripted provider, so CI needs
no network.

Live, opt-in: `apps/api/src/worker-live.test.ts` runs only with
`VELTRAVIA_LIVE_WORKER=1`, a provider key and `VELTRAVIA_CREDENTIAL_KEY`. It proves the
whole chain (credential, gateway, model turn, authorised tool, written file, usage).

## Known limitations

- Workers run one at a time per assignment; parallelism is Step 43's scheduler, and
  competing changes are still not merged automatically. The Primary Agent integrates.
- `tests.run`, `schema.inspect` depth and `performance.inspect` are partial: no sandbox
  runner, so no test execution from a worker.
- No worker UI; progress is visible as worker events.
- The owner header is still a development stand-in for authentication.
