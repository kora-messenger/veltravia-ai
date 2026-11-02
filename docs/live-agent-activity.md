# Live agent activity

The chat no longer hides the work behind a spinner. A run now reports what it is
doing, step by step, and the page draws that record: one quiet line while it
works, the rows underneath, and a report when it stops.

Two rules shape the whole feature:

1. **The server says what happened.** The browser never invents a phase, never
   guesses that a step finished, and never turns a refusal into a failure.
2. **A finished thing stays finished.** A row that has completed cannot be
   reopened by a late or duplicated event.

## The event

`packages/shared/src/agent-activity.ts` is the single contract. Both sides import
it, and both validate against it at their edge, so a malformed row is dropped at
the boundary instead of reaching the screen.

| Field                      | Meaning                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `eventId`                  | Unique per published state (`<activityId>:<status>`), used for de-duplication.                        |
| `activityId`               | The step's identity, stable across its status changes.                                                |
| `parentActivityId`         | Set when the row belongs to a group (a change set).                                                   |
| `category`                 | Closed vocabulary: `thinking`, `reading`, `editing`, `running_tests`, `building`, `executing_tool`, … |
| `title`                    | Ordinary words, derived from the tool that ran: "Read package.json", "Ran the tests".                 |
| `status`                   | `running`, `succeeded`, `failed`, `cancelled`, `awaiting_approval`.                                   |
| `safeInput` / `safeOutput` | Scrubbed, bounded renderings of the command and its result.                                           |
| `error`                    | `{ code, message }` when the step failed.                                                             |
| `durationMs`               | Measured, not estimated; `null` until the row ends.                                                   |

A **snapshot** carries those rows plus `sequence`, `runStatus`, `terminal` and an
optional final `report`. A **final report** carries what was done, which files
changed, which checks actually ran, what failed, what was recovered and what is
still open.

## Endpoints

| Method | Path                                              | Purpose                                                       |
| ------ | ------------------------------------------------- | ------------------------------------------------------------- |
| `GET`  | `/api/reasoning/runs/:id/activity?after=N`        | Everything after sequence `N`. This is what a reconnect uses. |
| `GET`  | `/api/reasoning/runs/:id/activity/events?after=N` | Server-sent events, one per published row.                    |

Both are owner-scoped and both refuse an unknown run with a typed error rather
than an empty list. The stream sends only rows the client has not already been
given, so a reconnect with `after=<last sequence>` resumes without replaying the
whole run.

## How a row is made

`reasoning/core/src/activity.ts` derives rows from the engine's own steps, in one
place, so the browser never has to interpret a tool id:

- the category comes from the tool that ran, and for a sandbox command from the
  command itself (`vitest` → running_tests, `eslint` → linting, `tsc` →
  validating, `npm install` → installing_dependencies);
- the title is a past-tense verb and the thing it acted on, taken from the
  arguments, never from model prose;
- consecutive file changes collapse into one group ("Updated 2 files") that opens
  onto its members, so eight writes read as one line instead of burying the run;
- `Command` and `Output` are the scrubbed, bounded renderings: reasoning traces
  and secrets are removed by `scrubReasoningText`, and each block is capped
  (1200 characters for the command, 4000 for the output) with an explicit
  truncation marker.

Nothing here streams hidden chain-of-thought. The titles and summaries describe
what ran; they do not narrate what the model was thinking.

## What the page shows

- **Before the server answers**: "Thinking". No timeline, because nothing has
  happened yet. That first request needs the network, so if it fails there the
  failed question comes off the screen, the words go back into the box exactly as
  typed, and the warning takes its place: a pale tile with no brand mark,
  "Something went wrong", one plain reason line ("Network Error" when the device
  is offline) and a Retry control. Retry sends the words it kept, so nothing typed
  is lost; editing them in the box and pressing send is the ordinary path.
- **While it works**: a spinner and the current row's words, with the count of
  steps beside it. The rows are listed underneath and the whole list collapses
  behind one toggle.
- **When it stops**: the spinner stops, and the header states the outcome in
  words that match the facts:
  - a failed run says "Finished with a failure";
  - a completed run that lost a step says "Finished with one failed step" (or
    "… with 3 failed steps"), because the task finished even though a step did
    not;
  - a refusal says "Stopped".
- **The report**: outcome, what was done, files changed, the checks that really
  ran, what failed, what was recovered, what is still open. Checks that never ran
  are left out rather than reported as passing.

The marks are real knockouts: the glyph is punched out of its block with an SVG
mask, `</>` for a command that succeeded, replaced by the failed chip when it
failed, a tick when a step had nothing to run, and a muted block for work that was
refused so red stays reserved for work that ran and broke.

## Reconnecting

`RunFollower` (`apps/web/src/pages/chat/followRun.ts`) opens the stream, reads the
snapshot once at the start, and keeps reading it on an interval as a safety net.
If the stream drops, the page says it is reconnecting and that nothing was
restarted, then resumes from the last sequence it saw. If the device goes offline
it says the run continues on the server. A run that ends is never polled again.

Every update goes through `mergeAgentActivities`, which de-duplicates on
`eventId`, orders by `sequence`, refuses to reopen a finished row, and keeps the
server's status when two events disagree.

## Testing

| Area                                          | Where                                                    |
| --------------------------------------------- | -------------------------------------------------------- |
| Contract, validation, merge, report parsing   | `packages/shared/src/agent-activity.test.ts`             |
| Derivation, groups, scrubbing, ceilings       | `reasoning/core/src/activity.test.ts`                    |
| Snapshot route, SSE route, owner scoping      | `apps/api/src/reasoning/activity.test.ts`                |
| Timeline rendering, marks, groups, honesty    | `apps/web/src/pages/chat/AgentActivityTimeline.test.tsx` |
| Reconnect, missed rows, ceilings, ordering    | `apps/web/src/pages/chat/followRun.test.ts`              |
| Thinking, offline, timeout, refusal, one send | `apps/web/src/pages/chat/ChatPage.test.tsx`              |
| Report wording                                | `apps/web/src/pages/chat/FinalReportCard.test.tsx`       |

## Known gaps

- Run state is in-process. Restarting the API loses the runs, so a page holding an
  old run id after a restart finds nothing and says so.
- The simulated provider does real work but no model work, so a simulated run
  produces a single `thinking` row. The richer rows in the screenshots come from a
  recorded run fixture (`docs/qa/`), not from a live coding run.
- No provider name is ever shown in the timeline or the report; the UI chip stays
  neutral.
- Approval pauses are surfaced as a row and a header state. Acting on the approval
  still happens in the reasoning workspace.
