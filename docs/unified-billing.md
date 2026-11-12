# Unified billing (Step 57)

Steps 52 to 56 each answered one question: what did this deployment spend on
infrastructure (52), what does a unit of platform work cost in credits (53, 54),
how is one long-running operation charged once (55), and how is third-party work
priced and kept separate (56). Each of those built its own correct answer, and
three important things were still true afterwards:

1. Some operations that cost Veltravia money were never priced at all. A reasoning
   run and an agent run made real provider calls and were billed by nobody.
2. Nothing asked whether an account could afford an operation before starting it.
   A zero-balance account could start work, fail halfway, and leave the platform
   paying for it.
3. The three infrastructure categories Step 52 published as "not measured" stayed
   unmeasured, and there was no way to compare what the ledger says was spent
   against what the wallet actually holds.

This step is the coordinator over the existing engines. It does not introduce a
second wallet, a second price table or a second ledger. It reads them, decides
whether an operation may start, and reconciles them against each other.

## What may be billed

`GET /api/billing` publishes the registry. Every operation is one of four things:

| Operation                | Treatment                   | Lane                                                                      |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------- |
| `chat`                   | charged (`chat.message`)    | held before the provider call, settled from reported tokens               |
| `coding`                 | charged (`coding.run`)      | one charge per run, every model call tallied into it                      |
| `worker`                 | charged (`agent.execution`) | held before the worker starts, settled on review accept                   |
| `agent-run`              | charged (`agent.run`)       | held before the agent loop, settled at a terminal state                   |
| `reasoning`              | charged (`reasoning.run`)   | held before the engine starts, settled from reported run usage            |
| `connector`              | charged                     | Step 56 lane, priced by the integration catalog                           |
| `background-job`         | metered                     | job count and concurrency only: the planner makes no paid call of its own |
| `document-job`           | BYOK exempt                 | runs on the caller's own key; metered, not charged                        |
| `intelligence-synthesis` | BYOK exempt                 | same policy                                                               |

"Charged" means a hold is taken from the same wallet, settled from the same price
table, and the result appears in the same charge ledger as everything else.
"Metered" means the operation is counted for quota purposes and recorded, but no
credit is owed. "BYOK exempt" is metered and explicitly exempt with a reason, never
a silent zero.

## The gate

`unifiedBilling.open()` is the only way a new billable operation starts. It:

1. Resolves the operation's definition. An unknown operation is refused, not
   guessed at (`BILLING_UNKNOWN_OPERATION`).
2. Returns an uncharged handle when the operation is metered or exempt, so a BYOK
   path is never accidentally charged.
3. Opens the wallet if the account has never had one. A missing row is not the
   same as a wallet that cannot pay.
4. Asks for a price before asking for money, so the refusal names the shortfall
   instead of saying "reserve failed".
5. Takes the hold through operation billing (Step 55), which is idempotent on the
   operation id.

A refusal is HTTP **402 `BILLING_INSUFFICIENT_CREDITS`** and carries the operation,
its label, the credits required, what the wallet has, the shortfall, the plan, and
the list of things the person keeps: projects, files, settings and conversation
history. The operation never starts, so nothing is spent.

### What a zero balance does not do

It blocks chargeable work only. Reading projects, browsing files, changing
settings, exporting source and every free path keep working. Delegated work is not
destroyed: a refused worker keeps its task and its checkpoints, and the agent
reports which operation was refused and what it needed. No step silently bypasses
billing by choosing a cheaper unauthorised route.

## Lifecycle

```
open (hold) -> record (usage, as it happens) -> settle | release
```

- **settle** charges the measured usage, or the estimate when the provider reported
  nothing measurable, and states which one it used.
- **release** returns the whole hold. It is called on cancellation, provider
  failure, a timeout, a refused review and a worker crash.
- A hold that outlives its operation is released by the Step 56 scheduled sweep, so
  a process that dies mid-operation cannot strand credit.
- Idempotency is the operation id, so a retried request, a duplicated event or a
  restarted worker finds its existing charge instead of paying twice. Settlement is
  a single transition: a charge that is already committed cannot be committed again.

The routes that hold credit keep the handle in a small tracker keyed by run id, so
wherever the work actually ends (success, failure, cancel, restart) the matching
settle or release runs against the same charge. That is why an agent run started in
`POST /api/agents/run` can be settled from a long-running completion rather than
from the request that opened it.

## Infrastructure metering

Three categories that Step 52 published as unmeasured are now measured, and only
because this deployment observes them. The capability table asks the server (the
`observedCategories` option) instead of hardcoding a status, so a category cannot
claim to be measured on the strength of a code change alone.

| Category       | What is measured                                                                           | What it is not                                                              |
| -------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `file_storage` | bytes accepted by the upload handler, released when the file is deleted                    | bytes written outside those handlers                                        |
| `bandwidth`    | request and response bytes as they pass through this API, accumulated per owner per minute | CDN-served assets, provider egress, traffic that never reaches this process |
| `realtime`     | streams this API opens itself: count, duration and events, recorded on close               | a connection held by a future hosted runtime                                |

Bandwidth is sampled rather than written per request: one record per owner per
minute, flushed on a timer (`VELTRAVIA_BANDWIDTH_SAMPLE_SECONDS`, default 60, `0`
disables). A per-request ledger row would be unreadable and would dwarf the usage
it describes.

`recordUsage()` on the Step 52 service is the seam for these numbers, and it refuses
what it cannot stand behind: no operation key, a negative or non-finite quantity, or
an unknown category throws instead of writing a row. A size the file manager never
recorded is measured as nothing rather than as zero.

Two bugs the metering work surfaced, both silent before:

- The stored-bytes gauge read `byteLength` on a file asset, which does not exist -
  the number is at `metadata.byteSize`. The gauge had been a permanent zero while
  looking measured.
- `usage.records(ownerRef)` filtered by nothing on the in-memory store, so an
  in-process deployment answered one account's request with another's rows.

## Reconciliation

`GET /api/billing/reconcile` compares the lanes for one account and reports
`consistent` with the evidence it checked:

- the ledger sums behind the wallet's stored balances, with any problem it finds
  listed rather than averaged away;
- every committed message charge names a wallet entry that exists;
- every committed integration charge names a wallet entry that exists;
- the open holds on the account, so a reservation that outlived its operation is
  visible as a number instead of a suspicion.

Reconciliation never moves money. It reports, because a mismatch means a bug worth
seeing, not a number worth quietly correcting.

## Reading the numbers

`GET /api/billing/usage` is the fleet view for operators: the operation registry,
the live meter (streams open, buffered bytes), the per-category records with their
measurement source, and the plan limits that apply. Together with the wallet panel
and the charge ledger, a person can tell a **hold** from a **charge** from a
**release** from a **refund** - four different things that used to look alike.

## Not delivered

- No payment processing or real-money credit purchase. Credits still arrive through
  the operator route; checkout belongs to a payments integration.
- `document-job` and `intelligence-synthesis` have no Veltravia price, so they stay
  exempt. The extension point is `unifiedBilling.open()` from the job start once a
  price exists.
- Bandwidth and storage are floors, not full cost accounting: anything served by a
  CDN or written by another process is invisible here, and the capability notes say
  so.
- The owner of file traffic is the deployment's default owner, because this build
  has no real auth layer in front of the file routes. A real auth layer passes the
  caller through the same seam.

## Tests

- `apps/api/src/unified-billing.test.ts` - registry, refusal reasons, idempotency,
  release on failure, reconciliation of each lane.
- `apps/api/src/infrastructure-metering.test.ts` - storage add/release, bandwidth
  sampling and owner separation, realtime streams, and the numbers the meter
  refuses.
- `apps/api/src/billing-wiring.test.ts` - through the real app with Postgres: the
  registry, a reasoning run refused at a zero balance before it exists, an agent
  run that settles once, a hold released when nothing ran, an upload measured and
  released, the stored-bytes gauge, and reconciliation of a freshly billed account.
