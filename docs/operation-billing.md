# Operation billing

Step 55. How a coding run or an agent worker, which may call a model many times, is
billed as **one** interaction rather than once per model call, and how the numbers on
that charge are measured when the work is done.

This builds on the charging policy of Step 54 (`docs/message-credits.md`) and the
wallet of Step 53 (`docs/credit-wallet.md`). It adds no new purse and no new rate
table: it decides _which_ operation pays and _when_.

## The problem it solves

A coding run makes one model decision per phase, and a worker makes one per turn for
as long as it is allowed to run. Charging each call separately would:

- produce a dozen small charges where a person did one action, and
- take a hold per call, so a run could be refused half way through work that was
  already paid for.

So the run, not the call, is the billable unit.

## The lifecycle

| Moment                  | What happens                                                        |
| ----------------------- | ------------------------------------------------------------------- |
| Before planning         | `POST` hold: one charge, state `reserved`, priced from the estimate |
| Every model call        | Tally only: input, output, cached tokens and tool calls accumulate  |
| Terminal state          | Settle: the tally becomes the charge, the state becomes `committed` |
| Cancel, refusal, stall  | Release: the hold returns to available, the charge reads `released` |
| Nothing ever comes back | The sweep releases the hold after its TTL                           |

The operation id is the key. Every model call that belongs to the run carries it, and
the tally is keyed on **that id alone**. Keying it on the id _plus_ the workspace was a
real defect: the model call does not know the workspace, so its tokens landed in a
different entry from the one settlement read, and every run settled as a flat estimate
with no token numbers at all.

## Cached tokens

A provider that serves part of a prompt from its own cache reports how many input
tokens were cached. Those tokens are inside the input count, so they are billed at the
cache rate and the difference is recorded on the charge, not subtracted twice:

- `inputTokens` is everything the provider says it read,
- `cachedTokens` is the part of that which was cache hits,
- `cachedSavings` is what the cache rate saved, in credits,
- `measurementSource` says who reported the numbers (`provider`, `estimate`,
  `unavailable`).

A charge with no measurement says `unavailable` and lists its limitations. It is never
recorded as zero usage, because zero means "measured, and it was nothing".

## Which purse pays

A workspace id on a charge is a reporting label, not a second wallet.

- A workspace wallet that somebody has funded pays for its own work.
- An unfunded workspace wallet defers to the account holder's wallet.

The second rule exists because nothing in the product moves credit into a workspace
automatically. Reserving against an empty workspace wallet refused every coding run and
worker on accounts that held plenty of credit, which is not a billing decision anyone
made; it was a bug wearing one.

The decision sticks for the life of the charge: taking a hold moves `reserved` above
zero, so the purse it came from reads as funded and settle and release resolve the same
wallet.

## What is on the dashboard

`#/operations` shows, for the current month:

- credit spent, refunded and the number of charges,
- tokens measured: input uncached, input cached (at the cache rate) and output,
- credit held by charges that have not settled yet, with how many are open.

The token figures come from settled charges only, and BYOK charges are excluded because
their tokens were paid for on the user's own key.

## Not delivered

- No payment processing, and no flow that funds a workspace for somebody else.
- Token rates only bite when the deployment holds the provider key (managed key). A
  BYOK run is charged its flat policy amount and marked `byok-tokens-excluded`.
- The sweep is still on demand, not a scheduled job.
