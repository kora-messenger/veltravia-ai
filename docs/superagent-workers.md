# Superagent workers: bounded execution and safe parallel scheduling (Step 43)

Veltravia has one assistant. This step adds workers underneath it, and the
word "underneath" is the whole design: a worker is a bounded errand with a
written assignment, a tool list, a time budget and a review gate. It never
speaks to the user, never widens its own permissions, and never decides that its
work is finished.

## What is real, and what is simulated

| Piece                                                             | Status                        |
| ----------------------------------------------------------------- | ----------------------------- |
| Assignment contracts and validation                               | Implemented                   |
| Resource-conflict detection                                       | Implemented                   |
| Scheduler, concurrency limit, recorded decisions                  | Implemented                   |
| Worker lifecycle and transitions                                  | Implemented                   |
| Timeouts, cancellation, crash capture, bounded retry with backoff | Implemented                   |
| Primary Agent review gate                                         | Implemented                   |
| PostgreSQL worker, event and decision records                     | Implemented                   |
| Restart visibility across API instances                           | Implemented and tested        |
| **The work a worker performs**                                    | **Simulated**                 |
| Automatic recovery guarantees                                     | Not claimed                   |
| Conflict-safe merging of two workers' edits                       | Not implemented               |
| Task management UI                                                | Not built (progress API only) |

The shipped executor is `SimulatedExecutor`. It produces deterministic
deliverables and evidence, reports progress, honours cancellation and can be
made to time out, so the machinery around it is exercised for real. Every API
response that depends on it says `"simulated": true`. No model is called and no
code is written.

## The Primary Agent, after this step

The contract from Step 42 is unchanged. The Primary Agent still owns the
conversation, understanding, planning, decomposition, the decision to delegate,
the assignment, dependency coordination, monitoring, review, integration and
the final answer. What Step 43 adds is where those responsibilities land:

- **Delegation decision.** `Scheduler.plan` selects only work that is genuinely
  independent: the task must be open, its dependencies complete, its assignment
  valid, no other live worker on that task, no overlapping write claim, and a
  free slot under the owner's concurrency limit. Everything else is skipped with
  a recorded reason (`dependency_unmet`, `ambiguous_scope`, `already_working`,
  `resource_conflict`, `retry_backoff`, `limit_reached`, `task_closed`).
- **Monitoring.** `GET /api/tasks/:taskId/superagents` reports the parent task
  status, active workers with their status and claims, deliverables, blocked
  work, failed attempts, workers awaiting review and the review status. Reads are
  what a future task screen would use; no screen is built here.
- **Recovery.** A worker whose heartbeat stops is marked `timed_out` by
  `POST /api/workers/recover` (also applied when the scheduler plans), with the
  attempt closed and the reason recorded. Nothing auto-resumes: a person or the
  Primary Agent decides whether to re-queue.

## The worker

A worker record carries: unique id, type (`frontend`, `backend`, `database`,
`testing`, `documentation`, `analysis`, `general`), the assigned task, the
parent task, the Primary Agent run that delegated it, the owner, the task's
project scope, the full assignment, the claims it holds, its status, attempts,
its result and evidence, the review, and failure details.

Lifecycle:

```
queued → assigned → starting → running → awaiting_review → completed
                        ↓           ↓            ↓
                     failed      blocked      failed
                                  ↑
                   queued ← retry (bounded, backoff)
                   cancelled, timed_out (terminal unless re-queued)
```

`completed` is reachable only from `awaiting_review`, and only `review` writes
it. A worker has no route that sets its own status to `completed`.

## The assignment contract

Rejected with `422` unless it has: an objective; at least one scope path; an
explicit exclusion list (and at least one exclusion when it may write); at least
one deliverable whose path sits inside the scope; acceptance criteria; allowed
tools drawn from the published catalog; permissions that do not exceed the
declared tools (network access requires the network tool); limits inside the
platform ceiling (duration, tool calls, deliverables); dependencies that exist;
at least one checkpoint when it may write; cancellation conditions; and
reporting requirements. Text that looks like a credential is refused.

## Scheduling rules

- One live worker per task, enforced by the API and by a partial unique index in
  PostgreSQL, so two instances racing cannot both start one.
- Two workers may not hold overlapping write claims. Claims come from the
  assignment's scope paths and deliverable paths; prefix overlap counts as a
  conflict, because `src/api` and `src/api/handlers` are the same directory.
- The concurrency limit defaults to 2 and is clamped to 1..4 per request.
- Dependent work waits: only completed dependencies satisfy a dependency.
- A retried worker is not eligible until its backoff elapses.
- Every plan is recorded with what was selected, what was skipped and why.

## Security boundaries

- A worker inherits the task's owner and project. There is no second owner model
  and no worker-level bypass.
- Another owner's task, worker or progress report answers `404`, identically to a
  missing one.
- A worker cannot change its assignment, add tools, raise its limits or extend
  its scope. Re-delegation is a new record.
- Deliverables and evidence outside the declared scope block review.
- Review summaries and worker text are scanned for secret-shaped content.
- Tokens, keys and chain-of-thought are never stored in worker records or logs.
- The sandbox is unchanged. Nothing in this step executes generated code, and no
  OS-level isolation is claimed beyond what earlier steps verified.

## Review and integration

`POST /api/workers/:workerId/review` takes the Primary Agent's decision, its
per-criterion verdicts, and optionally the paths the project actually changed.
The checks are structural and recorded: result present, required deliverables
present, deliverable paths in scope, no changes outside the assignment, no
overlap with already-integrated work, evidence present, no failing evidence, one
verdict per criterion, every criterion satisfied.

An explicit `accept` is refused with `409` when any blocking check fails, and
nothing is written. `reject` records the decision and moves the worker to
`failed` with a retryable flag. Acceptance completes the worker and then calls
Step 42's task review, which is still the only path to a completed task.

## Failure handling

| Failure                     | Behaviour                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Executor exceeds its budget | Aborted, `timed_out`, attempt closed                                                                      |
| Executor throws             | `failed`, code `WORKER_CRASHED`                                                                           |
| No result returned          | `failed`                                                                                                  |
| Cancelled by the owner      | Aborted cooperatively, `cancelled`, task cancelled                                                        |
| Heartbeat stops             | `timed_out` on recovery, reason recorded                                                                  |
| Review rejected             | `failed`, retryable while attempts remain                                                                 |
| Retry                       | `requeue` only from `failed`/`timed_out`, up to 3 attempts, doubling backoff (5s → 40s, capped at 10 min) |

Retries are never unlimited and never automatic.

## Limitations that remain

- The executor is a simulation. Parallel _scheduling and execution machinery_ is
  real and tested; parallel _work_ is not.
- Execution is in-process. A worker running when its API instance dies is
  recovered as timed out, not resumed.
- No conflict-safe merging: overlapping claims are prevented, not reconciled.
- No UI; the progress endpoint is the foundation.
- No model-driven worker decisions; phase and deliverable content is scripted by
  the executor.
