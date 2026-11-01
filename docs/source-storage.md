# Native project source storage

Step 31. Veltravia stores, versions and serves users' project source itself. GitHub is
optional, never required.

## Where it sits

```
web (#/builder explorer)  ── HTTP ──>  apps/api
                                          │
                            SourceRepositoryManager      (@veltravia/source-storage-core)
                              │        │          │
                     SourceTreePort  ContentStore  history + snapshots
                              │        │
                     project engine   blob store (in-memory today, object storage next)
```

There is **one** project system. Projects, workspaces and the file tree belong to
`@veltravia/project-core` (Step 7) and remain the only place a file actually lives. This
package adds what the engine deliberately does not do:

- content-addressed blob storage for snapshot content,
- per-file revision history with an actor,
- atomic multi-file change sets with rollback,
- repository snapshots, restore and comparison,
- deterministic source manifests,
- owner-scoped repository resolution.

Router, agent and coding-agent code keeps writing through the project engine. Nothing here
creates a second write path, and no code in this package touches a filesystem or a shell.

## Storage abstraction

`ContentStore` is the whole storage contract:

```ts
put(content: string): Promise<{ hash: string; bytes: number }>
get(hash: string): Promise<string | null>
has(hash: string): Promise<boolean>
stats(): Promise<{ blobs: number; bytes: number; durable: boolean }>
```

`InMemoryContentStore` is the development implementation, and it says so: `durable: false`
is reported all the way to `GET /api/projects/:id/source/storage`, so a user is never told
their snapshots are safe when they are not. The hash is SHA-256 of the exact bytes, with no
salt and no normalization, so identical content is stored once and a snapshot can be
verified against its manifest.

Moving to object storage (S3, R2, GCS) means one new class: `put` becomes a conditional
`PutObject` keyed by `source/<hash>`, `get` becomes `GetObject`, and nothing above the port
changes. This is deliberately not implemented now: an in-memory store is enough to prove
the model, and provisioning object storage before there is a durable database to point at
it would add cost without adding capability. The migration is a single adapter plus the
`durable: true` flag it reports.

## File API

All paths are relative to the workspace root and validated before any engine call.

| Method | Path                                                     | Purpose                                         |
| ------ | -------------------------------------------------------- | ----------------------------------------------- |
| `GET`  | `/api/projects/:id/source`                               | Tree: files, directories, totals, root revision |
| `GET`  | `/api/projects/:id/source/file?path=`                    | File content (bounded, reports `truncated`)     |
| `POST` | `/api/projects/:id/source/changes`                       | Atomic multi-file change set                    |
| `GET`  | `/api/projects/:id/source/history?path=&limit=`          | File revision history                           |
| `GET`  | `/api/projects/:id/source/manifest`                      | Deterministic source manifest                   |
| `GET`  | `/api/projects/:id/source/snapshots`                     | Snapshot list                                   |
| `POST` | `/api/projects/:id/source/snapshots`                     | Create a manual snapshot                        |
| `GET`  | `/api/projects/:id/source/snapshots/:snapshotId`         | One snapshot                                    |
| `POST` | `/api/projects/:id/source/snapshots/:snapshotId/restore` | Restore                                         |
| `GET`  | `/api/projects/:id/source/compare?from=&to=`             | Compare two snapshots                           |
| `GET`  | `/api/projects/:id/source/storage`                       | Store stats and durability                      |

`workspaceId` may be passed as a query parameter. When it is omitted the repository resolves
the project's default workspace, or its first active workspace.

A change set is the only write surface:

```json
{
  "summary": "Add the invoice model",
  "operations": [
    { "op": "create", "path": "src/models/invoice.ts", "content": "…" },
    { "op": "update", "path": "src/index.ts", "content": "…", "expectedRevision": 3 },
    { "op": "rename", "path": "src/old.ts", "newName": "legacy.ts" },
    { "op": "move", "fromPath": "docs/a.md", "toDirectory": "guides" },
    { "op": "delete", "path": "src/dead.ts", "expectedRevision": 2 },
    { "op": "create-directory", "path": "src/models" }
  ]
}
```

Missing parent directories are created for a `create`. Every operation is validated against
a simulated tree before the first write, then applied in order. If a write fails partway,
the applied operations are compensated in reverse, and the response reports exactly how far
it got. If compensation itself fails, the error is `SOURCE_ROLLBACK_FAILED` and names the
operation that could not be undone. That is a real, honest failure state, not a silent one.

## Revision model

Two different numbers, deliberately:

- **File revision** (project engine): incremented per file, and required on every update.
  A stale `expectedRevision` is rejected, never overwritten.
- **Root revision** (workspace): incremented per tree mutation, so a client can tell that
  something moved even if its own file did not.

History entries add what the engine does not keep:

```ts
{
  (path, changeKind, revision, size, contentHash, actor, summary, at);
}
```

`actor` is one of `source-api`, `ai-agent`, `external-writer`, `snapshot-restore`. Writes made
through this API are recorded as they happen. Writes made directly through the project engine
by the coding agent, generation engine or sandbox prepare step are picked up by observation:
the repository diffs the tree against what it last saw and records `external-writer` entries
with the change kind. The first observation of a repository is a **baseline**, not a burst of
"created" events.

## Snapshots

A snapshot is a manifest plus blobs:

```ts
{ id, kind: 'manual' | 'automatic' | 'pre-restore', label, note,
  manifest: { root, files: [{ path, hash, size }] }, fileCount, totalBytes,
  manifestHash, createdAt }
```

- `manifestHash` is a hash over sorted `path:hash` lines, so the same tree always produces the
  same hash and one changed byte changes it.
- Automatic snapshots are pruned (oldest first) and capped separately from manual ones.
- Restore takes a `pre-restore` automatic snapshot of the current tree first, so a restore is
  itself reversible, then creates, updates and deletes to match the target, recording each
  change as `snapshot-restore`.
- Compare is file-level: `added`, `removed`, `modified`, `unchanged`, with sizes.

Branches and merges are explicitly **not** implemented. The manifest is the intended basis:
a branch is another manifest lineage, and a merge is a three-way manifest comparison. Writing
that now, before file history is used in anger, would be a Git reimplementation chasing a
problem nobody has reported.

## Security model

1. Ownership is resolved by the project engine on every call. An unknown project and another
   owner's project are the same answer: `SOURCE_REPOSITORY_NOT_FOUND` (404). The response never
   reveals that a project exists.
2. A repository that has been resolved once is pinned to the owner that resolved it. A later
   call with a different owner is refused even if the resolver were to misbehave.
3. Paths are validated before any engine call: no absolute paths, no `..`, no backslashes, no
   control characters, no empty segments, no trailing slash, 512-character ceiling. The engine
   validates again; both must agree.
4. Secret-shaped content (`ghp_…`, `sk-proj-…`, private key blocks, Slack and Google tokens,
   bearer tokens and JWTs) is refused on write with `SOURCE_SECRET_REJECTED`, and secret
   dotfiles (`.env`, `id_rsa`, `.npmrc`, `.netrc`, `.pypirc`) are refused by name. The pattern
   list is the project engine's own, not a second copy.
5. Bounded work: 100 operations per change set, 2000 files per snapshot, 512 KiB per file,
   1 MiB per read with an honest `truncated` flag, 50 snapshots per repository.
6. No shell, no host path, no execution. The package imports no network or filesystem module.

## Optional GitHub synchronization

Nothing in this design depends on GitHub. The manifest is the interop surface:
`GET /source/manifest` produces a deterministic `path → hash` map, so a future GitHub
connector (Step 10, already present) can push a commit, compare a remote tree against a
manifest, or import a repository without the storage layer learning anything about GitHub.
Until a user connects GitHub, projects live entirely on Veltravia.

## Not implemented

- Object storage (one adapter away, documented above).
- Durable database persistence: the API's repositories are in-process, so a restart clears
  projects and snapshots.
- Branches, merges, and pull requests.
- Binary files: content is treated as UTF-8 text.
- The visual editor: the explorer reads and navigates files; editing UI is a later milestone.
