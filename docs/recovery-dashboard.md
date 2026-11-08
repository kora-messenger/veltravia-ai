# The recovery dashboard

Step 49 puts the Step 48 recovery records on the operations page (`#/operations`).
It reads; it never diagnoses, plans, repairs or recovers on its own. Every figure is a
count of a stored field, and every control is a route that already existed.

## Navigation

The recovery section is the panel headed **Recovery**, below the Superagent fleet and the
task list. It has three parts: the tally, the filters, and the case table. Choosing a row
opens the case detail; on a phone that detail is a full-screen sheet, closed with **Close**.

## The tally

| tile                  | what it counts                                              |
| --------------------- | ----------------------------------------------------------- |
| Recovery cases        | every case the server returned for the current filter       |
| Awaiting diagnosis    | status `open` or `diagnosing`                               |
| Being repaired        | status `repairing` or `awaiting_verification`               |
| Recovered             | status `recovered`                                          |
| Needs intervention    | status `escalated`                                          |
| Insufficient evidence | cases whose diagnosis declined to name a cause              |
| Attempts used up      | cases that spent every attempt, open or already handed back |

A tile is a filter as well as a count: choosing it re-reads the list from
`GET /api/recovery/cases` with the matching predicate. The server counts, so the numbers
describe the whole set rather than the visible page. When more than 500 cases exist the
panel says it is counting the most recent 500.

## Filters

Status, failure category, verification outcome, worker, project and a since-date, all
applied by the server (`GET /api/recovery/cases` and `GET /api/recovery/overview`). An
unknown status or category is a `400 RECOVERY_FILTER_INVALID` rather than an empty list, so
a bad filter is visible instead of looking like "no cases".

## Case detail

- the case id, the original task id, the failed worker and its type;
- the failure category, and the number of attempts used against the limit;
- **What was observed** - worker status, its own reported failure, declared against produced
  deliverables, the verification state at failure. Read from the worker's record.
- **What the Primary Agent concluded** - category, confidence, likely cause, the reason, the
  affected deliverables, the recommended action and each piece of evidence by kind and ref.

The two columns are separate on purpose: facts first, inference second, and the inference
names the evidence it used.

### When the diagnosis declined

A case whose diagnosis is `insufficient_evidence` shows that code, the engine's own reason
and one sentence: the case needs a person. No cause, confidence or recommendation is
shown, because none was established. The interface never fills that gap with a guess.

## Repair attempt history

Every attempt, oldest first, with its number, outcome, the wait before it started, the child
task it ran on, the repair Superagent, start and end times, the verification run and the
change set. The header states `used of max · remaining`, and the section says plainly that
each repair runs on its own child task under the failed one and that the limit is the
engine's.

The child task is resolved through the attempt's worker record (`worker.taskId`), so what
is shown is the task the work actually ran on.

## Verification evidence

The stored run: id, status, how many commands executed, the failing operations, and each
piece of evidence. `executed: false` is shown as "Nothing was executed", and the panel says
that such a run cannot support a recovery.

**A case is only displayed as Recovered when the stored run both executed and passed.** If
the record claims `recovered` without that, the panel shows _Awaiting verification_ with a
warning explaining why. The client never decides recovery; it refuses to repeat a claim the
evidence does not carry.

## Management actions

| action                          | route                                  | notes                                                |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Re-read case                    | `GET /api/recovery/cases/:id`          | always available                                     |
| Diagnose again                  | `POST /api/recovery/cases/:id/analyse` | re-reads stored evidence, starts nothing             |
| Cancel recovery                 | `POST /api/recovery/cases/:id/cancel`  | confirm first; refused cases show the server's words |
| Open task / worker / change set | existing dashboard panes               | navigation only                                      |

There is deliberately no repair button, no "retry now" and no attempt-limit override. Those
decisions belong to the engine and its budget, and the dashboard does not widen them.

## Cancellation and escalation

Cancel asks once, in place, and then reports what the server said. An escalation block shows
the reason, the message, what was already attempted and what is still not done - so "needs
intervention" always arrives with the reason it needs a person.

## Live updates

The page polls every 5 seconds (paused when the tab is hidden or the owner pauses it) and
has **Refresh now** and **Refresh recovery** for a manual read. There is no push stream for
these records, so the page says "Refreshes every 5s" instead of claiming to be live. An open
case is re-read when the dashboard's read clock moves or the case's `updatedAt` changes, so
progress appears without a second loop.

Notifications fire once per transition - a diagnosis appearing, a repair being assigned, an
escalation, an exhausted budget, a verified recovery, a cancellation. Routine progress is
not announced, because it is visible on the page and would otherwise toast on every poll.
On the first read nothing is announced: the baseline is not news.

## Known limitations

- No repair, approve or attempt-limit control from the page (by design).
- The tally is computed by listing cases, capped at 500 and labelled when truncated; there is
  no dedicated count query yet.
- No push stream: the page polls.
- Phase-level verification details (per test pass/fail counts, build vs lint vs typecheck
  separately) are shown as operation outcomes, not as a per-test breakdown.
- There is still no real authentication; the owner header is a development stand-in.
