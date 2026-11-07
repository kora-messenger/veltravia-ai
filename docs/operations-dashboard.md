# Superagent operations dashboard (Step 47)

One page over what the Primary Agent and its Superagents have already recorded. It reads
the Step 42-46 stores and starts nothing: every control calls a route that existed before
this step, except the diff read added here so a reviewer can see both sides of a proposal.

`#/operations`

## What it shows

| Section              | Source                         | What it answers                                                            |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| Fleet tiles          | `GET /api/workers`             | How many Superagents are running, queued, blocked, awaiting review, failed |
| Superagent table     | `GET /api/workers`             | What each one was asked to do, its status, attempt and elapsed time        |
| Task coordination    | `GET /api/tasks`               | Which task each Superagent belongs to, and which tasks need a review       |
| Change sets          | `GET /api/change-sets`         | What workers have proposed, file counts by operation, verification state   |
| Verification         | `GET /api/verification/runs`   | What ran, what was refused and why, with counts and exit codes             |
| Integration history  | `GET /api/integration/records` | What reached a project, at which revision, and whether it rolled back      |
| Scheduling decisions | `GET /api/scheduler/decisions` | Why the scheduler started some workers and held others                     |

Selecting a Superagent opens its full record: assignment scope and exclusions, allowed
tools, limits, acceptance criteria, deliverables, evidence, usage, review, failure and the
server-written event history. Selecting a change set opens the review pane: validation,
both sides of every file, conflicts, approval and integration.

## The one new read

`GET /api/change-sets/:changeSetId/diff?maxChars=` returns, per file: the operation, both
hashes, the size, the project's content now, the proposed content, `baseStale` and
`contentAvailable`.

- Both sides are clipped to `maxChars` (default 20,000, ceiling 60,000) and `size` still
  reports the real byte count, so a truncated view is visible as truncated.
- `baseStale` is true when the project no longer matches the hash the set was built from.
  The reviewer sees the drift instead of an integration failing later.
- `contentAvailable` is false when the proposal's bytes are no longer stored. The pane says
  so; it never renders a missing artifact as an empty file.

## Controls, and what they cannot do

| Control                            | Route                             | Refusal                                                                          |
| ---------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| Cancel                             | `POST /api/workers/:id/cancel`    | Offered only for statuses the server accepts; confirmed in a dialog              |
| Re-queue                           | `POST /api/workers/:id/requeue`   | Offered for failed, timed-out and cancelled workers                              |
| Accept / request revision / reject | `POST /api/workers/:id/review`    | The server may answer `409 WORKER_REVIEW_REFUSED`; its message is shown verbatim |
| Analyse conflicts                  | `POST /api/change-sets/analyze`   | Conflicts block approval in the interface because the server blocks integration  |
| Approve / reject                   | `POST /api/integration/approvals` | Refused when validation fails or conflicts exist                                 |
| Integrate                          | `POST /api/integration/run`       | Needs the approval id from this session, so the gate cannot be skipped           |

Nothing is retried automatically after a refusal. A rejected review leaves the worker
awaiting review, and the pane keeps its state.

## Honest states

- **Loading, empty, error, stale.** The first read shows a spinner; each panel has an empty
  state that explains why it is empty; a failed first read offers a retry; a failed refresh
  keeps the last known figures and says they may be out of date.
- **Polling, not streaming.** The header says "Refreshes every 5s" and counts from the last
  successful read. There is no push stream for worker, task or integration records, so the
  page never claims to be live. Refreshing pauses while the tab is hidden and can be paused
  by hand.
- **Verification never over-claims.** A run is green only when a command actually executed
  and reported counts. No executed command reads "Nothing ran" with the server's reason; a
  green run that reported no test counts reads as build-or-lint only.
- **Usage is not spend.** Tokens and calls are shown with their provenance: a real provider
  call, or a simulated executor marked "not billed". No price table ships, so no cost is
  shown.
- **Notifications are for decisions.** Failures, blocks, review readiness, conflicts,
  verification failures and task completion are announced once each; routine progress is
  not.

## What is not here

- No project or file editing, no starting workers, no creating tasks. Those stay with the
  chat and the Primary Agent.
- No live event stream: the page polls the stores.
- No authentication beyond the owner header the whole API uses in this build.
- Rollback is implemented in the API (`POST /api/integration/records/:id/rollback`) but not
  offered here yet, because it needs the same confirmation weight as a merge and its own
  review of what would be reverted.

## Tests

- `apps/web/src/pages/operations/OperationsPage.test.tsx` - loading, empty, error and retry,
  filtered fleet, usage provenance, verification honesty, change-set review with both sides,
  conflicts blocking approval, a refused review surfaced verbatim, and the cancel dialog.
- `apps/web/src/pages/operations/status.test.ts` - status grouping, control eligibility,
  verification summaries, usage provenance, notification de-duplication.
- `apps/api/src/change-integration.test.ts` - the diff route: both sides, stale detection,
  cross-owner 404, character ceiling.
