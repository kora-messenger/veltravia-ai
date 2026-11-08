# Autonomous execution and delivery (Step 50)

One natural-language request goes in, a plan comes out, the plan is executed by the
worker engine, and the result is reported from records rather than from anyone's
optimism. Package: `@veltravia/execution-core`. Routes: `/api/executions`.
UI: the Executions region of `#/operations`.

## What actually happens

1. **Intake.** `POST /api/executions { projectId, request }`. The request must be at
   least 8 characters, and the project must belong to the caller: an unknown project
   and another owner's project both answer `404 EXECUTION_PROJECT_UNAVAILABLE`, so the
   route never confirms that someone else's project exists.
2. **Planning.** The planner reads the project's real file list (no model call) and
   produces tasks with a key, worker type, scope, dependencies, acceptance criteria,
   a verification operation and an approval reason where one applies. Planning is
   deterministic: the same facts produce the same plan, which is what makes the plan
   reviewable.
3. **Dispatch.** `POST /api/executions/:id/dispatch` creates the tasks that are ready
   and asks the worker engine to start them. A task with an approval reason does not
   dispatch; it waits. Dispatch is not re-entrant: a second call while work is live
   returns the current view instead of creating a second wave.
4. **Reconciliation.** `POST /api/executions/:id/sync` reads the task, worker,
   verification, integration and recovery records and recomputes progress. It is the
   only thing that moves an execution forward, and it trusts stored evidence only.
5. **Review.** `POST /api/executions/:id/tasks/:taskId/review { decision }` goes through
   the worker engine's own review gate. Owner acceptance, not a worker's claim, is what
   completes a task.
6. **Report.** `GET /api/executions/:id/report` lists what was delivered, what is
   partial, what is blocked, what never started and which verification runs exist.

## Rules the code enforces

- **Handed-in is not done.** A task whose work is awaiting review reads `review`, and
  its dependents stay `waiting`. Verified-done requires either a stored passing
  verification run (for tasks that demand proof) or an accepted completion (for tasks
  that do not). Earlier this collapsed to "done" as soon as a worker handed work in,
  which let dependents start on a change the owner might reject.
- **No invented deliverable paths.** A planned deliverable is what the task should
  return, expressed as a `report` with no path. Which files may change is `scope`, and
  the worker's own tool authorisation enforces that. Naming a path in the plan would be
  a guess, and the worker manager refuses a file deliverable without a real path.
- **No proof, no claim.** A task that requires verification never reads as done on a
  worker's word; without a stored passing run the line says the work is recorded
  complete but unproven.
- **Owners stay separated.** Every read and write is bound to the calling owner; the
  store keeps `(id, owner_ref)` keys and a foreign execution answers `404`.

## Progress states

`ready` (dependencies met, nothing started), `running`, `review` (handed in, awaiting a
decision), `done`, `waiting` (dependencies unfinished), `blocked`, `failed`. Counts are
derived from these lines, never from schedule rows.

## Not included

- No automatic approval: an approval-gated task waits for the owner.
- No automatic merging: integration still goes through the Step 46 change-set and
  approval path.
- Executions are durable in PostgreSQL (migration 009), but the coordinator does not
  resume a half-finished dispatch by itself; a later sync continues from records.
- The dashboard polls; there is no push stream for these records.
- Without a model provider configured, dispatch fails with
  `WORKER_PROVIDER_UNAVAILABLE` rather than faking a result. Set
  `VELTRAVIA_WORKER_EXECUTOR=simulated` for QA.
