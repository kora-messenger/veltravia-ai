# Task orchestration: the Central Primary Agent (Step 42)

Veltravia has one assistant. This step makes that a written contract with
records behind it, so that when workers eventually exist they are workers, not
a second assistant competing for the user's attention.

What this step is **not**: there is no worker execution, no scheduling, no
parallel run and no merging. Assignments are contracts. Nothing in the codebase
spawns anything. Step 43 is where bounded execution belongs.

## The contract

`@veltravia/orchestration-core` exports `CENTRAL_PRIMARY_AGENT_CONTRACT`:
eleven responsibilities, which of them may never be delegated, five invariants,
and one delegation rule. `GET /api/orchestration/contract` publishes it,
including the `notYetImplemented` list, so the platform cannot quietly oversell
itself.

Responsibilities that are never delegated: user interaction, request
understanding, the delegation decision itself, dependency coordination, progress
monitoring, result review, integration and the final answer. Decomposition and
assignment writing may be assisted; the accountability does not move.

`assessDelegation()` makes the decision mechanical: a deterministic 0-100 score
over steps, independent parts, parallelisability and duration, with two hard
vetoes (needs the user, needs conversation context). It is a floor the primary
agent can be held to, not a model's opinion.

`PrimaryAgentRegistry` refuses a second `primary` for the same owner. A
registration is a role declaration; it starts nothing.

## Four identifiers, four jobs

| Identifier  | Identifies                     | Carries permission?     |
| ----------- | ------------------------------ | ----------------------- |
| `chatId`    | a conversation                 | no - a label            |
| `projectId` | a project (and its workspaces) | **yes**                 |
| `taskId`    | one assigned unit of work      | no, but is owner-scoped |
| `runId`     | one execution attempt          | no                      |

A task can only be created inside a project the caller owns, and the guard
resolves that through the Project Engine. A chat id is stored so a task can be
traced to the conversation that asked for it; it is never a credential, and
access is decided by owner plus project. A run id is stored on the attempt that
used it and never stands in for a task id.

`identifyKind()` exists so an obviously crossed id (`run_...` where a task
belongs) can be refused, but authorisation never depends on the shape of an id.

## The lifecycle

```
queued → planning → assigned → running → awaiting_review → completed
   ↘        ↘          ↘          ↘            ↓
    cancelled cancelled  blocked   partially_completed → running
                                   ↘ failed → queued (retry only)
```

`completed` and `cancelled` are terminal: reopening work means a new task, so
history is never rewritten. Two edges are guarded rather than free:

- `failed → queued` only through `retry`, which enforces the attempt budget;
- `awaiting_review → completed` only through a recorded review decision.

A worker cannot complete a task. The manager refuses `completed` from the
`worker` actor, because review is the primary agent's job.

Every status change writes its event in the same transaction as the row update.
A compare-and-set on `version` means two concurrent writers produce one winner
and one `409 TASK_VERSION_CONFLICT`, never a silent overwrite.

## Records

Migration `004` adds four tables:

- `tasks` - owner, project, workspace, chat, parent, title, objective, status,
  review status, assignment, result, failure, retry, checkpoint, `version`,
  timestamps;
- `task_dependencies` - a real edge table with a composite foreign key, so a
  dependency cannot name a task that does not exist or belong to someone else;
- `task_events` - append-only, sequenced history: created, status changes,
  assignment, dependencies, progress, attempts, review, retry, cancel,
  checkpoint;
- `task_attempts` - one row per attempt, with the run id that performed it.

Ownership is in the schema: `tasks` has `(id, owner_ref)` as its key and
`(project_id, owner_ref)` as a foreign key to `projects`, so a row cannot attach
to another owner's project even if a service forgot a predicate. Every child row
carries `owner_ref` and references its parent by both columns.

Nothing here stores a provider credential, a chat transcript or hidden
reasoning. Task text that looks like a credential is refused with `422`
`TASK_SECRET_REJECTED` rather than stored.

## Assignments

`validateAssignment()` refuses an assignment that:

- states an objective shorter than a sentence;
- has no expected output, no acceptance criterion, or no reporting requirement;
- names a tool the platform does not have;
- permits writing without reading, or tool use with no tools listed;
- points at a different project than its own task.

`assessCompletion()` is the judge: given delivered outputs and per-criterion
results, it answers `completed`, `partially_completed`, `blocked`, `failed` or
`incomplete`. An unchecked criterion counts as unverified, and unverified is not
satisfied.

## Routes

| Route                                                 | Purpose                                           |
| ----------------------------------------------------- | ------------------------------------------------- |
| `GET /api/orchestration/contract`                     | the contract, reserved duties, storage honesty    |
| `POST /api/tasks`                                     | create, with the project scope verified           |
| `GET /api/tasks`                                      | list, filtered by project, chat, parent or status |
| `GET /api/tasks/:taskId`                              | one task                                          |
| `POST /api/tasks/:taskId/transitions`                 | request a status change                           |
| `POST /api/tasks/:taskId/assignment`                  | set the worker contract                           |
| `POST`/`DELETE /api/tasks/:taskId/dependencies[/:id]` | dependency edges                                  |
| `POST /api/tasks/:taskId/progress`                    | a bounded progress note                           |
| `POST /api/tasks/:taskId/attempts`                    | start an attempt (records the run id)             |
| `POST /api/tasks/:taskId/attempts/:attempt/finish`    | report what it produced                           |
| `GET /api/tasks/:taskId/attempts`                     | attempt history                                   |
| `POST /api/tasks/:taskId/review`                      | accept or send back                               |
| `POST /api/tasks/:taskId/retry`                       | within the attempt budget                         |
| `POST /api/tasks/:taskId/cancel`                      | cancel                                            |
| `POST /api/tasks/:taskId/checkpoint`                  | link a revision or snapshot                       |
| `GET /api/tasks/:taskId/events?after=N`               | the trail, incrementally                          |

Another owner's task and a task that never existed answer the same `404`.

## What is durable

With `VELTRAVIA_DATABASE_URL` set, tasks are PostgreSQL rows and survive a
restart; a second instance reads and continues them, proved by
`apps/api/src/task-persistence.test.ts`. Without a database they live in memory,
and both the contract route and every task response report
`storage: { store: "memory", durable: false }`.

Multi-instance coordination is not supported, and the contract route says
`multiInstance: false` rather than leaving it to be discovered.

## Deliberately deferred

- Any worker execution, scheduling or parallelism (Step 43).
- Automatic retry backoff and a stalled-task watchdog.
- Conflict-safe merging when two workers touch one workspace.
- A screen. The routes and the contract exist; the UI does not, and nothing in
  this step pretends a visual surface exists.
- Real authentication: the owner header is still the development stand-in it has
  been since Step 11.
