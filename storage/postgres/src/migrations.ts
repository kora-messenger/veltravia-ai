/**
 * The migration runner.
 *
 * Properties that matter in production:
 *  - **Idempotent.** Applied migrations are recorded; re-running does nothing.
 *  - **Serialised.** A transaction-scoped advisory lock means two instances
 *    booting at once cannot apply the same migration twice; the loser waits.
 *  - **Verified.** Each file's checksum is stored. Editing a migration that has
 *    already run is refused, because the deployed schema would silently differ
 *    from the repository.
 *  - **Observable.** `migrate()` returns exactly what was applied, skipped and
 *    how long each took; failures name the migration and keep the SQL out of
 *    the error.
 *  - **All-or-nothing per migration.** One migration runs in one transaction,
 *    so a partial DDL cannot be left behind.
 */

import { createHash } from 'node:crypto';

import type { Database, Queryable } from './pool.js';
import { DatabaseError } from './errors.js';
import { migration001 } from './migrations/001-core-schema.js';
import { migration002 } from './migrations/002-history-runs-exports-sync.js';
import { migration003 } from './migrations/003-owner-lookup-indexes.js';
import { migration004 } from './migrations/004-task-orchestration.js';
import { migration005 } from './migrations/005-superagent-workers.js';
import { migration006 } from './migrations/006-verification-runs.js';

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
].sort((a, b) => a.version.localeCompare(b.version));

const MIGRATION_TABLE = 'veltravia_schema_migrations';

/** Stable lock id for the migration advisory lock. */
const LOCK_NAMESPACE = 4_120_731;

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  readonly applied: readonly { version: string; name: string; durationMs: number }[];
  readonly skipped: readonly string[];
  readonly currentVersion: string | null;
}

export interface SchemaStatus {
  readonly currentVersion: string | null;
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly string[];
}

function checksumOf(sql: string): string {
  // Normalise line endings so a checkout on Windows does not look like an edit.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export class MigrationError extends DatabaseError {
  readonly version: string | null;

  constructor(message: string, version: string | null, cause?: unknown) {
    super('schema', message, { cause });
    this.name = 'MigrationError';
    this.version = version;
  }
}

async function ensureMigrationTable(db: Queryable): Promise<void> {
  await db.query(`
create table if not exists ${MIGRATION_TABLE} (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),
  duration_ms integer not null default 0
)`);
}

export async function schemaStatus(db: Queryable): Promise<SchemaStatus> {
  await ensureMigrationTable(db);
  const rows = await db.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(`select version, name, checksum, applied_at from ${MIGRATION_TABLE} order by version`);

  const applied: AppliedMigration[] = rows.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at.toISOString(),
  }));
  const appliedVersions = new Set(applied.map((m) => m.version));
  return {
    currentVersion: applied.length === 0 ? null : applied[applied.length - 1]!.version,
    applied,
    pending: MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).map((m) => m.version),
  };
}

export interface MigrateOptions {
  /** Refuse to change anything; report what would run. */
  readonly dryRun?: boolean;
}

export async function migrate(
  database: Database,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  await database.withTransaction(async (tx) => ensureMigrationTable(tx));

  const status = await schemaStatus(database);

  // Refuse to run against a schema whose history was rewritten.
  const byVersion = new Map(MIGRATIONS.map((m) => [m.version, m]));
  for (const applied of status.applied) {
    const known = byVersion.get(applied.version);
    if (known !== undefined && checksumOf(known.sql) !== applied.checksum) {
      throw new MigrationError(
        `Migration ${applied.version} was changed after it was applied. Create a new migration instead.`,
        applied.version,
      );
    }
  }

  if (options.dryRun) {
    return {
      applied: [],
      skipped: [...status.applied.map((m) => m.version)],
      currentVersion: status.currentVersion,
    };
  }

  const appliedNow: { version: string; name: string; durationMs: number }[] = [];
  const skipped: string[] = status.applied.map((m) => m.version);

  for (const migration of MIGRATIONS) {
    if (status.applied.some((m) => m.version === migration.version)) continue;
    const started = Date.now();
    try {
      await database.withTransaction(async (tx) => {
        // Serialise concurrent boots. xact-scoped: released on commit/rollback.
        await tx.query('select pg_advisory_xact_lock($1)', [LOCK_NAMESPACE]);
        const already = await tx.query<{ version: string }>(
          `select version from ${MIGRATION_TABLE} where version = $1`,
          [migration.version],
        );
        if (already.rows.length > 0) return; // another instance won the race
        await tx.query(migration.sql);
        await tx.query(
          `insert into ${MIGRATION_TABLE} (version, name, checksum, duration_ms)
           values ($1, $2, $3, $4)`,
          [migration.version, migration.name, checksumOf(migration.sql), Date.now() - started],
        );
      });
      appliedNow.push({
        version: migration.version,
        name: migration.name,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      // The migration version is safe to report; the SQL and its error are not.
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed and was rolled back.`,
        migration.version,
        error,
      );
    }
  }

  return {
    applied: appliedNow,
    skipped,
    currentVersion: MIGRATIONS[MIGRATIONS.length - 1]?.version ?? null,
  };
}
