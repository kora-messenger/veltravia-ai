# Integration credits and connector usage billing (Step 56)

Step 56 prices third-party work: integrations, connectors, plugins and external-service
operations. It sits on the three systems that already exist and does not duplicate any of
them:

- **Step 52 usage metering** answers "is this caller allowed, and how much have they used".
- **Step 53 credit wallet** holds, spends and refunds the credit.
- **Step 54 message credits** prices model work, one interaction at a time.
- **Step 55 operation billing** prices a run that makes many model calls.

Integration credits price the fourth thing a platform spends money on: the outside world.

## The three billing classes

Every operation is classified before it runs, and the class is what decides whether credit
moves at all.

| Class               | Meaning                                                                           | Charged                                            |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| `free`              | The operation costs the platform nothing to run (offline mocks, bundled tooling). | Never. No hold.                                    |
| `paid`              | Veltravia supplies the credential, so the operation is priced in credits.         | Yes: hold, measure, settle.                        |
| `externally-billed` | The external service charges the user's own account.                              | No, unless a policy sets `chargeExternallyBilled`. |

Three further exemptions never become a charge:

- the development plan is not billable at all;
- a call made with the owner's own provider key (`byok: true`) is exempt (`byok-excluded`);
- an operation with no policy behind it resolves to free with its reason recorded.

An exempt operation still writes a row. A row that says "exempt, because the external
service bills your account" is a decision somebody can audit; a missing row is not.

## Lifecycle

```
classify -> reserve (hold) -> run -> commit (settle) | release
```

- **Reserve** prices the operation from the plan's policy, refuses when a spending limit
  would be crossed or the wallet cannot cover the hold, and writes a `reserved` row. A
  refusal is recorded as `released` with the reason, never as a live hold.
- **Commit** settles against the measurement the platform actually has: the number of
  dispatched operations (one) and the wall clock. A hold is a floor, not a cap: a measured
  charge above it is drawn from available in the same atomic wallet transition, and a
  wallet that cannot cover the difference gets the part the hold covers and a row that says
  `measurement-above-hold-uncovered`.
- **Release** returns the hold on failure, timeout, cancellation or an operator decision,
  and records why.

The one seam the integration runtime uses is `bill(context, run)`. It is called once per
executed connector operation, after the Tool System pipeline has authorized it, and it
refuses before calling `run` when the hold cannot be taken. Nothing external happens for work
that cannot be paid for.

## Measurements nobody reported

A charge carries `requests`, per-unit counts, `durationMs`, `measurementSource` and a list of
`limitations`. When a provider does not report usage, `requests` is `null` and the limitation
says `request-count-unavailable`; the flat part is still owed, because the operation
happened. Nothing is ever filled in with a plausible-looking number.

## Idempotency

A reserve carrying an `idempotencyKey` returns the first charge for that key with
`created: false` instead of holding twice. A commit on an already-settled charge returns the
same figures; a refund points at the entry it compensates and can never exceed it.

## Spending limits

Two optional limits per owner (and per workspace): `monthlyLimit` and `perOperationLimit`. A
limit is checked **before** the hold, so a refused operation costs nothing and leaves no
reserved row. Limits are set through `PUT /api/integration-credits/settings`.

## Where the money is

A funded workspace wallet pays for its own integrations. An unfunded one defers to the owner
wallet, so a workspace label never refuses work the account can afford. A hold keeps
settlement on the same purse that took it.

## API

| Method  | Route                                          | Purpose                                                  |
| ------- | ---------------------------------------------- | -------------------------------------------------------- |
| GET     | `/api/integration-credits`                     | Wallet, month totals, open holds, limits                 |
| GET     | `/api/integration-credits/policy`              | Rate table, classes, "defaults, not prices" flag         |
| GET     | `/api/integration-credits/charges`             | Charge ledger with filters                               |
| GET     | `/api/integration-credits/usage?dimension=`    | integration, connector, operation, project, billingClass |
| GET     | `/api/integration-credits/integrity`           | Wallet reconciliation + charges without a ledger entry   |
| GET/PUT | `/api/integration-credits/settings`            | Spending limits                                          |
| POST    | `/api/integration-credits/classify`            | What an operation would cost, who pays. Writes nothing   |
| POST    | `/api/integration-credits/reservations`        | Hold                                                     |
| POST    | `/api/integration-credits/charges/:id/commit`  | Settle against a measurement                             |
| POST    | `/api/integration-credits/charges/:id/release` | Return the hold                                          |
| POST    | `/api/integration-credits/charges/:id/refund`  | Operator-only refund                                     |
| POST    | `/api/integration-credits/sweep`               | Release holds past their window                          |

Refunds and sweeps across owners need `VELTRAVIA_INTEGRATION_CREDIT_ADMIN_TOKEN`.

## Configuration

| Variable                                   | Purpose                                          |
| ------------------------------------------ | ------------------------------------------------ |
| `VELTRAVIA_INTEGRATION_HOLD_TTL_SECONDS`   | How long a hold survives unsettled (default 900) |
| `VELTRAVIA_INTEGRATION_CREDIT_ADMIN_TOKEN` | Operator token for refunds                       |

The policy table (`integration-rates.v1`) is shipped as **configurable defaults**. Every
figure in it is an internal credit rate, not a price in money, and the API says so on the
policy route so no screen can present it as a price list.

## Storage

Migration `015-integration-credits` adds `integration_charges` and
`integration_credit_settings`, with the same append-friendly shape as Step 54: a charge is
written once, transitions are recorded on it, and the ledger entry is referenced rather than
duplicated. Idempotency is a unique key per owner.

## Tests

- `apps/api/src/integration-credit-service.test.ts` - holds, settlement, idempotency,
  release, sweep, refunds, limits, classification, the gate, purse resolution (23 tests).
- `apps/api/src/integration-credits.test.ts` - the routes against PostgreSQL, including a
  second app instance reading a charge back after a restart (12 tests, skipped without a
  database).
- `apps/api/src/integration-billing-seam.test.ts` - one gate call per executed connector
  operation, and a refusal that stops the operation (4 tests).
- `storage/postgres/src/integration-credit-store.test.ts` - the Postgres store.
- `apps/web/src/pages/operations/IntegrationCreditsPanel.test.tsx` - the dashboard keeps the
  three classes apart and never shows an invented measurement (8 tests).

## What this does not do

- **No payment processing and no real-money purchase of integration credits.** A `purchase`
  entry kind exists in the wallet; there is no checkout.
- **No per-integration funding flow** for somebody else's workspace.
- **The sweep is on demand**, not scheduled.
- **No operator UI** for refunds; the guarded route exists and is tested.
- Charges file under the owner that owns the connector connections (the deployment's owner
  header), not a per-request caller. A real auth layer would pass the caller through the same
  `ownerRef` field on the execution context.
