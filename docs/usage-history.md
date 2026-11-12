# Usage history and cost dashboard

Step 58. One page that answers "what have I used, what did it cost, and where did it
come from", over records Steps 52 to 57 already write.

This step adds **no ledger, no price table and no new charge**. Balances stay in the
credit wallet, charges stay in the message, integration and infrastructure records, and
this layer only reads them, merges them and explains them.

## What existed, and what was missing

By the end of Step 57 there were four panels on the operations page: the wallet ledger,
message credits, integration credits and infrastructure usage. Each answered its own
question correctly. What nobody could do was see one history: the panels did not share a
date range, a category filter or a page, an integration charge and a chat charge could not
be compared in one list, and there was no way to take the data out.

The gaps this step closes:

| Gap                                     | What the code now does                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| Two charge lanes, two lists             | One merged, ordered feed across message, integration and infrastructure records |
| Only one filter (`workspaceId`, `kind`) | Date range, category, status, project, model, provider and text search          |
| Offset paging that drifts               | A per-lane keyset cursor (`beforeAt` + `beforeId`) in the stores                |
| No trend, no breakdown                  | `GET /api/usage-history/breakdown` over seven dimensions                        |
| No export                               | `GET /api/usage-history/export.csv`, same filters, same rows                    |
| Holds and charges looked alike          | Every event carries a `movement`, and only a deduction counts as credits        |

## The four rules the code follows

**1. Balances come from the wallet.** `overview.wallet` is the wallet service's own
answer (`available`, `reserved`, `spent`, `spendable`) copied through. Nothing in
`apps/api/src/usage-history.ts` adds charges up to produce a balance, because a second
way of computing the same number is a second number.

**2. Totals come from the charge records, and say when they are partial.** Two lanes are
read up to a cap (`VELTRAVIA_USAGE_HISTORY_SCAN_CAP`, default 5000 rows). When the cap is
reached the response sets `completeness.complete: false` with a note naming how many rows
were read and that the totals are a partial sum. A page that was cut in half is partial
even if the lane happened to have reached its end.

**3. A movement is not a number.** `movementOf()` maps a charge's state to one of
`deduction`, `reservation`, `release`, `refund`, `no-charge` or `measurement`. A reserve
posts a hold, so it contributes an event with `credits: 0` and `status: 'reserved'`;
releasing a hold is its own event with `credits: 0`; a refund says `refund`. Only
`deduction` moves `credits`. When a settled charge exceeds the hold, the difference is
drawn from the wallet in the same transaction (Step 54) and the event reports the settled
figure.

**4. Credits are not money.** Nothing converts a credit to a currency. `pricing.note`
carries the catalog version and whether the policy is defaults-only, and the page prints
both.

## Categories

`USAGE_HISTORY_CATEGORIES` maps a person's words onto the stored charge kinds:

| Category         | Stored kinds                      | Source                |
| ---------------- | --------------------------------- | --------------------- |
| `ai_messages`    | `chat.message`, `chat.assistant`  | `message_charges`     |
| `coding`         | `coding.run`                      | `message_charges`     |
| `agents`         | `agent.execution`, `agent.run`    | `message_charges`     |
| `reasoning`      | `reasoning.run`                   | `message_charges`     |
| `tools`          | `tool.call`                       | `message_charges`     |
| `background`     | `background.task`                 | `message_charges`     |
| `integrations`   | connector and integration charges | `integration_charges` |
| `infrastructure` | `recordUsage()` measurements      | `usage_records`       |

Infrastructure is left out of the unfiltered feed on purpose: a bandwidth sample is
written once a minute per owner and would bury the charges. It is always visible in the
overview's measurement strip, and asking for it returns it.

## Routes

All reads are scoped to the caller's owner reference; a request cannot name another
account.

| Route                                          | What it answers                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/usage-history/capabilities`          | The categories, dimensions, scan cap and the notes this layer will not break                                                         |
| `GET /api/usage-history/overview`              | Wallet balance, current billing period, the selected range, recent events, infrastructure strip, wallet ledger summary, pricing note |
| `GET /api/usage-history`                       | One filtered page of events with `total`, `hasMore` and `nextCursor`                                                                 |
| `GET /api/usage-history/breakdown?dimension=…` | Groups by `category`, `project`, `model`, `provider`, `day`, `month` or `activity`, plus the largest charges                         |
| `GET /api/usage-history/export.csv`            | The same filtered rows as a CSV attachment                                                                                           |

Shared query parameters: `from`, `to` (UTC `YYYY-MM-DD`), `category` (comma separated),
`status` (comma separated), `projectId`, `modelId`, `providerId`, `q` (case-insensitive
over id, model, provider, project and kind), `workspaceId`. The history route adds `limit`
(1 to 200, default 25) and `cursor`.

Errors are explicit rather than empty: `INVALID_RANGE` for a backwards range or one longer
than 366 days, `INVALID_FILTER` for a category or status this build does not have,
`INVALID_DIMENSION` for a breakdown it does not offer, `INVALID_CURSOR` for a page link it
cannot read. A filter nobody recognises is refused instead of being dropped, because
silently returning everything is how a person believes they narrowed something.

## Paging

The stores order `created_at desc, id desc` and accept a keyset boundary:

```ts
{ beforeAt: '2026-11-12T18:41:18.786Z', beforeId: 'mch_mwdw94n6_7' }
```

The cursor the API hands back is not a single id, because the feed merges lanes whose ids
are not comparable. It records, per lane, the last row shown, so that lane continues
strictly below its own row, and a lane that contributed nothing continues below the
timestamp itself. This is what stops a page from repeating or skipping a charge when
several settle in the same millisecond — the first implementation carried a prefixed id
(`charge:…`) into a comparison against raw ids, which made page two silently empty.

`total` is asked for separately, without the boundary, so it does not shrink page by page.

## Export

`GET /api/usage-history/export.csv` returns `text/csv` as an attachment, no-store,
`nosniff`, capped at 10 000 rows (`exportCap`, never below the scan cap). The response
carries `x-veltravia-export-rows`, `x-veltravia-export-truncated` and
`x-veltravia-export-window`, because a spreadsheet cannot carry a caveat: a truncated file
says so in a header and in the UI, not only in the last row.

Columns: `occurred_at`, `settled_at`, `category`, `activity`, `detail`, `status`,
`movement`, `credits`, `estimated_credits`, `model`, `provider`, `provider_charge`,
`project_id`, `workspace_id`, `run_id`, `task_id`, `execution_id`, `conversation_id`,
`unit`, `quantity`, `input_tokens`, `output_tokens`, `cached_tokens`, `requests`,
`duration_ms`, `pricing_policy`, `pricing_basis`, `limitations`. A value containing a
comma, a quote or a newline is quoted; a field that was not measured is empty rather than
zero.

## The page

`#/usage` ("Usage & cost"), reachable from the sidebar and the drawer. Four summary cards
(available, held, spent, refunded in range), the filters, usage by category as bars, daily
credits as a compact bar chart, the history table, the largest charges, the measured
infrastructure strip, and this billing period's figures.

It uses the existing design system and needs no new navigation: the route is one entry in
`ROUTES` and one case in the app shell. Below 900px the two-column grid becomes one column,
and below 640px the six-column table becomes labelled blocks, so a phone reads one record
at a time instead of scrolling sideways.

Loading, empty, error and partial states are all real: a failed read shows the server's
message with a retry, an empty range says so, and a partial sum is announced above the
table.

## Tests

`apps/api/src/usage-history.test.ts` (14 tests, one Postgres-gated block):

- the balance shown is the wallet's;
- category grouping and its totals agree;
- a reservation, a deduction, a release and a refund read differently, and a hold
  contributes no credits;
- date, project, model and status filters narrow the rows, and a range before anything
  happened is empty rather than everything;
- paging with a cursor neither repeats nor skips, including same-millisecond charges;
- the scan cap turns a total into a stated partial sum;
- a charge with no measurement still shows its price and says what was not measured;
- the CSV carries the filtered rows and quotes what needs it;
- infrastructure records are measurements, not credits, and claim no total;
- a backwards or over-long range is refused;
- every route read is scoped to the caller, and another owner's export has a header and no
  rows;
- an invented category is a 400;
- (with `VELTRAVIA_TEST_DATABASE_URL`) the range and search filters narrow a real
  `message_charges` table, so they are in the SQL and not in the browser.

`apps/web/src/pages/usage/UsageHistoryPage.test.tsx` (7 tests): the wallet figures printed
from the overview, the partial-sum note, the three movement labels with a measurement in
its own unit, filters sent to the server, cursor paging that appends, the CSV link, and
the empty and error-with-retry states.

## Not delivered

- No payment processing, invoices or real-money purchase; credits still arrive through the
  operator route.
- No workspace credit allocation or membership: `workspaceId` narrows reads, it does not
  fund anything.
- Infrastructure measurements are floors, not full costs: bytes written by another process
  or served by a CDN never pass through this API.
- Token counts are only present when the provider reported them; the row says
  `Not measured: …` instead of estimating.
- The dashboard reads up to the scan cap per aggregation. A deployment with a longer
  history raises `VELTRAVIA_USAGE_HISTORY_SCAN_CAP`; beyond that the note says the sum is
  partial.
