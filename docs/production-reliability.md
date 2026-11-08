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
completed one can still be revised. Worker review refuses a cancelled _worker_
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

## The primitives, in detail

Three small primitives plus a sweep, all pure over their ports.

### Idempotency

`IdempotencyStore` keys a mutating request by `scope` + key + a fingerprint of the request body.

- The first call for a key records an in-progress entry and claims it. A caller that loses the
  claim and retries gets **`IDEMPOTENCY_IN_PROGRESS` (409)**, never a second execution.
- A completed entry replays the first answer verbatim, with the `Idempotency-Key` header
  echoed and no second side effect.
- The same key with a **different body** is `IDEMPOTENCY_KEY_REUSED` (422). The key names one
  request, not one client.
- Keys are scoped to the owner: another owner's key is invisible, so it cannot be probed.
- Entries expire after `retentionHours` (24 by default) and are swept then, not on read.
- Requests that carry no key are not guarded at all. They still execute; the page says so
  rather than implying every route is protected.

Key material is never stored or logged. Records carry a **hint** (a short prefix plus a
checksum suffix) and a body **fingerprint**, which is enough to recognise a retry and useless
to anyone reading the database.

### Leases

`LeaseStore` holds a resource lease with a holder id and an expiry. A lease is the difference
between "work is slow" and "nobody is doing this":

- Claim is one atomic store statement: insert, or take over a released or already expired
  claim. A live lease held by someone else returns `null` and `withLease` reports
  `held: false`, so the caller skips instead of doing the work twice. A valid lease is never
  stolen.
- Expiry is evidence of absence, not proof of failure. An expired lease is released and then
  the sweep re-reads the work to decide what actually happened.
- `withLease` releases in a `finally`, so an error path does not leave a resource locked.
- Losing a lease costs work, not correctness: every write that follows re-reads the
  authoritative record first.

### Event inbox

`EventInbox` records an incoming event key once and marks it processed. Two deliveries of the
same event do the work once. A failed event records its error and its `availableAt`, so a
retry is a decision with a timestamp rather than an accident.

### The sweep (crash-safe orchestration)

`planSweep` takes the open executions, the lease table and the fresh records, and returns a
decision per execution:

| Decision      | When                                                                             | What it does                                                                          |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `resume`      | A live lease exists and activity is recent                                       | Nothing. Someone is working.                                                          |
| `recover`     | The lease is gone or expired, and re-reading the records shows work to carry     | Releases the dead holder's leases and reopens the loop by reconciling against records |
| `await_owner` | Re-reading shows the work is waiting for a person (review, approval, a decision) | Asks, does not guess                                                                  |
| `leave`       | The records do not support any action                                            | Says so, with the evidence                                                            |

Two rules are enforced in code, not documentation:

1. **The sweep never finishes work.** It cannot mark a task done, accept a deliverable or
   approve an integration. Those are the review gate's business (Steps 43, 45 and 46) and
   remain the only paths that complete anything.
2. **A sweep never infers a failure it cannot see.** If a worker row is missing, the execution
   is reopened for reconciliation, not declared failed. An empty queue and a lost queue look
   identical from the outside; the honest answer is the one that can be proven.

Every decision carries the rows it rested on, and `ownerAction` when a person is what the work
needs. `skipped` counts executions another process held, so a two-process sweep does not
double-report.

## API

| Route                               | Purpose                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/reliability/capabilities` | What is enforced: header name, retention, lease TTL, backpressure, and what is explicitly **not** promised |
| `GET /api/reliability/health`       | Counts from stored records, findings with evidence, and `unavailable` sources                              |
| `POST /api/reliability/sweep`       | One pass. Guarded by `Idempotency-Key`; a repeated key replays the first decision                          |
| `GET /api/reliability/recoveries`   | The decisions recorded for interrupted work, optionally by execution                                       |
| `GET /api/reliability/keys`         | Keyed requests, filtered by scope and status                                                               |
| `GET /api/reliability/events`       | Recorded side effects, filtered by topic and status                                                        |

`Idempotency-Key` is honoured on the mutating execution route (`POST /api/executions`). Two
owners cannot collide: scope includes the owner.

## Backpressure

`maxOpenExecutionsPerOwner` (10) is checked at intake, before any planning. An owner above it
gets **`EXECUTION_BACKPRESSURE` (429)** rather than a queue that grows without limit.
`RELIABILITY_LIMITS` also fixes the lease TTL at 30 seconds with renewal, a 60 second window
after which an in-flight key is treated as abandoned by its process, and 25 executions per
sweep pass.

## Dashboard

The Reliability region of `#/operations` reads the routes above. It shows the queue tiles, the
lease and side-effect counts, the findings with their evidence, the last sweep's decisions, and
the open keyed requests. Its only control is **Sweep interrupted work**, which posts once per
minute by key: a double click returns the same decision.

A finding is never rendered without the rows it came from, and the panel never says work was
recovered unless a stored record says so. When a source could not be read the panel says the
counts are partial instead of showing zeros.

## Tests

- `reliability/core/src/reliability.test.ts` - key replay, key reuse with a different body,
  cross-owner invisibility, expiry, lease refusal and release, inbox de-duplication, every
  sweep decision, and the two rules above.
- `apps/api/src/reliability.test.ts` - the same behaviours over HTTP, including the replayed
  header, backpressure, and another owner's project answering 404 rather than leaking a 500.
- `apps/web/src/pages/operations/ReliabilityPanel.test.tsx` - counts, the not-durable finding,
  an unreadable snapshot, a sweep with a decision, an empty sweep, and a stuck key.

## Not included

- No distributed lock across processes for the coordinator itself; the sweep skips what another
  lease holder owns, which is the coordination available.
- No automatic retry of failed events into a real queue: `availableAt` is recorded, and the
  sweep is what acts on it.
- No real auth: the owner header remains a development stand-in, as everywhere else in this
  API.
