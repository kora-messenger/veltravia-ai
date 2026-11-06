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

Eighteen tables across two migrations:

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

## What is still in memory

Saying this plainly matters more than the list above:

- **Wired to the database:** projects, workspaces, files, context, integrations.
  These are the engine under every project route, so a restart no longer loses
  them.
- **Table and repository exist and are tested, but the manager above them is
  still in-process:** version control (revisions, checkpoints, branches), memory,
  GitHub sync, exports, run records. Restarting still loses that data through the
  API even though the storage layer is ready.
- **Never durable:** preview runtimes, sandbox processes, agent run steps in
  flight, and the AI gateway's in-process usage counters.

The next increment is switching those managers to the repositories that already
exist; nothing about the schema or the adapter needs to change for it.

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

Both skip when `VELTRAVIA_TEST_DATABASE_URL` is unset. CI runs a `postgres:16`
service and sets it, because a skip must never be how CI passes.

## Known limits

- One database per deployment; there is no sharding or per-tenant database.
- Migration rollback is `DROP`-based and only safe on a fresh database; there is
  no down-migration for data you care about.
- Retention sweeps (`deleteExpired`, `trimHistory`, `sweep`) exist and are tested
  but are not yet driven by a scheduler.
- The `pg` driver returns an **array** of results for a multi-statement query.
  Everything goes through `normalizeResult`, which unwraps the last statement;
  adding a call site that talks to `pg` directly reintroduces that bug.
