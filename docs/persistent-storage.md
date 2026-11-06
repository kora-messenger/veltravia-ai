# Persistent storage

Step 41. Until this step the API kept everything in process memory: restarting it
lost every project, file, revision and run. This document says exactly what is
durable now, what is not, and how to run it.

## Turning it on

Set one variable and the API uses PostgreSQL:

```
VELTRAVIA_DATABASE_URL=postgres://user:password@host:5432/veltravia
```

`DATABASE_URL` is accepted as a fallback (many platforms set it for you). With
neither set, the API runs exactly as before on the in-memory engine and behaves
the same; that path stays for tests and laptops.

At boot, in order:

1. The URL is parsed and validated. A non-postgres URL, a missing database name
   or a malformed port is a startup failure with a message that does not echo the
   credential.
2. Migrations run under a transaction-scoped advisory lock, so two instances
   starting at once cannot both apply the same file.
3. Any failure exits with code 78 (`EX_CONFIG`) before the server listens. A
   schema problem must not become a 500 on somebody's first request.

TLS is `require` for any non-local host and off for `localhost`/`127.0.0.1`. The
`sslmode` query parameter overrides that decision.

## What is durable

Rows for projects, workspaces, files and directories, project context and config,
integration references, memories, revisions with their snapshots, checkpoints,
branches and the active branch, rollback operations, run records, export jobs,
stored-object metadata, and GitHub sync state (connections, plans, history).

Eighteen tables across three migrations (003 adds indexes only):

```
projects            workspaces          file_nodes          project_contexts
project_configs     integration_refs    memories            revisions
checkpoints         branches            active_branches     rollback_operations
run_records         export_jobs         stored_objects      sync_connections
sync_plans          sync_history
```

File contents live in `file_nodes.content` beside their metadata, so a write and
its size update are one statement. Tree reads never select `content`; a
thousand-file tree does not drag its source over the wire to draw a tree.

## What each manager does now

The important distinction is not "table or no table" but how a manager writes:

- **Directly on the repository.** Projects, workspaces, files, context,
  integrations, version control (revisions, checkpoints, branches, rollbacks)
  and memory. Their stores were already asynchronous, so PostgreSQL sits
  underneath with no adapter.
- **Mirror with write-through.** The GitHub sync and export managers read their
  state through _synchronous_ ports (`SyncStore`, `ArchiveStore`), because their
  public API has synchronous methods that routes call directly. Rather than turn
  those interfaces inside out, `apps/api/src/durable-state.ts` keeps a per-owner
  mirror of the rows, loads it once per process (`prepare`), and queues every
  write; the server waits for the queue (`flush`) before sending a mutating
  response. So a 2xx from `POST /api/projects/:id/exports` means the job row is
  in PostgreSQL, not merely queued. If the flush fails, the response is a 503
  `PERSISTENCE_UNAVAILABLE` that says nothing was recorded.
- **Recorded at the edge.** A run (coding, application testing, agent) is a live
  state machine with a model call and a sandbox behind it, so its control surface
  stays in the process that started it. Its _record_ - request, status, plan,
  report, findings - is written to `run_records` and is readable after a restart
  at `GET /api/run-records/:kind/:runId`, which reports `live: false` for exactly
  that reason. Resuming or cancelling a run in a different process is not
  claimed and does not work.
- **Archive bytes** stay out of the database behind the `ObjectStore` port. They
  live under `VELTRAVIA_ARCHIVE_DIR`, or `<VELTRAVIA_DATA_DIR>/archives`, and a
  restart can serve them again because the local driver has a synchronous read.
  With neither variable set the export records are still durable but the ZIPs are
  not, and the storage status says so instead of pretending.

## What is still in memory

- **Live runs and their steps** - the run's in-flight state, not its record.
- **Preview runtimes and sandbox processes.** They are processes; a restart ends
  them, and the API says a runtime is gone rather than resuming a phantom.
- **The AI gateway's usage counters** until the next flush of their own store.
- **The export/sync mirror is per process.** It is filled from the database per
  owner and never shared between instances. Two API processes pointed at the same
  database both write correctly, but each sees rows it has not loaded yet. Run
  one instance, or accept that a second one can be behind until it loads the
  owner. This is a documented limit, not a hidden one.

## Ownership

Every repository takes its owner from the request scope, not from an argument a
caller could forget to pass. The scope is set once per request from
`x-veltravia-owner-ref`, before the access guard runs, and every query carries
`owner_ref = $n`.

The database enforces the same rule a second time. Child rows use composite
foreign keys onto their parent's owner:

```
foreign key (project_id, owner_ref) references projects (id, owner_ref)
```

so a workspace, file, memory or revision cannot be attached to another owner's
project even by direct SQL. A row that belongs to someone else is
indistinguishable from a row that does not exist: the repositories return `null`
or an empty list, and the API answers 404 with the same body it uses for a
missing project.

Nothing here is authentication. The owner header is still a development
stand-in; Step 41 makes it consistent and enforced, not verified.

## Archives

ZIP exports are not stored in the database. `stored_objects` holds the metadata
and a `storage_ref`; the bytes go through the `ObjectStore` port.

`LocalObjectStore` writes them under a directory on a mounted volume, one file
per key, with keys the platform generates (`exports/<projectId>/<uuid>.zip`). A
key containing `..`, an absolute path or anything outside `[A-Za-z0-9._/-]` is
rejected before it reaches the filesystem. Moving to S3, R2 or GCS means writing
another implementation of the port; no route changes.

## Readiness

`/ready` gains a `database` check only when a database is configured. It reports
a verdict and nothing else: no host, no database name, no connection string. A
dead database turns the whole answer into 503 so traffic stops arriving.

## Running it

```bash
# local database (any postgres 16 will do)
export VELTRAVIA_DATABASE_URL=postgres://user@127.0.0.1:5432/veltravia
npm run build
npm --workspace @veltravia/api run start
```

Migrations also run on demand:

```bash
node -e "import('@veltravia/storage-postgres').then(async (s) => {
  const db = s.createDatabase(s.parseDatabaseUrl(process.env.VELTRAVIA_DATABASE_URL));
  console.log(await s.migrate(db));
  await db.close();
})"
```

## Tests

Two suites cover this, and both need a real server:

- `storage/postgres/src/storage.test.ts` - migrations (idempotency, tamper
  detection), ownership (missing scope, spoofed owner, cross-owner reads, a row
  planted by direct SQL), files (content, sizes, path conflicts, subtree moves,
  cascade deletes), memory, revisions and snapshots, run records, object storage
  including key traversal, and sync state.
- `apps/api/src/persistence.test.ts` - boots the real Fastify app on the real
  database and proves a created project is a row, that another owner cannot see
  it, that `/ready` reports the database, and that a second app instance (a
  restart) reads what the first wrote.
- `apps/api/src/persistence-managers.test.ts` - the restart claim per manager:
  an export created by one instance is listed and **downloaded with its bytes**
  by a second instance, a GitHub connection and the base a later sync compares
  against come back, and a run record is readable at `/api/run-records` while a
  different owner gets the same 404 as a missing one.

Both skip when `VELTRAVIA_TEST_DATABASE_URL` is unset. CI runs a `postgres:16`
service and sets it, because a skip must never be how CI passes.

## Known limits

- One database per deployment; there is no sharding or per-tenant database.
- Migration rollback is `DROP`-based and only safe on a fresh database; there is
  no down-migration for data you care about.
- Retention sweeps (`deleteExpired`, `trimHistory`, `sweep`) exist and are tested
  but are not yet driven by a scheduler.
- The sync and export mirror is per process (see above): one instance per
  database is the supported deployment today.
- Archive bytes are durable on the local filesystem driver only. A remote driver
  has no synchronous read, so `download` needs the route to stream asynchronously
  before S3 or R2 can be supported.
- The `pg` driver returns an **array** of results for a multi-statement query.
  Everything goes through `normalizeResult`, which unwraps the last statement;
  adding a call site that talks to `pg` directly reintroduces that bug.
