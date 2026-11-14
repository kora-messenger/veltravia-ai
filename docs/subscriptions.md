# Subscription plans

Step 60 adds plans: what an account is entitled to, how long for, and what changes when the
plan changes. It builds on Steps 52-59 rather than beside them. There is no second wallet, no
second ledger and no second spending engine: a plan decides the allowances and the feature
flags, and the existing lanes keep doing the charging.

Nothing here takes money. No price is stored, shown or implied, and there is no checkout.

## What a plan is

A plan is a row in `subscription_plans`, not a constant in the code:

| Field                         | Meaning                                               |
| ----------------------------- | ----------------------------------------------------- |
| `plan_id`                     | Stable id, referenced by subscriptions and by usage   |
| `name`, `description`         | Operator-editable text                                |
| `rank`                        | Display order, lowest first                           |
| `active`                      | Whether new assignments may use it                    |
| `visible`                     | Whether it appears in the catalogue                   |
| `self_service`                | Whether an account may move to it without an operator |
| `monthly_message_credits`     | Message-credit allowance for a period                 |
| `monthly_integration_credits` | Integration-credit allowance for a period             |
| `entitlements`                | Feature flags and numeric feature ceilings            |
| `quotas`                      | The Step 52 infrastructure ceilings                   |
| `version`                     | Bumped by the store on every write                    |

Five plans are seeded, and every number in them is a configurable default, not a price:
`development` (the included allowance, 500 integration credits), `starter` (2,000), `builder`
(10,000), `pro` (20,000) and `elite` (50,000). The four paid numbers are the ones carried over
from Step 56's tier table, and a test fails if the two tables ever disagree.

An edited plan takes effect on the next read. There is no cache to invalidate and no restart.

### Entitlements

`entitlements` is an open map, so a new feature is a new key, not a migration. The reader is
strict on purpose: **a key that is absent is denied**. That is what makes adding a feature safe

- forgetting to grant it to a plan closes it rather than opening it.

A numeric entitlement is a ceiling, and `0` means not included.

The keys the build currently reads: `managedProviders`, `byokProviders`, `codingAgent`,
`superagent`, `subagents`, `appBuilder`, `integrations`, `apiAccess`, `exportSources`,
`collaboration`, `hosting`, `advancedModels`, plus the limits `projects`, `workspaces`,
`maxSubagents`, `fileStorageBytes`.

### Enforcement

`registerSubscriptionGate` installs an `onRequest` hook over the route families it protects.
It is registered **before** those routes, because a Fastify hook only covers routes added
after it - the ordering is the enforcement, not a detail.

The gate answers 403 `PLAN_FEATURE_NOT_INCLUDED` and names the feature and the plan. A screen
hiding a button is a courtesy; this is the rule.

## Lifecycle

Statuses: `trialing`, `active`, `past_due`, `canceled`, `suspended`, `expired`. Transitions
are asserted in the core, so an illegal move is refused rather than written.

A subscription carries its period: `current_period_start`, `current_period_end`, `renews`,
`cancel_at_period_end`. Periods are one calendar month from the start instant, computed by
`periodFor`.

- **Assign** creates the row and records the first period (`subscription_periods`, unique per
  owner and period start).
- **Change plan** moves `plan_id` and keeps the period. The direction is reported as `upgrade`
  or `downgrade` for the audit trail and the message. Projects, files, credits and history are
  untouched in both directions, and a downgrade does not delete anything - it applies the
  lower limits from that moment, so a project over the new limit becomes read-only rather than
  disappearing.
- **Cancel** sets `cancel_at_period_end`; the paid period runs to its end and the paid
  entitlements hold until then.
- **Suspend** stops everything: no managed key, no personal key, no protected route.
- **Expire / lapse** is what happens when a non-renewing subscription's period ends: the
  included `development` allowance applies, the row stays, and nothing is deleted.

### Renewal is idempotent, and that took work

A renewal runs once per period however often the job runs. The claim is an insert into
`subscription_periods` keyed on `(owner_ref, period_start)`; a second attempt hits the unique
constraint and stops.

The first version keyed the claim on the period that had just **ended**. That period is already
in the table - the assignment wrote it - so every renewal collided with the account's own first
row and silently did nothing. The lifecycle test caught it: a subscription advanced 32 days
reported `applied: 0`. The claim now names the period being **granted**, which does not exist
yet, and the test walks four periods to prove it.

A run that missed several periods catches up one period per iteration, bounded at 36, so a
long outage does not grant a year in one loop. `POST /api/subscriptions/admin/renewals` sweeps
every due account.

## Integration with the existing lanes

The plan supplies what the other services already read:

- **Usage metering (Step 52)** - a subscription in force supplies its plan's quotas in place of
  the dev/paid quota table, and a lapsed or suspended one supplies the included allowance. An
  account with **no subscription row at all** keeps the Step 52 plan switch, so a paid account
  an operator marked by hand is not silently pushed down to the included allowance the moment
  subscriptions are wired in; once a subscription row exists it owns the answer, in every state.
- **Message credits (Step 54) and integration credits (Step 56)** - the plan's monthly
  allowances are what the panels compare against. Step 60 does not grant credit itself: a grant
  is a wallet movement, and Step 53's ledger stays the only record of credit.
- **Wallet (Step 53)** - untouched. A plan never writes a balance.
- **Spending limits (Step 59)** - unchanged and still checked first. A plan allowance and a
  limit are different promises: a limit refuses spending on a wallet, an allowance says what the
  plan includes. When both exist the tighter one wins, which is what the credit-check order
  already does.

## BYOK

The policy is unchanged and now enforced from the plan rather than a separate flag:

- Development deployments (`VELTRAVIA_DEVELOPMENT_MODE`, the existing global switch) allow a
  personal provider key for everyone.
- In production a personal key needs `byokProviders` on the plan in force.
- A suspended, expired or canceled subscription grants nothing, so a stored key is neither
  exposed nor silently used. This is the regression the first version shipped and the suite
  caught: collapsing "no subscription" and "a subscription that grants nothing" into one answer
  turned every existing paid account into the included allowance. The refusal happens in the meter **before** any provider call, so
  nobody is charged twice for a key they pay for directly.
- Stored secrets are untouched by any of this; Step 60 reads eligibility, not key material.

## Routes

Owner routes (scoped to the caller):

| Method | Path                                | Purpose                                                                                                                |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/subscriptions`                | Overview: plan in force, allowances, entitlements, quotas, history, plus the message, integration and wallet summaries |
| GET    | `/api/subscriptions/plans`          | The catalogue, for comparison                                                                                          |
| GET    | `/api/subscriptions/events`         | This account's plan events, newest first                                                                               |
| GET    | `/api/subscriptions/permissions`    | The caller's own feature flags, advisory                                                                               |
| POST   | `/api/subscriptions/me/change-plan` | Change plan; `self_service` closed returns 403                                                                         |
| POST   | `/api/subscriptions/me/cancel`      | Stop renewing at period end                                                                                            |

Operator routes (existing `VELTRAVIA_BILLING_ADMIN_TOKEN`, sent as `x-veltravia-admin` or a
bearer token): plan create/edit, plan activation, subscription list and read, assign, status
change (suspend/reactivate/cancel/expire), renew one, sweep all, and the audit trail. With no
token configured the whole surface answers 503 `SUBSCRIPTION_ADMIN_DISABLED` rather than
opening.

The operator acts on the account named by `x-veltravia-owner-ref`, and the route refuses when
the body names a different owner. That is the same rule Step 54 needed after credits were filed
against the wrong account.

## Storage

Migration 018:

- `subscription_plans` (global, no owner) - the catalogue.
- `subscriptions` - one row per owner, unique on `owner_ref`, compare-and-set on `version`.
- `subscription_periods` - unique on `(owner_ref, period_start)`; this is the renewal claim.
- `subscription_events` - one row per `dedupe_key`, so a repeated job does not repeat a notice.
- `subscription_audit` - append-only, one row per operator action with the previous and next
  state.

Every table is owner-scoped where it holds owner data, and the store asserts the bound owner
matches the row it is asked to write, so a request cannot file a change against another account.

## The screen

`#/plan` (`apps/web/src/pages/plan/SubscriptionPlanPage.tsx`):

- the plan in force first, with its status and, when there is one, the server's reason;
- the two allowances and the period end;
- every declared feature, with the ones the plan lacks written out as "Not included" rather
  than omitted;
- the quotas, the comparison cards, and the plan history;
- no price anywhere, and a note saying why;
- "Stop renewing" only while the plan will renew;
- loading, offline, error-with-retry and empty states, each one distinct.

The screen never assumes a change worked: it re-reads the overview after a successful write and
prints the server's message.

## Configuration

| Variable                              | Default                              | Meaning                                     |
| ------------------------------------- | ------------------------------------ | ------------------------------------------- |
| `VELTRAVIA_BILLING_ADMIN_TOKEN`       | unset                                | Enables the operator surface                |
| `VELTRAVIA_SUBSCRIPTION_SELF_SERVICE` | `false`                              | Let accounts change their own plan          |
| `VELTRAVIA_DEVELOPMENT_MODE`          | on when `NODE_ENV` is not production | BYOK for everyone                           |
| `VELTRAVIA_PAID_PLAN`                 | `builder`                            | The plan an operator assignment defaults to |

## Not delivered

- **No payment, no checkout, no invoices, no proration.** Self-service changes are closed by
  default for exactly this reason: a plan change with no payment behind it is a free upgrade.
- No trial automation. `trialing` exists as a status and nothing creates one.
- No seat or member model: a subscription belongs to one owner ref.
- No scheduled renewal timer is started by the API. The sweep route exists and must be called
  by whatever schedules it; nothing here runs a job that could renew twice.
- No admin UI. The operator surface is HTTP only.
- The screen shows the plan history but not the full audit trail; that is on the operator route.
