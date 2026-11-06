/**
 * Chooses where the API keeps its data.
 *
 * Two deployments, one code path:
 *
 *  - No database configured: the in-memory engine, exactly as before. Every
 *    existing test and a laptop run keep working, and the process says plainly
 *    that a restart discards its data.
 *  - `VELTRAVIA_DATABASE_URL` set: PostgreSQL. Migrations run before the server
 *    accepts traffic, so a schema problem is a failed boot, not a 500 later.
 *
 * The owner scope is the second half of this file. Repositories refuse to run
 * without an owner, so the request's caller is put in scope once per request
 * and everything downstream (the access guard, the engine, any repository) sees
 * the same owner without threading a parameter through every function.
 */

import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { ProjectEngine } from '@veltravia/project-core';
import {
  DatabaseConfigurationError,
  LocalObjectStore,
  type Database,
  type PostgresStores,
  createDatabase,
  createPostgresProjectEngine,
  createPostgresStores,
  migrate,
  parseDatabaseUrl,
  runWithOwner,
} from '@veltravia/storage-postgres';

import { DurableState } from './durable-state.js';

import { resolveCallerOwnerRef } from './project-access.js';

export type PersistenceMode = 'memory' | 'postgres';

export interface Persistence {
  readonly mode: PersistenceMode;
  /** Null only when the mode is `memory` and no engine was supplied. */
  readonly engine: ProjectEngine | null;
  readonly stores: PostgresStores | null;
  /**
   * Durable state for managers whose ports are synchronous (sync, exports,
   * runs). Null in memory mode, where those managers keep their own memory.
   */
  readonly durable: DurableState | null;
  /** Readiness check: throws with no detail when the database cannot be reached. */
  verify(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Where archive bytes go.
 *
 * `VELTRAVIA_ARCHIVE_DIR` wins; otherwise they sit under the deployment's data
 * directory, beside everything else that outlives the process. With neither set
 * the export records are still durable but the ZIPs are not, and the API says
 * so rather than pretending.
 */
export function resolveArchiveDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.VELTRAVIA_ARCHIVE_DIR?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const dataDir = env.VELTRAVIA_DATA_DIR?.trim();
  if (dataDir === undefined || dataDir.length === 0) return null;
  return join(dataDir, 'archives');
}

/** Reads the connection string, preferring the product-specific name. */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ['VELTRAVIA_DATABASE_URL', 'DATABASE_URL']) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return null;
}

const memoryPersistence: Persistence = {
  mode: 'memory',
  engine: null,
  stores: null,
  durable: null,
  async verify() {
    // Nothing durable to verify; readiness says nothing rather than "ok".
  },
  async close() {
    // Nothing to close.
  },
};

export interface CreatePersistenceOptions {
  readonly url?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  /** How many migrations ran and the resulting schema version, for the boot log. */
  readonly onMigrated?: (applied: number, version: string | null) => void;
  /** Where archive bytes go. Defaults to the deployment's data directory. */
  readonly archiveDirectory?: string | null;
  readonly onWriteError?: (error: unknown) => void;
}

/**
 * Builds the persistence for this process.
 *
 * A configured database that cannot be migrated is a startup failure: the
 * caller decides whether to exit, because a test may want to assert on it.
 */
export async function createPersistence(
  options: CreatePersistenceOptions = {},
): Promise<Persistence> {
  const url = options.url ?? resolveDatabaseUrl(options.env ?? process.env);
  if (url === null) return memoryPersistence;

  let database: Database;
  try {
    database = createDatabase(parseDatabaseUrl(url, options.env ?? process.env));
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) throw error;
    throw error;
  }

  try {
    const result = await migrate(database);
    options.onMigrated?.(result.applied.length, result.currentVersion);
  } catch (error) {
    // Never leave a half-configured pool behind when the schema cannot be built.
    await database.close().catch(() => undefined);
    throw error;
  }

  const stores = createPostgresStores(database);
  const engine = createPostgresProjectEngine(stores);

  /**
   * Archive bytes live outside the database, on the same directory the file
   * storage driver uses. Absent a directory, exports are still recorded but
   * their bytes are not durable, which `archiveStorage` reports honestly.
   */
  const archiveDirectory = options.archiveDirectory ?? resolveArchiveDirectory(options.env);
  const objects =
    archiveDirectory === null
      ? null
      : new LocalObjectStore(database, { directory: archiveDirectory });
  const durable = new DurableState({
    sync: stores.sync,
    exports: stores.exports,
    runs: stores.runs,
    objects,
    ...(options.onWriteError === undefined ? {} : { onWriteError: options.onWriteError }),
  });

  return {
    mode: 'postgres',
    engine,
    stores,
    durable,
    async verify() {
      const health = await database.health();
      if (health.status !== 'ok') throw new Error('database unhealthy');
    },
    async close() {
      await database.close();
    },
  };
}

/**
 * Puts the caller in scope for the rest of the request.
 *
 * Registered before the ownership guard, which itself reads the project
 * repository: without a scope that read would be refused, so the ordering here
 * is part of the security model, not a convenience.
 */
export function registerOwnerScope(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const owner = resolveCallerOwnerRef(request);
    runWithOwner(owner, () => {
      done();
    });
  });
}
