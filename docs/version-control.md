# Version Control (Step 18)

> Package: `version-control/core` (`@veltravia/version-core`) ·
> `version-control/mock` (`@veltravia/version-mock`) · API surface:
> `apps/api/src/version-service.ts` + `apps/api/src/routes/versions.ts` ·
> Web surface: `apps/web/src/api/versions.ts` +
> `apps/web/src/pages/projects/VersionPanel.tsx`

Step 18 gives Veltravia an append-only version history: immutable
revisions of workspace trees, bounded diffs, named checkpoints, and
rollback — as an explicit, confirmation-gated restore that never
rewrites the past.

## What exists in this step

- **Snapshots (`snapshot`)** — every revision is a content-addressed,
  integrity-verified snapshot of the whole workspace tree. Snapshot
  integrity is checked on read: a corrupt or tampered store fails closed
  (`VERSION_SNAPSHOT_CORRUPT`), never silently degrades.
- **Diff (`diff`)** — bounded line diffs between revisions (and against
  the parent revision), with per-file kind classification (added /
  modified / deleted / renamed / binary / unchanged), hard line and file
  ceilings, and a safe normalized API view.
- **Revisions (`revision`)** — immutable, append-only records with a
  monotonic per-workspace number, parent lineage, honest change counts,
  source provenance (`manual`, `generation_before/after`,
  `testing_before_repair/after`, `coding_before/after`, `rollback`), and
  rollback lineage (`restoredFromRevisionId`).
- **Checkpoints (`checkpoint`)** — named, user-owned markers pointing at
  a revision (auto-pinned to the current tree when no revision is given).
  Markers are advisory: deleting one NEVER deletes a revision or a
  snapshot. Retention evicts the OLDEST markers beyond the per-workspace
  cap, skipping markers pinned by open rollback operations.
- **Restore (`restore`)** — rollback is a validated, TWO-PHASE
  operation: the restore is planned (target validated, current revision
  guarded by `expectedCurrentRevision` optimistic concurrency), then
  PAUSED for a human confirmation, then executed step by step
  (`VERSION_RESTORE_IN_PROGRESS` while stepping). The restore writes the
  workspace tree through the same file-tree operations the rest of the
  engine uses, and APPENDS a new `rollback`-source revision recording the
  lineage. History is never rewritten or truncated.
- **Retention (`retention`)** — bounded revisions per workspace with
  hard ceilings; the retention sweep refuses to violate its guarantees
  (`VERSION_RETENTION_VIOLATION`) instead of silently breaking them,
  and counts protected revisions (pinned by checkpoints or open
  operations) before evicting.
- **Manager (`manager`)** — the orchestration surface: capture, diff,
  compare, checkpoint CRUD, restore open/decide/cancel, retention, and a
  scrubbed, audit-trailed view of everything that happened
  (`version_audit_events` through the shared audit sink).

## Trust rules (short form)

1. Revisions are immutable and append-only; nothing deletes history.
2. A restore is a REQUEST, never an immediate action: it pauses for a
   human confirmation bound to the exact input, executes only through
   the validated restore step machine, and appends a new revision.
3. Rollback runs at critical risk through the Tool System — forced human
   confirmation, no bypass path (`apps/api` opens the operation; only
   `decide` can execute it).
4. Snapshots fail closed on integrity mismatch.
5. Diffs and API views are safe normalized data (paths, kinds, bounded
   lines) — never unbounded content dumps.
6. Checkpoint markers are advisory only; deleting one touches no
   revision, no snapshot, no file.
7. Auto-captures bracketing coding/generation/testing runs are
   BEST-EFFORT observability: a capture failure never fails the run it
   brackets.
8. All events land in the scrubbed audit trail; errors are typed and
   scrubbed (`VERSION_*` codes).

## API surface (`apps/api`)

| Route                                                         | Method | Purpose                                  |
| ------------------------------------------------------------- | ------ | ---------------------------------------- |
| `/api/projects/:projectId/revisions`                          | GET    | Timeline (newest first, bounded)         |
| `/api/projects/:projectId/revisions`                          | POST   | Capture the current tree                 |
| `/api/projects/:projectId/revisions/:revisionId/diff`         | GET    | Bounded diff vs parent                   |
| `/api/projects/:projectId/revisions/compare`                  | GET    | Bounded diff between two revisions       |
| `/api/projects/:projectId/checkpoints`                        | GET    | List checkpoints                         |
| `/api/projects/:projectId/checkpoints`                        | POST   | Pin a named checkpoint                   |
| `/api/projects/:projectId/checkpoints/:checkpointId`          | DELETE | Remove the marker (history untouched)    |
| `/api/projects/:projectId/rollback`                           | POST   | Open a restore (pauses for confirmation) |
| `/api/projects/:projectId/rollback/:operationId/confirmation` | POST   | Human decision (approve/reject)          |
| `/api/projects/:projectId/rollback/:operationId/cancel`       | POST   | Cancel an open restore                   |

Every mutation is validated (unknown ids 404, foreign access 400/404,
revision conflicts 409) and returns safe normalized views only.

## Web surface (`apps/web`)

The VersionPanel on the project page shows the workspace picker, the
revision timeline with per-revision diff and restore actions, the
checkpoints tab (pin/remove), a bounded diff dialog, and the restore
confirmation dialog. The restore is only issued as an intent; the UI
always states that the restore is recorded as a NEW revision and
nothing is lost.

## Honest limitations

- The shipped store (`version-control/mock`) is an in-memory
  implementation for development and tests; a production store must
  implement the same `VersionStore` port with the same integrity and
  retention guarantees.
- Captures snapshot the CURRENT tree; files changed concurrently during
  a capture can be missed (last-writer-wins per file), which is inherent
  to snapshot-on-demand versioning.
- Route-level auto-captures are best-effort: a failed capture is
  audit-recorded and the run proceeds.
