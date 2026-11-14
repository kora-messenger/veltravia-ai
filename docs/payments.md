# Payments, invoices and billing

Step 61. A plan can now be bought, and the money is verified by this server instead of being
believed from a browser.

- Core: `@veltravia/payments-core` (money, price book, provider adapters, webhooks, documents)
- Storage: migration 019 (`payment_*`, `billing_*`), `PostgresPaymentStore`
- API: `apps/api/src/payment-service.ts`, `apps/api/src/routes/payments.ts`
- Screen: `#/billing` (`apps/web/src/pages/billing/BillingPage.tsx`)

## The five rules the tests exist for

1. **The amount is decided here.** `buildQuote` reads price, discount and tax rows and produces
   the charge. The checkout body carries a plan, an interval and a provider - never an amount, a
   currency or a total. A test sends `amountMinor` and asserts the sent body has no such field.
2. **A redirect is not a receipt.** Coming back from the provider with `?reference=` only starts
   a request. `confirmPayment` asks the provider for the transaction, then checks the reference,
   the amount, the currency, the status and the account that owns the checkout. Only then does a
   plan get granted.
3. **A reference is single-use.** `payment_transactions.provider_reference` is unique, so a
   second delivery of the same charge cannot buy a second period - the database, not the service,
   is what refuses it. The Postgres suite proves it with two simultaneous inserts: exactly one
   succeeds and the other is refused.
4. **A webhook is proved by its signature and acted on once.** The signature is checked over the
   exact request bytes (a scoped raw-body parser is installed on the webhook route only), events
   older than the replay window are refused, and a `(owner-or-global, dedupe_key)` unique row
   makes a redelivery a no-op that reports `duplicate: true`.
5. **A workspace only sees its own billing.** Every read is scoped by the caller's owner ref, and
   the owner of a payment comes from the stored intent, never from the incoming payload or a
   header.

## Providers

One interface, three adapters, each declaring the gaps it has:

|                                | Paystack              | Flutterwave             | Monnify                 |
| ------------------------------ | --------------------- | ----------------------- | ----------------------- |
| Hosted checkout                | yes                   | yes                     | yes                     |
| Saves a reusable authorization | yes                   | yes                     | no                      |
| Automatic renewal charge       | yes                   | yes                     | **no** - manual renewal |
| Refund by                      | transaction reference | provider transaction id | provider transaction id |
| Amount unit sent               | minor (kobo)          | minor                   | **major** (naira)       |

The amount unit is converted in exactly one place, and a test asserts the number each adapter
sends. A provider with `recurring: false` is offered honestly: the screen says renewal is manual
and `POST /api/payments/renew` answers with a fresh checkout link instead of pretending to charge.

Adding a provider means one adapter plus a `payment_providers` row. Secrets are never stored in
the database: the row holds the **name** of the environment variable, and the value is read from
the deployment's secret store at call time. Nothing is sent to the browser except a publishable
key, which is `null` in this build.

## Lifecycle

- **Initial purchase** - checkout, verify, grant. The plan change goes through Step 60's
  `subscriptionService.changePlan`, so the entitlement rules stay in one place.
- **Renewal** - `chargeRenewal` refuses before the paid period has ended (taking money for time
  already paid for is not a renewal), then charges the stored authorization, verifies it and calls
  `subscriptionService.renew`, which keeps Step 60's per-period claim. A renewal with no stored
  authorization returns a manual link.
- **Upgrade** - a new checkout with the higher plan; the subscription moves on the verified
  payment.
- **Downgrade** - `cancelAtPeriodEnd` and a fresh purchase for the next period, so nothing is
  refunded silently and no period is shortened.
- **Cancellation** - Step 60's cancel route; the period runs out.
- **Failed payment** - recorded as `failed` with the provider's reason, an invoice marked
  `failed`, and a notice. No privilege is granted.
- **Expiry, grace, reminders** - `policies.grace` (7 days, reminder at 3) is configurable and
  reported on the overview; `renewalsDue` lists what a scheduler should act on, and the scheduler
  is not started here.
- **Reactivation** - a new checkout; a lapsed account can always reach `#/billing`, which is why
  billing sits outside the plan gate.

Nothing is charged silently. Automatic renewal only happens through an authorization the customer
created at checkout by consenting on the provider's own page.

## Invoices and receipts

An invoice is issued when a payment is verified, with a number from an atomic counter
(`billing_invoice_counters`, `INV-<year>-<6 digits>`), so two instances issuing in the same second
still get different numbers. The invoice keeps the plan name, the unit amount, the discount, the
tax and the total **as issued**; editing a price later does not rewrite it (a test asserts this).

`GET /api/payments/invoices/:id/pdf?kind=invoice|receipt` returns a real PDF (written by
`payments/core/src/pdf.ts`, no dependency, paginated). A receipt is the same document marked
`RECEIPT` with its own number. Another account gets `404 INVOICE_NOT_FOUND`.

**Tax is not invented.** A tax row is configured per country (`POST /api/payments/admin/taxes`);
with none configured, no tax is added and the screen says so in words. Nothing in this build
claims tax compliance, and no rate ships as a default.

## Refunds

Three gates, all of them server-side:

1. an operator token (`VELTRAVIA_BILLING_ADMIN_TOKEN`, sent as `x-veltravia-admin` or a bearer),
2. an explicit `approve: true` in the body - a request without it is refused, not queued,
3. the provider's own answer, since the refund is only recorded as `succeeded` after the provider
   accepts it.

A refund cannot exceed the charge minus what was already refunded, and the same provider refund
reference cannot be recorded twice.

The default policy (`none`) leaves the paid period alone: money back, access to the end of the
period. `next-period` and `immediate` exist as configurable alternatives, and each is named on
the screen so a customer is not surprised.

## Operator surface

All of `/api/payments/admin/*` needs the operator token; with none configured the routes answer
`503 BILLING_ADMIN_DISABLED` rather than falling open.

| Route                                      | What it does                                                    |
| ------------------------------------------ | --------------------------------------------------------------- |
| `GET /admin/overview`                      | providers, price rows, recent transactions, event backlog       |
| `POST /admin/providers`                    | enable a provider, set mode and public key                      |
| `POST /admin/prices`                       | set the price for a plan, interval and currency                 |
| `POST /admin/discounts`, `/admin/taxes`    | configure what the quote reads                                  |
| `POST /admin/refunds`                      | approve and execute a refund                                    |
| `GET /admin/events`                        | webhook events with their status and attempt count              |
| `GET /admin/transactions`, `/admin/audit`  | every payment, and the append-only audit trail                  |
| `POST /admin/reconcile`                    | re-read a transaction from the provider and settle what drifted |
| `POST /admin/renewals`, `/admin/reminders` | run what a scheduler would run, on demand                       |

## Environment

| Variable                                               | Meaning                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| `VELTRAVIA_BILLING_ADMIN_TOKEN`                        | operator token; absent means the operator surface is closed       |
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET`       | Paystack credentials (test or live by value)                      |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET` | Flutterwave                                                       |
| `MONNIFY_SECRET_KEY`, `MONNIFY_WEBHOOK_SECRET`         | Monnify                                                           |
| `VELTRAVIA_PUBLIC_BASE_URL`                            | where the provider sends the customer back (the `#/billing` page) |

No secret is ever returned by an API route, logged, or written to a file. There is no card-number
column anywhere: the card is entered on the provider's page, so this deployment is out of PCI
scope for card data and must stay that way.

## What is not delivered

- **No tax compliance.** Rates are configuration; filing, thresholds and reverse charge are not
  modelled, and a rate is never assumed.
- **No credit top-ups.** No route sells AI credits separately from a plan: credits are a plan
  allowance, a ceiling the meter enforces, and the overview states `topUps: false` so a screen
  cannot imply otherwise.
- **No dunning automation.** Grace, reminders and retries are configured and readable, but no
  scheduler is started: whoever operates the deployment decides when `renewalsDue` runs.
- **No proration.** A mid-period upgrade is a new purchase, not a credited difference.
- **No seat model.** A subscription belongs to one owner ref.
- **No operator UI.** The operator surface is HTTP.
- **No workspace billing for other people.** `workspaceId` is carried on the records; there is no
  membership model, so a payment belongs to the account that made it.
- **No mobile in-app purchase.** The Android build reaches the same `#/billing` screen; Play
  Billing is not integrated, and a mobile purchase of a digital plan through the web flow may
  conflict with store policy - that is a product decision, not a technical gap to paper over.

## Known limits

- The in-memory stores are single-process, so a restart forgets them; Postgres is the durable
  path, and the persistence suite runs against it.
- A provider that accepts a refund and then fails to settle it leaves the row `pending`;
  `POST /admin/reconcile` re-reads the provider and settles it.
- The webhook route trusts the provider's signature, not the payload's claim about which account
  it belongs to. An event that names no checkout on this deployment is recorded and ignored, never
  applied to a guessed account.
