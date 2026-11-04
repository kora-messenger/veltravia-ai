# Version Control (Steps 18 and 38)

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

## Branching, automatic checkpoints and selective restore (Step 38)

Step 38 builds on the Step 18 revision store. It does not replace it: every
branch operation is expressed in revisions, checkpoints and rollbacks that
Step 18 already guarantees.

### Branches

A **branch** is a named line of work in a project. Each branch owns **its own
workspace**, which is how isolation is achieved: an edit made on one branch is
a write to a different workspace, so it cannot overwrite another branch's
files. Each branch therefore has its own revision history too.

| Operation  | Behaviour                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------- |
| List / get | Branches of the caller's project only. A branch id from another project is refused.                |
| Create     | Copies from a source branch (its latest revision, or a chosen one) into a new workspace.           |
| Rename     | Names are unique per project, 64 characters at most.                                               |
| Switch     | Marks one branch active. It changes which branch the interface shows; it does not touch any files. |
| Archive    | Hides a branch and makes it read-only. Unarchive brings it back.                                   |
| Delete     | Only when safe: never the default branch, never one other branches were created from.              |

A project is limited to 25 branches. A project that existed before Step 38 is
**adopted** on first use: its current workspace becomes the default branch
`main` without copying a single file.

Deleting a branch removes the branch record (its name) only. Its workspace
files and saved revisions are kept, so nothing a person wrote is destroyed and
no checkpoint is taken for it.

### Automatic checkpoints

A checkpoint is taken automatically only when a change earns one. The decision
is a pure function (`decideAutomaticCheckpoint`): the same description of a
change always gives the same answer, and the reason is recorded.

| Trigger              | When                                                            |
| -------------------- | --------------------------------------------------------------- |
| `before_destructive` | The change removes files, or an approved destructive operation. |
| `before_refactor`    | Three or more existing files are rewritten and none is added.   |
| `before_ai_change`   | An AI change touches three or more files.                       |
| `before_restore`     | Always, before any restore (see below).                         |

Small changes (one or two files) take no checkpoint, so the history is not
filled with noise. The trigger list is closed: there are no free-text triggers.

### Restore

Restoring is a two-step, confirmation-gated operation, and it never rewrites
history.

1. **Choose.** The interface compares the current files with the revision being
   restored and lists every file that would change, each marked with what will
   happen to it (`will be reverted`, `will come back`, `will be removed`). All
   are ticked by default. Unticked files are left exactly as they are.
2. **Confirm.** The server validates the request and **pauses** for an explicit
   decision. Nothing has changed at this point.
3. **Recovery point.** On approval, the files as they are now are saved first as
   a checkpoint named `Recovery: Before restoring revision N`.
4. **Apply.** The restore is recorded as a NEW revision. A stale
   `expectedCurrentRevision` is refused with a conflict, so a restore cannot
   silently overwrite changes made since the dialog opened.

A restore of selected files sends the chosen `paths`; if every file is chosen
the request omits `paths` and restores the whole tree. Paths are normalised and
checked, and a path outside the project is refused.

### Version history

`GET /api/projects/:projectId/branches/:branchId/history` returns a
chronological list for one branch. Each entry carries the revision, branch,
description, time, **who made it**, files changed with counts, a change type and
any checkpoint that pins it.

The author is one of `user`, `ai-agent` or `system`, derived from the revision
source (`coding_before` / `coding_after` mean the coding agent; `rollback` and
automatic captures are `system`). A change is never attributed to the AI unless
the source says so.

### Coding Agent integration

After a person approves a plan, and **before the first change**, the coding run:

1. validates that the workspace belongs to the project the run was started for,
2. describes the change from the approved plan (files modified, created, deleted),
3. takes a checkpoint if the policy above says so,
4. reports the checkpoint to the run so it can be shown to the person.

The checkpoint step cannot approve anything or widen what the run may do: it
reads the plan and writes a revision and a checkpoint marker only. If the
checkpoint cannot be saved, the run **stops before any file is touched** instead
of continuing unprotected.

### API (Step 38 additions)

| Method and path                                         | Purpose                                  |
| ------------------------------------------------------- | ---------------------------------------- |
| `GET/POST /api/projects/:id/branches`                   | List and create branches                 |
| `GET/PATCH/DELETE /api/projects/:id/branches/:branchId` | Get, rename, delete                      |
| `POST .../branches/:branchId/switch`                    | Make a branch the active one             |
| `POST .../branches/:branchId/archive` and `/unarchive`  | Archive and restore a branch             |
| `GET .../branches/:branchId/history`                    | Annotated timeline                       |
| `GET /api/projects/:id/revisions/compare`               | Compare any two revisions (`from`, `to`) |
| `POST /api/projects/:id/checkpoint-policy/evaluate`     | Ask what the policy would decide         |
| `POST /api/projects/:id/rollback`                       | Open a restore (optionally with `paths`) |

### Security boundaries

- **Ownership.** Every route resolves the project first. A branch, revision or
  checkpoint that belongs to a different project is refused, so one project can
  never restore from or switch to another's.
- **No credentials in snapshots.** Content that looks like a secret is refused
  at capture; errors name the path, never the value.
- **Immutable records.** Revisions and checkpoints are not edited. A restore
  adds a revision; it does not change an old one.
- **Destructive actions are gated.** A restore needs an explicit approval, and
  the coding run cannot skip the plan approval it is already subject to.
- **Stale requests are refused.** A restore based on an out-of-date revision
  returns a conflict instead of overwriting newer work.

### What was verified in a browser

Against the real API and web server at 390, 900 and 1440px: the branch bar,
branch creation and switching, branch isolation (an edit on a new branch left
`main` unchanged), the restore chooser fitting each viewport with no horizontal
scrolling, and a selective restore end to end (only the ticked file changed,
nothing changed before approval, a recovery checkpoint was saved).

Running it against a live server also found a defect the component tests could
not: the panel refreshed itself in a loop (thousands of requests in seconds)
because a callback changed identity on every render. It is fixed, and a test now
counts requests so it cannot return unnoticed.

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
- (Step 38) Branches and checkpoints live in the same in-memory store as
  revisions, so they are lost when the API restarts. Nothing here is durable
  until a production `VersionStore` and `BranchStore` exist.
- (Step 38) There is no merge. Branches are independent; changes are not
  combined between them, and there is no conflict resolution. Bring a change
  across by restoring selected files from one branch's revision.
- (Step 38) A rename is recognised only when the file's content is unchanged.
  A file renamed and edited in the same step shows as one removal and one
  addition.
- (Step 38) Concurrent edits to one branch are last-writer-wins per file; the
  stale-revision check protects a restore, not every other write.
- (Step 38) The refactor trigger is an inference (three or more existing files
  rewritten, none added), because a plan carries no refactor flag.
