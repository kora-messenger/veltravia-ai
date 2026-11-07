# Conflict-safe change integration (Step 46)

A worker's proposal is now a **reviewable record**, not a write. This document says
what that record holds, what it refuses, and where the limits are.

## The shape of a change set

A change set is one worker's complete proposal, anchored to the project revision it
started from:

| Field           | Meaning                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| `baseRevision`  | the project revision the worker read                                                |
| `files[]`       | `path`, `op` (`create`/`update`/`delete`), `baseHash`, `proposedHash`, `size`       |
| `authorization` | the assignment's `allowedPaths`, `excludedPaths`, `allowedTools`                    |
| `deliverables`  | paths the assignment promised                                                       |
| `verification`  | run ids already attached, and whether they passed                                   |
| `status`        | `open` → `integrating` → `integrated` \| `rolled_back` \| `interrupted` \| `failed` |

The content itself is stored as an artifact, so an integration after a restart
applies exactly the bytes the worker produced.

## What validation refuses

Validation runs on the change set alone, before anything is compared with another
worker:

- a path that is absolute, escapes the project, or is not normalised;
- a path outside `allowedPaths`, or inside `excludedPaths`;
- credential-shaped content, scanned line by line and token by token;
- a file over the size ceiling;
- an `update` with no `baseHash`;
- a stored `proposedHash` that does not match the stored content;
- a path whose current content no longer matches `baseHash` (that is a **stale**
  change set, not a conflict).

## What conflict detection refuses

Two change sets in one integration are compared path by path:

| Kind                      | When                                        |
| ------------------------- | ------------------------------------------- |
| `same-file`               | both write the same path                    |
| `overlapping-region`      | both edit the same lines of one file        |
| `delete-modify`           | one deletes a path the other edits          |
| `rename-modify`           | one renames a path the other edits in place |
| `schema`                  | both change a schema file                   |
| `dependency`              | both change a manifest                      |
| `config`                  | both change the same configuration          |
| `invalidates-deliverable` | one removes a path another worker delivered |

Identical content from both workers is **convergent**: it is reported, and it does
not block. A newer project revision on its own is not a conflict either; only a
change to a file the set touches is.

Conflicts are never auto-resolved. The Primary Agent resolves them by drafting a
new change set against the current base and integrating that.

## The integration itself

1. **Approval** — a recorded Primary Agent decision naming the exact change-set
   ids. A decision that names different ids is refused, and so is a rejection.
2. **Lock** — one integration per project, across processes
   (`project_integration_locks`, taken with an expiry so a crash cannot wedge it).
3. **Snapshot** — the whole tree is snapshotted before the first write.
4. **Apply** — one atomic `source.changeSet`, the same path the rest of the
   product uses.
5. **Compensation** — if the write fails part way, the snapshot is restored and the
   record says the project was restored.
6. **Verification** — when a runtime is configured, the allowed operations run and
   their status is stored. A failed check turns the record into `needs_review`; a
   missing runtime is recorded as `unavailable`, never as a pass.

Recovery for a crash mid-integration is explicit: `POST /api/integration/recover`
restores the snapshot of any record left in `applying` and marks it `interrupted`.

## Rollback

An accepted integration can be reverted, but only if nothing changed since. Each
applied file's after-hash is compared with the tree; if any path moved, the
rollback is refused with `INTEGRATION_ROLLBACK_UNSAFE` rather than erasing later
work.

## Worker staging

Workers no longer write the project. Each worker gets its own workspace
(`purpose: worker-staging`) and writes there. The project keeps its base content
while the worker runs, so two workers never see each other's half-finished work.
`POST /api/workers/:id/change-set` turns the staging tree into a change set for
review.

## What does not exist yet

- No automatic merge and no three-way merge of two conflicting proposals. A human
  or the Primary Agent decides.
- No per-user OAuth or real auth: the owner header is still a development stand-in.
- Change sets are durable when Postgres is configured; staging areas are
  process-local, so a restart during a worker run loses that run's proposal. The
  worker itself is already marked failed by the Step 43 lifecycle.
- Verification only runs what the Sandbox Verification profile allows, and only
  when a runtime is configured.
