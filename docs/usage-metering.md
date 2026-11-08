# Usage metering and quotas

Step 52 answers two questions the platform could not answer before: _what has this owner
used this month?_ and _what happens when they hit the line?_ It does that without
becoming a second source of truth. Tasks, workers, verification runs, change sets,
recoveries, executions and the gateway's own usage rows stay authoritative for what
happened. A usage record **points at** one of them and says how much it consumed.

## What is implemented

- `@veltravia/usage-core` - the plan catalog, an idempotent append-only ledger
  (`record`, `reserve`, `commit`, `release`, `adjust`), quota resolution (plan → owner
  override → project override), aggregation, and an explicit capability table saying
  which numbers are measured, derived, estimated or unavailable.
- Migration `011` plus `PostgresUsageStore` - records, reservations, adjustments and
  configuration, all owner-scoped in SQL. `claimReservation` is atomic: eight
  simultaneous claims against two free slots produce exactly two holds.
- `apps/api/src/usage-service.ts` - the one place a limit is judged. It owns the
  decision, the refusal text and the numbers behind them.
- `apps/api/src/routes/usage.ts` - owner reads, operator writes.
- The usage panel on `#/operations`.

## The three decisions that shape the code

**Counters and gauges are different.** Tokens, milliseconds, calls and jobs accumulate,
so they come from the ledger. File storage and open connections are _states_: they come
from a probe of what exists now. Summing monthly storage rows would keep charging for a
file that was deleted in week two.

**An unmeasured limit is reported as unenforced, not as room to spare.** `used: null`
means nothing in this deployment observes the quantity. The panel then shows the limit
as a stated number with "nothing measures this yet" and draws no bar. Today that applies
to database storage, bandwidth and realtime connections; there is no byte probe for the
database and no accumulator for either of the others. Publishing the limit and admitting
it is not enforced is the honest version of shipping it.

**Provider cost and infrastructure cost are never added together.** A BYOK call is the
caller's own provider bill: it is recorded with `allowance: null`, `costBearer:
user_provider`, and excluded from what an allowance spent. Only a Veltravia-managed key
would draw on `providerTokens`. **As shipped, every provider call uses the owner's own
connected key**, so the allowance is never the payer and `managedProviders` is only
reachable through development mode or a paid entitlement with a managed key path that
does not exist yet.

## Enforcement points

| Where                                   | Decision                                          | Refusal                                   |
| --------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| `POST /api/executions` (intake)         | `guardBackgroundJob` takes a hold on the job      | `429 USAGE_LIMIT_REACHED` with `decision` |
| `POST /api/workers/:id/start`           | `guardConcurrency` against what is running now    | `429 USAGE_CONCURRENCY_REACHED`           |
| `guardProviderCall` (service)           | paid entitlement for a managed key                | `402 USAGE_PLAN_REQUIRED`                 |
| `POST /api/workers/:id/review` (accept) | none - it _records_ wall clock after the decision | -                                         |
| gateway `usage` event                   | none - it _records_ provider tokens               | -                                         |

Two rules hold across all of them: a refusal happens **before** anything is claimed or
planned, so a refused intake leaves no half-started work; and a metering write that
fails never turns completed work into an error.

Wall clock for `backend_execution` is the time between a worker's start and its review,
marked `source: 'derived'`. It is not an instrumented CPU timer, and the capability
table says so.

## Corrections

`POST /api/usage/adjustments` appends a signed adjustment; it never rewrites the row it
corrects, and an `auditId` makes the same correction idempotent. The reason must be at
least eight characters, because "oops" is not an audit trail.

## Operator surface

Changing a plan, a limit or a correction is operator work, not owner work: a caller must
not widen the limit that is judging them. These routes need
`VELTRAVIA_USAGE_ADMIN_TOKEN` and an `x-veltravia-admin` header (compared in constant
time, hashed first). When the token is not configured they answer
`503 USAGE_ADMIN_DISABLED` rather than falling open.

## Known gaps

- No database-storage probe and no bandwidth or realtime accumulators, so those three
  limits are published but not enforced.
- The ledger is durable only when a database is configured. In memory mode the counters
  reset on restart, and plan/limit changes are refused (`503 USAGE_NOT_DURABLE`) instead
  of being quietly forgotten.
- There is no Veltravia-managed provider key, so `providerTokens` cannot bite yet.
- Holds expire after 30 minutes and are swept by `usage.sweep`; there is no scheduled
  sweep wired into the server yet, so an unsettled hold is only cleared when a sweep is
  requested or when it is next read past its expiry.
