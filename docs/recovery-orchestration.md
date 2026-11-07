# Autonomous repair, retry and recovery

Step 48. A Superagent that fails is now diagnosed, repaired within limits, and either
recovered on evidence or handed back to the owner. Nothing here claims success it cannot
prove.

## What a case is

A **recovery case** is one failed unit of work and everything done about it. It is created
by `POST /api/recovery/cases`, which reads the worker and its task, records what failed,
classifies it and stops where the evidence stops.

```
open ──► repairing ──► recovered
  │           │
  │           ├──► escalated   (budget spent, or the evidence says "not mine to fix")
  └──────────► escalated
              cancelled       (the owner stopped it)
```

A case is only `recovered` when a stored verification run passed **and** the repair's
change set is either integrated or explicitly preserved. A worker saying it is done is not
evidence, and neither is a case record that says so.

## How failure is classified

`@veltravia/recovery-core` classifies from observed facts only: the worker's status, its
failure code, how many deliverables it declared against how many exist, the review's
refusals, whether verification ran and what it said, and the attempt history.

| category                            | what makes it fire                              | class       |
| ----------------------------------- | ----------------------------------------------- | ----------- |
| `missing_deliverables`              | declared deliverables that do not exist         | permanent   |
| `unverified_completion`             | claimed completion, no passing verification run | permanent   |
| `verification_failed`               | a run that executed and did not pass            | retryable   |
| `timeout` / `cancelled` / `blocked` | the worker's own terminal status                | retryable   |
| `permission_refused`                | the server refused for policy                   | policy      |
| `change_conflict`                   | the change set could not integrate              | permanent   |
| `incompatible_output`               | work exists but does not fit the task           | permanent   |
| `repeated_attempts`                 | earlier attempts already tried this             | permanent   |
| `unknown`                           | no usable signal                                | needs human |

Confidence is counted, never inflated: one evidence source is `medium`, two independent
sources are `high`, and a category of `unknown` is `insufficient`. An insufficient
diagnosis opens no repair: the case goes straight to `escalated` with
`reason: insufficient_evidence`, because inventing a cause would be worse than asking.

## How repair is bounded

`planRepair` turns a diagnosis into a worker assignment, and refuses rather than guesses:

- at most 3 attempts, 1 reassignment to a peer type, and a wall-clock ceiling per attempt;
- exponential backoff with a stated reason before each retry;
- the failed worker's checkpoints, cancellation conditions, reporting and permissions are
  **inherited**, never widened, and `permissions` may not gain a write it did not have;
- tools come from the worker-type profile intersected with what the failed assignment
  already allowed;
- paths that must survive are carried as `preservedChangeSets` and cannot be overwritten.

## What actually happens on repair

1. A child task is created under the failed one, so the failed task keeps its own record
   instead of being rewritten.
2. The superseded worker is cancelled. In Step 43 a failed worker is not terminal (it can
   be requeued), so it still holds its resource claims; without this the repair cannot take
   the same paths. Cancelling is accurate: that unit of work is superseded.
3. The repair worker is delegated with the planned assignment and started.
4. If delegation or execution fails, the case escalates with the server's own words and the
   attempt is recorded as `failed` or `refused` - not as a success.

## Completing on evidence

`POST /api/recovery/cases/:id/complete` takes a `verificationRunId`. The run is looked up for
that owner **first**, so a claim about a run that does not exist is refused as such
(`409 RECOVERY_VERIFICATION_REQUIRED`) rather than misreported as a missing attempt. The
run must belong to the same project, must have actually executed, and its status must agree
with what is being claimed. Only then does the attempt close and, if a passing run backs it,
the case become `recovered`, with the revision recorded before and after.

## Restart safety

A case exists independently of the process that opened it: `POST /api/recovery/cases/:id/resume`
re-derives the state from stored workers, verification runs and change sets, marks attempts
that were interrupted as `abandoned` rather than running forever, and preserves any accepted
change set. Two processes cannot both advance one case: writes are compare-and-set on the
case revision.

## Routes

| route                                   | what it does                                    |
| --------------------------------------- | ----------------------------------------------- |
| `GET /api/recovery/capabilities`        | limits, vocabulary, what is enforced            |
| `GET /api/recovery/cases`               | list, filtered by project and status            |
| `GET /api/recovery/cases/:id`           | the case, its attempts and its audit trail      |
| `POST /api/recovery/cases`              | open and diagnose a case                        |
| `POST /api/recovery/cases/:id/plan`     | the plan a repair would use, without running it |
| `POST /api/recovery/cases/:id/repair`   | run one bounded repair attempt                  |
| `POST /api/recovery/cases/:id/complete` | attach verification evidence                    |
| `POST /api/recovery/cases/:id/escalate` | hand it back to the owner                       |
| `POST /api/recovery/cases/:id/cancel`   | stop working on it                              |
| `POST /api/recovery/cases/:id/resume`   | rebuild state after a restart                   |
| `POST /api/recovery/cases/:id/preserve` | mark a change set that must survive a repair    |
| `POST /api/recovery/cases/:id/analyse`  | re-classify from current facts                  |

## Storage

Migration `008` adds `recovery_cases`, `recovery_attempts` and `recovery_events`, all keyed
by owner, with events append-only and a sequence per case. The memory store implements the
same port; the PostgreSQL store is the durable one.

## What this does not do

- It does not merge or roll back code. Integration stays with Step 46; recovery only refuses
  to overwrite a preserved change set.
- It does not invent a cause when evidence is thin, and it does not retry a policy refusal.
- It does not run unlimited attempts: after the budget it escalates.
- The operations dashboard (`#/operations`) does not show recovery cases yet; they are
  readable through `/api/recovery/cases` only.
- There is still no real authentication; the owner header is a development stand-in.
