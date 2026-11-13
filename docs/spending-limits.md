# Spending limits

Step 59. Ceilings on what an account may spend in a window, enforced before credit is held,
plus the per-operation and held-credit ceilings that make a single runaway operation
survivable.

This step adds **no wallet, no ledger and no charge**. The wallet still owns the balance,
the charge records still own the usage, and Step 58's page still owns the dashboard. A limit
reads those numbers and answers one question: may this operation start?

## What was missing

By the end of Step 58 an account could see what it had spent, but nothing could stop it.
The three existing guardrails were each too narrow:

| Guardrail that existed             | Why it was not enough                                          |
| ---------------------------------- | -------------------------------------------------------------- |
| Monthly message ceiling (Step 54)  | One lane only; a coding run or an integration never touched it |
| Per-operation limit (Steps 54, 56) | Bounds one call; a loop of small calls passes every time       |
| Wallet balance (Step 53)           | Refuses only when the money is already gone                    |

There was also nowhere to say "warn me at 80% but keep going", and no record of a refusal
after the fact.

## The four rules the code follows

**1. A hold counts against the allowance.** A reservation is credit the owner can no longer
spend, so it is part of `consumed`. A limit that ignored holds would let a task reserve its
whole balance in parallel and pass every check on the way. `consumed = committed + held −
refunded`, read from both charge lanes.

**2. The tightest scope wins.** A user, a workspace and a project may each carry a policy.
All applicable rules are evaluated and the smallest remaining allowance decides, so a
project limit cannot be escaped by a generous personal one. When two scopes disagree the
refusal names the rule that decided.

**3. Soft and hard are different promises.** A `soft` rule writes a warning event once per
threshold per window and lets the work continue. A `hard` rule refuses with `402`
`SPENDING_LIMIT_REACHED` **before** any hold is taken, so nothing is held, nothing is
settled and nothing has to be released.

**4. A stale write is refused, not forced.** Every policy write carries the `version` the
screen read; a mismatch is `409 STALE_VERSION`. Two open tabs cannot silently overwrite each
other, and removing a policy is a checked write too.

## What the check protects

Three real choke points, all of them before money moves:

- `MessageCreditService.reserve` - chat, coding runs, agent calls, reasoning, tools.
- `IntegrationCreditService.reserve` - every connector call, before the external request.
- The worker model loop - a running worker asks again before its next model call, so one
  long run cannot outspend a window it started with room in.

The `check` route (`GET /api/spending-limits/check`) answers the same question without
charging or writing an event, so a screen can explain a refusal before somebody hits send.

## The race that the first version lost

Eight simultaneous requests all read the same untouched allowance and all eight passed. The
allowance was read, then the hold was taken, and nothing held the window still in between.

The fix is a per-owner guard around "read the allowance, decide, take the hold":

- **Postgres**: `pg_advisory_xact_lock` on a key naming the owner and the lane, held for the
  duration of the check-and-hold. Transaction-scoped, so it is released on commit, on
  rollback, and by the server if the process dies.
- **In memory**: a promise chain per owner, for the memory store and the tests.

Two things went wrong on the way and are worth keeping:

1. **The guard deadlocked the request pool.** Holding an advisory lock on a request-pool
   connection means every request holds one connection for its lock and needs a second to do
   the work; at saturation nothing can progress. The lock now runs on a small dedicated pool
   (two connections), where waiters queue inside `pg-pool` holding nothing.
2. **A refusal arrived as a database failure.** Wrapping the callback in a transaction turned
   `402 SPENDING_LIMIT_REACHED` into `500`. The callback's error is now rethrown untouched,
   which is Step 53's lesson repeating itself.

## Shape

`@veltravia/spending-limits-core` holds the pure decision: `evaluateSpending`, the window
arithmetic (daily, weekly, monthly, custom days), the threshold bookkeeping, policy
validation with a readable reason per field, and an in-memory store.

`apps/api/src/spending-limit-service.ts` binds it to the two charge lanes and the wallet and
exposes:

| Route                                | What it does                                           |
| ------------------------------------ | ------------------------------------------------------ |
| `GET /api/spending-limits`           | Policies in force, live limits, windows, holds, events |
| `GET /api/spending-limits/policies`  | The raw policy rows                                    |
| `PUT /api/spending-limits/policy`    | Create (`expectedVersion: null`) or update             |
| `DELETE /api/spending-limits/policy` | Remove, returning the scope to its parent              |
| `GET /api/spending-limits/check`     | Dry run: would this start?                             |
| `GET /api/spending-limits/events`    | Warnings and refusals                                  |
| `GET /api/spending-limits/audit`     | Who changed which limit, when, and why                 |
| `GET /api/spending-limits/platform`  | The platform maximum and defaults (read-only)          |
| `PUT /api/spending-limits/platform`  | Operator only: the maximum and the enforcement switch  |

Migration 017 adds `spending_limit_policies`, `spending_limit_platform`, `spending_limit_events`
(one warning per rule per window, enforced by a unique key) and `spending_limit_audit`
(append-only).

The screen is a panel inside Step 58's `#/usage` page rather than a fifth dashboard: limits
belong beside the numbers they bound. It shows the limit, what has been used **including
held** credit, what is left, when it resets, the mode in words, the per-operation and
held-credit ceilings, and the recent warnings and refusals. Nothing on it converts credits
to money.

## Not delivered

- **No payment or plan gating.** A limit is an account's own choice, not a billing tier.
- **No automatic suspension.** Reaching a hard limit refuses the next operation; it does not
  lock the account or end a conversation.
- **No workspace funding.** Workspace and project scopes bound spending that the owner's
  wallet pays for; they do not hold credit of their own.
- **The guard is per lane.** A message operation and an integration operation for the same
  owner can be decided at the same instant, so an `all` rule spanning both lanes can be
  passed by up to one operation's worth in the worst case. Each lane on its own is exact.
- **Custom windows are days, not cron.** The API accepts `period: 'custom'` with
  `periodDays` (1 to 366, aligned to an anchor instant), and it is tested, but the screen
  offers only daily, weekly and monthly. There is no expression language.
