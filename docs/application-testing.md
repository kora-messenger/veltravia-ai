# AI application testing (Step 39)

> `testing/core/src/app-testing` (`@veltravia/testing-core`), `apps/api/src/routes/app-testing.ts`,
> `apps/web/src/pages/testing`

An agent that reads a project, works out what it is, proposes tests, runs them
in the sandbox after a person approves, looks for security problems, and writes
a report that says only what was proved.

It builds on the Step 14 testing run. Step 14 owns the run itself (state, plan
approval, sandbox commands, repair loop). Step 39 adds the application-aware
parts around it. Nothing here runs code on its own.

## What it does

| Part             | What it does                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Inspection       | Finds the frontend and backend framework, test runner, databases, API routes, pages, auth and existing tests. |
| Test generation  | Proposes API, unit, form and component tests as files. Proposals only; nothing is written until approved.     |
| Security checks  | Ten static rules (hardcoded secrets, committed `.env`, `eval`, SQL built from strings, open CORS, and so on). |
| Output parsing   | Reads Vitest, Jest, pytest and plain output into pass / fail / skip per test.                                 |
| Failure analysis | Turns a failure into a plain explanation and a suggested fix. Marked suspected or confirmed.                  |
| Report           | One status, the reason for it, counts, tests, problems, and what the environment could prove.                 |
| Repair plan      | A proposed fix. It is applied only through the Coding Agent, after a person approves it.                      |

## How a run goes

1. `POST /api/app-testing/runs` with `{ projectId, workspaceId }`. The run is
   inspected and a plan is proposed. State is `awaiting_approval`.
2. A person approves the plan. Approval goes through the existing
   `POST /api/testing/runs/:runId/approval`, the same route as Step 14.
3. Each sandbox command pauses for its own confirmation.
4. `GET /api/app-testing/runs/:runId/report` returns the report at any point.
   Before approval it says `BLOCKED` and that nothing has run.

Other routes: `GET /runs/:runId` (status), `GET /runs/:runId/tests/:testId`
(one result), `GET /runs/:runId/repair-plan`, `POST /runs/:runId/cancel`.
There is deliberately no route that applies a repair.

## The honesty rule

A report never claims more than was proved.

- On the mock sandbox, which executes no real code, the best status is
  `PARTIALLY_PASSED`, never `PASSED`. The environment block says
  `executedRealCode: false` and the page says so.
- `fullyTested` is false unless real code ran and nothing was skipped for a
  reason that matters. The page shows "This is not a complete test of your
  application." whenever it is false.
- A problem is `confirmed` only when a failing test shows it. Everything the
  static rules find is `suspected`.
- A cancelled run says it was cancelled. It does not borrow a pass.

## Security

- **Ownership.** Every route resolves the caller from `x-veltravia-owner-ref`.
  Another owner's run, project, workspace, report, repair plan, cancel and
  approval all return 404, never 403, so existence is not revealed.
  `testing-ownership.ts` is the single check, including on the older Step 14
  routes, which were previously open.
- **Secrets are never read.** `.env`, key files and other secret-shaped paths
  are listed but their contents are not read. A committed `.env` is reported
  by its path, with the title "contents were not read". Values found in other
  files are redacted before they reach a finding, a bug or a response.
- **Ids must be text.** Numbers, null, objects and arrays are refused with 400.
- **Bounded.** At most 400 files, 200 KB per file, 60 tests, 100 findings.
  A project over the limit is reported as partial, not silently truncated.
- **Test source is not in responses.** Responses carry paths and sizes.

## The page

`#/projects/<id>/testing`, opened from "Open testing" on the project page.
Three regions on a wide screen (found, result, problems), two below 1320px,
switchable panels below 900px. Shows progress, a pass/fail mark per test, the
problems with severity and certainty, the approval card, Cancel while a run is
live and Rerun when it has finished.

## Known gaps

- **No real code runs.** The only sandbox is the mock. Until a container
  runtime exists, no report can reach `PASSED`.
- **No OS isolation.** The mock claims none and the report says so.
- **Static rules are heuristics.** They find patterns, not proven flaws, and
  miss what they have no rule for. "No problems found" covers only what was
  checked.
- **Generated tests are not run in a browser.** Component and end-to-end tests
  are listed as not generated, with the reason.
- **Detection is by file evidence.** An unusual layout can be missed or
  mislabelled; the page shows what was found so a person can see.
- **Repairs need a person and a Coding Agent run.** An approved repair is
  applied by the Coding Agent, then the tests run again (a retest pass). The
  report only reaches `PASSED` if a regression check ran after the repair. The
  number of repair attempts is capped (3 by default, never more than 10), and a repair that hits a stale file
  revision fails honestly instead of overwriting.
- **Runs live in memory.** An API restart loses them.
- **Sign-in is the development stand-in.** The owner header is not real
  authentication.

## Verified

3,703 tests passing. Live: 21 of 21 API checks over HTTP with two owners, 75
of 75 browser checks on desktop, tablet and mobile, 8 of 8 for cancel, reject
and an unreachable API. Live checking found five defects that unit tests did
not (a frozen live view on failure, a lost error message, a squeezed result
column, a committed `.env` never reported, and numeric ids being coerced), all
fixed with tests that fail without the fix.
