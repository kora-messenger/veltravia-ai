# Message credits

Step 54. What one AI interaction costs in Veltravia credits, how the charge is held
before the work starts, how it is settled against what was actually measured, and
what the system does when a number is missing.

Message credits are **not** a second wallet. They are one charging policy that
spends the wallet from Step 53, so there is exactly one ledger of credit and one
place it can be reconciled.

## The two layers

| Layer           | Question                                                             | Step |
| --------------- | -------------------------------------------------------------------- | ---- |
| Usage metering  | How much infrastructure did this consume? (tokens, wall clock, jobs) | 52   |
| Credit wallet   | What does the balance look like, and what moved it?                  | 53   |
| Message credits | What does _this interaction_ cost, decided before it runs?           | 54   |

Metering measures, the wallet moves credit, and message credits price an
interaction and drive the wallet. A usage event is billed once by its own key; a
message charge is billed once by its own key. They are different keys on purpose,
and `POST /api/message-credits/integrity` reports any charge that claims a wallet
entry the wallet does not have.

## Interaction kinds

`chat.message`, `chat.assistant`, `coding.run`, `agent.execution`, `tool.call`,
`background.task`.

Not every kind is separately billable. A tool call that happens inside a chat turn
is recorded on that turn's charge (`toolCalls`) rather than priced again, because
charging both would bill one interaction twice. The shipped table marks tool calls
as part of their parent.

## Rates are configurable defaults, never market prices

`GET /api/message-credits/policy` returns the whole table and a `defaultsOnly`
flag. While the flag is true the dashboard says "shipped defaults"; once a
deployment supplies `VELTRAVIA_MESSAGE_RATES`, it says "configuration". Nothing in
this repository claims a commercial price, and no rate is derived from a provider's
invoicing.

Two dimensions exist:

- **flat** credits per interaction (`flatCredits`)
- **usage** credits per 1,000 tokens (`per1kInput`, `per1kOutput`, `per1kCached`)
  and per tool call (`perToolCall`)

A policy can also carry a model override, so a large model can cost more without
changing the interaction kind. Plans carry their own table; the development plan
is non-billable, so everything it does is recorded as `exempt` with zero credits
and a visible reason.

## Estimates are honest about what they do not know

An estimate is the flat part plus tokens the caller actually declared. It is
marked `lowerBound: true` whenever the prompt size is unknown, because inventing
an expected token count would produce a number that looks authoritative and is
not. The chat UI shows the estimate before sending and warns when the balance
cannot cover it.

## Measurement: a missing number is not a zero

The charge records what was measured and what was not:

- `tokens-unavailable` - no input token count was reported
- `output-tokens-missing` - no output token count was reported
- `tool-calls-unavailable` - the provider did not say how many tools ran
- `duration-unavailable` - no wall clock
- `provider-not-reported` - no provider identifier
- `byok-tokens-excluded` - the tokens belong to the caller's own key, so only the
  flat platform part was charged

Unreported **cached** tokens are deliberately not a limitation: those tokens are
already inside the input total and are charged at the input rate, which is the
higher of the two, so silence there cannot understate a charge.

If tokens are missing and the policy is usage-based, only the explicitly
configured flat part is charged, and the limitation is stored on the charge. The
system never fills a gap with a guess.

## Lifecycle

```
reserve ──▶ reserved ──commit──▶ committed ──refund──▶ refunded
                 │                     ▲
                 │                     └── reversal (wallet mechanism)
                 ├──release──▶ released
                 └──sweep (hold older than the TTL)──▶ released
exempt (non-billable plan, or BYOK under a policy that does not charge BYOK)
failed (the provider or the run failed before any charge was measured)
```

- `reserved` holds credit in the wallet; it is not a charge yet.
- `committed` settled the hold against the measurement. A hold is a **floor**: if
  the measured charge exceeds it, the difference is drawn from available in the
  same atomic wallet transition, and the charge records whether that top-up was
  covered. Nothing can overdraw.
- `released` returned the hold after a failure, a cancellation or an abandoned
  operation.
- `refunded` returned a committed charge through the wallet's refund entry, capped
  at what was charged, single use.
- `exempt` is a recorded interaction with zero credits and a stated reason.

Releasing and committing are idempotent: the second call returns the same charge
and moves no credit. That is what makes a retried request safe.

## Idempotency and restarts

Every charge carries an idempotency key. Chat reserves under
`chat:<client idempotency key>` when the client sends one, so a retried send is one
interaction. Settlement uses the wallet's own `commit:<reservation>` key, and a
second settlement is refused by the wallet rather than by application logic.

Charges live in `message_charges` (migration 013), which is what makes a restart
safe: a reservation taken before a restart is still readable afterwards, and
`POST /api/message-credits/sweep` releases holds whose operation never came back.

## BYOK

Every provider call in this deployment uses the caller's own key. A BYOK
interaction is therefore never charged for its **tokens**; under the shipped paid
policy the platform's flat charge still applies and the charge says
`byok-tokens-excluded`. A deployment that must not charge BYOK at all sets
`chargeByok: false` on the policy, and the interaction becomes `exempt` with zero
credits.

## Spending controls

`GET`/`PUT /api/message-credits/settings` store a monthly limit and a per-request
limit, per owner and per workspace. They are enforced server-side, in this order:

1. per-request limit - `400 REQUEST_LIMIT_EXCEEDED`
2. monthly limit - `402 MONTHLY_LIMIT_REACHED`
3. balance - `402 INSUFFICIENT_CREDITS` with the shortfall

A refusal is recorded as a `released` charge with a reason, so a user can see that
a request was refused for credit rather than losing it silently. The chat keeps the
typed message in the composer.

## Who can do what

- Reading a balance, charges, usage and integrity: the owner, scoped to their own
  records and workspaces.
- Refunds: an operator, with the subject named in both the body and the owner
  header. A mismatch is `400 OWNER_MISMATCH`.
- Pricing: the policy table only. There is no API that lets a client choose a
  price.

## Not delivered

- Payment processing, checkout, receipts or real-money purchases of message
  credits. Credits are added by an operator endpoint.
- Token-based rates do not bite yet in this deployment, because every provider
  call uses the caller's key and BYOK charges the flat part only. They apply to a
  managed-key deployment.
- Coding runs and agent executions have policies and can be reserved through the
  API, but only the chat path is wired end to end today.
- No scheduled sweep; `POST /api/message-credits/sweep` is an operator/ops call.
- No provider-reported cached-token capture from the gateway yet, so
  `cachedTokens` is usually null and input tokens are charged in full.

## Where things live

- `message-credits/core` - kinds, policies, estimate, measurement, lifecycle
- `storage/postgres/src/repositories/message-credits.ts`, migration `013`
- `apps/api/src/message-credit-service.ts`, `routes/message-credits.ts`
- `apps/web/src/pages/operations/MessageCreditsPanel.tsx`
