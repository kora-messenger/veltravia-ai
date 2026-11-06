# GitHub sync (Step 40, phase 3)

Push a Veltravia project to a GitHub repository you already own, or bring that
repository's changes back into the project. GitHub stays optional: projects,
workspaces, testing, version control and exports all work with no repository
connected, and nothing in this feature creates a repository.

- Engine: `sync/core` (`@veltravia/sync-core`)
- Connector: `connectors/github` (`@veltravia/connector-github`), extended with the Git Data operations a multi-file commit needs
- API: `apps/api/src/routes/sync.ts`, `apps/api/src/sync-service.ts`
- Screen: `#/projects/<id>/github` (linked from the project page as **Sync with GitHub**)

## What a sync is

A sync is one comparison, one decision, and one commit. It never runs by itself.

1. **Connect** a repository and branch to a project. The comparison is per
   repository _and_ branch: connecting `acme/notes@main` says nothing about
   `acme/notes@dev`.
2. **Compare.** The server reads both sides and produces a plan: what would be
   published, what would be brought in, what changed on both sides, what was
   left out, and how many files are already identical.
3. **Decide**, if the plan needs it. A plan that touches GitHub in a risky way
   must be approved on its own screen; a plan with a file changed on both sides
   must have every one of those conflicts settled first.
4. **Apply.** Local changes are published as **one commit** through the Git Data
   API (blobs → tree → commit → branch update), remote changes are written into
   the workspace, and a history entry records exactly what moved.

A plan is a snapshot. It expires after 15 minutes, and it is refused if the
branch moved after the comparison (someone else's push, or a second tab), so a
stale decision can never be applied to newer files.

## When approval is required

The plan carries its own reasons, and any reason means Apply stays disabled until
the plan is approved:

- `first-sync` — this project has never synced to this repository
- `remote-has-content` — the first sync would publish into a repository that already has files
- `deletes-remote-files` — the sync would delete files on GitHub
- `default-branch` — the branch is the repository's default branch

Approval is per plan, not per project: a later sync asks again when it earns one.

## Safety rules

These are enforced in the engine and in the connector, not in the browser.

- **Secrets never leave.** Credential files (`.env` and its variants, key files)
  and any file whose content looks like a secret are left out, and the plan lists
  them by path and reason only. If a secret appears in a file that would be
  published, the sync is refused (`SYNC_SECRET_REJECTED`, HTTP 422) rather than
  quietly publishing a partial tree.
- **No force push.** The branch update is fast-forward only. If the remote is not
  an ancestor of the attempted commit, the sync fails instead of overwriting
  someone's work.
- **Remote paths are untrusted.** Paths from GitHub are validated exactly like
  workspace paths; a traversal, absolute or control-character path is left out
  and named in the plan.
- **Atomic publish.** Every local change either lands in one commit or none of
  them do. A remote read failure during the apply aborts before any write.
- **Bounded.** 500 files per commit, 512 KiB per file, 2,000 remote files read
  per sync, 200 history entries per project. A larger change is refused with a
  clear message instead of a timeout.
- **Owner-scoped.** Every route resolves the caller through the same project guard
  as the rest of the app. Another owner's project id returns the same 404 as a
  project that does not exist.
- **Reported honestly.** The failure is recorded on the plan and in the history
  with its code, and the screen shows that code rather than a generic failure.

## What is left out of a sync

A plan names every file it skipped and why:

| Reason              | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `credential-file`   | `.env`, key files, anything the project already treats as a credential |
| `secret-in-content` | the content matched the secret detector                                |
| `too-large`         | over the per-file ceiling                                              |
| `not-text`          | a remote binary file, left exactly as it is on GitHub                  |
| `unreadable`        | the file could not be read; the error is no longer swallowed           |
| `not-a-file`        | a symlink or a submodule                                               |

## What this does not do

- **It does not create repositories.** A repository must already exist and be
  reachable by the connected token.
- **There is no per-user GitHub sign-in.** The server holds one operator token
  (`GITHUB_API_TOKEN`) and a scope list (`GITHUB_REPOSITORIES`,
  `owner/repo[@defaultBranch]`). A repository outside that list is not available
  to anyone, and the caller sees a 404. The allowlist is per repository, so a
  connected project can pick a branch inside a permitted repository.
- **No pull requests, no review.** A sync commits to the connected branch
  directly; the approval step is Veltravia's own.
- **History is in memory.** Restarting the API forgets connections, plans and
  history, exactly like the rest of the development store. The screen says so.
- **No submodules, no LFS.** Those paths appear in the plan as skipped.
- **The AI tools do not expose sync.** The assistant's tool list is hand-written;
  sync is a person-driven operation on its own screen.
- **Not a backup.** A remote file that is not text is never brought into the
  workspace, so a repository is not a byte-for-byte mirror of the project.

## Tests

201 tests cover this feature.

- `sync/core/src/*.test.ts` (86) — the comparison engine, plan lifecycle,
  approval rules, conflict resolution, and the safety guards, including fault
  injection through a fake remote port.
- `connectors/github/src/*.test.ts` (41) — the Git Data operations against an
  offline fake that keeps state per branch, plus the single-file operations that
  were already there.
- `apps/api/src/tests/api-sync.test.ts` and `api-sync-flow.test.ts` (26) —
  routes, ownership, status mapping, and a full connect → compare → approve →
  apply walk.
- `apps/web/src/pages/sync/` (33) — the display rules, and the page through a
  fake API: blocked apply, conflict resolution, approval, publish reporting,
  offline, load failure, history and disconnect.
