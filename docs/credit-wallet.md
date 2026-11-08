# Credit wallet

Step 53. What a Veltravia credit is, how a wallet moves it, and what the system
refuses to do with it.

The wallet is a **ledger with a running total**, not a number that gets edited. Every
movement of credit is a new entry, and the wallet row is the sum of the entries that
explain it. That is not fastidiousness: it is what makes "why is my balance 12 credits"
answerable, and it is what makes a mistake fixable by writing the opposite entry
instead of quietly changing history.

## The three numbers

| Number      | Meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `available` | Credit the wallet holds right now.                                                  |
| `reserved`  | Credit promised to work that has started but not settled. Not spendable, not spent. |
| `spent`     | Credit consumed for good. A refund reduces it; nothing rewrites it.                 |

`spendable = available - reserved`. The dashboard shows all four, because showing
`available` alone reads as "this is yours to spend" while some of it is committed.

## Entry kinds

| Kind                                     | available | reserved | spent    | When                                             |
| ---------------------------------------- | --------- | -------- | -------- | ------------------------------------------------ |
| `purchase`, `grant`, `promotion`         | +amount   | –        | –        | Credit is added.                                 |
| `usage_deduction`                        | -amount   | –        | +amount  | Metered work is charged.                         |
| `reservation`                            | -amount   | +amount  | –        | Work starts and credit is held.                  |
| `reservation_commit`                     | +unused   | -held    | +spent   | The hold settles at what the work actually cost. |
| `reservation_release`                    | +amount   | -amount  | –        | The work did not happen; the hold goes back.     |
| `refund`                                 | +amount   | –        | -amount  | A charge is given back.                          |
| `adjustment_credit` / `adjustment_debit` | ±amount   | –        | –        | An operator correction.                          |
| `reversal`                               | mirrored  | mirrored | mirrored | One entry is undone exactly.                     |

Reservation rows sum to zero, which is why the three deltas are stored per entry rather
than one signed amount: a hold moves credit sideways, and a single `-20` would be
indistinguishable from a spend.

## What is guaranteed, and where

- **No overdraft by accident.** `computeBalances` in `@veltravia/wallet-core` is the only
  arithmetic, and stores apply the deltas inside one atomic step: a conditional update in
  PostgreSQL (the wallet row is locked `for update` before the balance is read), a
  synchronous section in the in-memory store. Checking a balance and then writing it is
  how two deductions each get the last credit; there is no moment between the two here.
- **Idempotency.** `(owner_ref, idempotency_key)` is unique on `wallet_entries`. A retried
  request finds its own entry and returns it (`created: false`) instead of charging again.
  Concurrent retries queue on the wallet lock, so both see the same outcome.
- **One settlement per hold.** `wallet_reservations.state` moves through `held → committed |
released | expired` by compare-and-set; the second settle changes nothing and reports
  `409 INVALID_STATE`.
- **Refunds cannot exceed the charge.** `refundedTotal(entryId)` caps the sum, and a
  retried refund is recognised by its idempotency key rather than counted twice.
- **Reversals happen once.** `reversals_entry_id` is looked up before the write.
- **Balances are provable.** `GET /api/wallet/reconcile` sums the deltas and compares them
  with the stored wallet row, returning the problems in words when they disagree.

## Usage metering integration (Step 52)

The usage meter writes a record and then calls the wallet once, through
`createUsageService({ onRecorded })`. The charge's idempotency key is derived from the
**meter's own operation key** (`usage:<operationKey>`), so the same metered event cannot be
billed twice even if the hook runs twice or a worker is reviewed repeatedly.

Three rules keep the bill honest:

1. Only `status: 'recorded'` usage is billable. An excluded duplicate or a superseded
   measurement charges nothing.
2. A record whose `costBearer` is `user_provider` is **never** converted into credits. Direct
   AI-provider spend is the owner's contract with the provider. Only managed keys, which this
   platform pays for, can carry an `ai_provider` credit rate.
3. A category with no configured rate charges nothing, and the capability response says so
   (`file_storage: not billed`) instead of inventing a price.

A wallet that cannot cover a charge does not undo work that already ran: the refusal is
reported, the metered record stays visible, and no partial state is written.

## Rates

Defaults live in `wallet/core/src/pricing.ts` and are configuration, not constants:

| Category                                                    | Default                                      |
| ----------------------------------------------------------- | -------------------------------------------- |
| `background_jobs`                                           | 5 credits per job                            |
| `backend_execution`                                         | 1 credit per 60 s of worker wall clock       |
| `hosting`                                                   | 1 credit per hour                            |
| `ai_provider`                                               | 1 credit per 1,000 tokens (managed key only) |
| `database_storage`, `file_storage`, `bandwidth`, `realtime` | not billed                                   |

Override with `VELTRAVIA_CREDIT_RATES`, a JSON object in the same shape, for example
`{"background_jobs":{"credits":9,"per":1}}`. A malformed override falls back to the defaults
rather than billing at zero. Each entry records the rate it was charged at, so changing a
rate never rewrites history. These are our documented defaults, not a market price.

## API

Owner routes (owner comes from the request context; a `workspaceId` selects a workspace
wallet and never widens access):

| Route                                               | Purpose                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/wallet`                                   | Balances, held credit, recent entries, rate table, durability note. |
| `GET /api/wallet/transactions?limit=&before=&kind=` | Ledger page, newest first.                                          |
| `GET /api/wallet/reservations`                      | Holds currently open.                                               |
| `GET /api/wallet/reconcile`                         | Ledger-versus-balance proof.                                        |
| `GET /api/wallet/capabilities`                      | Currency, rates, billing rules, limits.                             |
| `POST /api/wallet/reservations`                     | Hold credit for work starting (`amount`, `operationKey`).           |
| `POST /api/wallet/reservations/:id/release`         | Give the hold back.                                                 |
| `POST /api/wallet/reservations/:id/commit`          | Settle the hold, optionally at a lower amount.                      |

Operator routes require `Authorization: Bearer $VELTRAVIA_WALLET_ADMIN_TOKEN`
(`VELTRAVIA_USAGE_ADMIN_TOKEN` is accepted as a fallback). With neither configured they
answer `503 WALLET_ADMIN_UNAVAILABLE` rather than falling open. `x-veltravia-actor` names
the operator and is written into the entry.

| Route                                | Purpose                                      |
| ------------------------------------ | -------------------------------------------- |
| `POST /api/wallet/credits`           | `purchase`, `grant` or `promotion`.          |
| `POST /api/wallet/adjustments`       | `direction: credit \| debit`, with a reason. |
| `POST /api/wallet/refunds`           | Refund a charge, capped at what it charged.  |
| `POST /api/wallet/reversals`         | Undo one entry exactly, once.                |
| `POST /api/wallet/policy`            | Turn a credit line on, with a floor.         |
| `GET /api/wallet/operator/:ownerRef` | Read one owner's ledger as an operator.      |

Refusals carry a code and the numbers: `402 INSUFFICIENT_CREDITS` with `required`,
`available`, `shortfall`; `409 INVALID_STATE` for a hold already settled; `409
REFUND_EXCEEDS_ORIGINAL`; `409 ALREADY_REVERSED`; `400 INVALID_AMOUNT` for a negative, zero,
non-finite or over-four-decimal amount. Amounts are validated server-side before any balance
is read.

## Storage

Migration `012-credit-wallet` adds three tables: `wallets` (the only mutable row),
`wallet_entries` (append-only, unique per owner and idempotency key) and
`wallet_reservations`. Without a database the service uses an in-memory store and the API
says `durable: false`, so the dashboard states that balances reset on restart instead of
implying persistence.

## What is not here

- **No payment processing.** There is no card, invoice or checkout flow. `purchase` exists as
  an entry kind for credit that arrived through some other process, and nothing in this
  system takes money or verifies a payment. Do not read the word "purchase" as a
  delivered billing integration.
- **No workspace membership.** A workspace wallet is keyed by `(owner_ref, workspace_id)`, so
  another owner cannot reach it, but inviting members to share one wallet is not implemented.
- **No automatic transfer** between a personal and a workspace wallet; an operator moves
  credit, with a reason.
- **No scheduled hold sweep.** `expireReservation` exists and is tested, but nothing calls it
  on a timer yet; a hold that nobody settles stays `held` until something releases or
  expires it.
