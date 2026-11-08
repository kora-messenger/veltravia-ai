# Production reliability, idempotency and crash-safe orchestration (Step 51)

Step 50 made one request run end to end. Step 51 makes that run survive retries,
restarts, duplicate requests and two API instances working at the same time.

Nothing here replaces an existing engine. Tasks, workers, verification, change
integration and recovery keep their own lifecycles; this step adds the
coordination primitives they were missing and proves the behaviour against a real
database.

## The gaps found before changing code

Each item was read out of the code, not assumed.

### G1. Duplicate requests create duplicate work

`POST /api/executions` plans and creates a task graph on every call. A client
retry, a double-tapped button or a load balancer replay with the same body
creates a second execution, a second set of tasks and a second set of workers.
The same is true for `POST /api/tasks`, `POST /api/workers` (delegate),
`POST /api/workers/:id/start`, `POST /api/verification`, the recovery and
change-integration routes. Step 29 had an in-process idempotency map for AI
runs only (`ai-execution-service.ts`), which a restart forgets and a second
instance never sees.

### G2. Two instances can dispatch the same execution at once

`ExecutionManager.dispatch` reads the record, then delegates and starts workers,
then writes the record with a compare-and-set. The compare-and-set protects the
record, not the side effects: two processes can both pass the read, both delegate
a worker for the same task, and only then discover the version conflict. One
worker is left running that the record does not mention.

`sync` has the same shape around `openRecovery`: two readers see no case for a
failed worker, both ask the recovery engine to open one, and the duplicate is
prevented only by however the recovery store answers.

Worker start is guarded by `this.handles`, which is per process, so it says
nothing to a second instance.

### G3. A crash leaves work invisible

Nothing sweeps. `recoverStalled` exists in the worker runner and is called only
from `POST /api/workers/recover-stalled`, so after an unexpected stop a worker
sits in `running` with a stale heartbeat, its execution sits in `executing`, and
the owner sees neither progress nor a reason. There is no record of what the
interrupted process was doing, so nobody can tell "never started" from "started
and died".

### G4. Terminal executions can still be mutated

`ExecutionManager.review`, `integrate` and `revise` do not check the execution's
own status. A cancelled execution can still have a worker's work accepted, and a
completed one can still be revised. Worker review refuses a cancelled *worker*
(`worker.status !== 'awaiting_review'`), which is a different record and does not
cover work that was handed in just before the cancel.

### G5. An older passing verification can satisfy a newer failure

`verificationFor` in `execution/core/src/progress.ts` picks
`candidates[candidates.length - 1]`, which is the oldest entry, because every
verification store lists runs newest-first. Whether a task counts as proven
therefore depends on list order rather than on which run is the latest. A newer
failing run can be overruled by an older passing one.

### G6. No backpressure and no visible queue

`start` accepts any number of open executions per owner, and nothing reports
queue depth, expired leases, abandoned executions, retry counts, recovery
frequency or failed event processing. The operations page shows the fleet, not
the health of the machinery that moves it.

### G7. No durable record of a recovery decision

Recovery cases record attempts and events (Step 48), but the decision to resume
or leave an interrupted execution alone lives nowhere. After a restart there is
no way to say what the previous process decided or why.

## What this step adds

- `@veltravia/reliability-core`: idempotency records with fingerprints, leases
  with expiry and renewal, a deduplicating event inbox, a pure sweep decision,
  and a health snapshot built only from observed records.
- Migration 010: `idempotency_records`, `execution_leases`, `event_inbox`,
  `orchestration_recoveries`. All owner-scoped, all with the constraints the
  guarantees rest on.
- An `Idempotency-Key` contract on every mutating `/api` route, enforced in one
  hook rather than per route.
- Durable leases around dispatch, sync, integration and the sweep, so the same
  execution is never advanced by two processes at once.
- A sweep that turns crashed work into a recorded decision, and a
  `GET /api/reliability/health` that reports what is observed.

## What is not claimed

- Not exactly-once execution. A request that dies after its side effect but
  before its record is completed can still be retried; the guards make the
  duplicate visible and refuse to apply the same change set twice, they do not
  make the work itself atomic.
- Not distributed consensus. Coordination is a row-level atomic claim in one
  database; with two databases there is no shared truth.
- Lease expiry is measured from the last renewal, so a process that is alive but
  paused past its lease can lose the lease to another instance. That is the
  intended trade-off and it is why every operation re-reads before it writes.
