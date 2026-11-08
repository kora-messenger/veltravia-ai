/**
 * The connection pool and the transaction helper.
 *
 * One pool per process. Every statement runs with a server-side statement
 * timeout, so a pathological query cannot pin a connection forever, and every
 * transaction is bracketed by the pool client so a thrown error can never leak
 * a checked-out connection.
 */

import pg from 'pg';

import { type DatabaseConfig, describeDatabaseConfig } from './config.js';
import { DatabaseError, toDatabaseError } from './errors.js';

const { Pool } = pg;

export type QueryParam =
  string | number | boolean | null | Date | Record<string, unknown> | unknown[];

export interface QueryResultLike<T> {
  readonly rows: T[];
  readonly rowCount: number;
}

/**
 * Normalises a driver result.
 *
 * `pg` returns an ARRAY of results when a single simple query carries several
 * statements (which every multi-statement migration does). Reading `.rows` off
 * that array throws, so the last statement's result is unwrapped here and call
 * sites always see one shape.
 */
function normalizeResult<T extends pg.QueryResultRow>(
  result: pg.QueryResult<T> | pg.QueryResult<T>[],
): QueryResultLike<T> {
  const single = Array.isArray(result) ? result[result.length - 1] : result;
  const rows = single?.rows ?? [];
  return { rows, rowCount: single?.rowCount ?? rows.length };
}

/** Anything that can run a statement: the pool, or one transaction's client. */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<T>>;
}

export interface DatabaseHealth {
  readonly status: 'ok' | 'unavailable';
  readonly latencyMs: number;
  readonly pool: { readonly total: number; readonly idle: number; readonly waiting: number };
  /** Error category when unavailable; never a message, host or credential. */
  readonly reason: string | null;
}

export interface Database extends Queryable {
  readonly summary: ReturnType<typeof describeDatabaseConfig>;
  /** Runs `fn` inside a transaction; rolls back on any throw. */
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Round-trips a trivial statement. Safe to call from a health probe. */
  health(): Promise<DatabaseHealth>;
  /** Drains the pool. Idempotent. */
  close(): Promise<void>;
  readonly closed: boolean;
}

function sslOption(config: DatabaseConfig): false | { rejectUnauthorized: boolean } {
  if (config.ssl === 'disable') return false;
  // `require` encrypts without pinning a CA (managed providers with a public
  // chain); `verify` also validates the certificate.
  return { rejectUnauthorized: config.ssl === 'verify' };
}

export interface CreateDatabaseOptions {
  /** Injectable for tests; defaults to the real `pg` Pool. */
  readonly poolFactory?: (config: DatabaseConfig) => pg.Pool;
  readonly logger?: (event: { kind: 'pool-error'; category: string }) => void;
}

export function createDatabase(
  config: DatabaseConfig,
  options: CreateDatabaseOptions = {},
): Database {
  const factory =
    options.poolFactory ??
    ((cfg: DatabaseConfig) =>
      new Pool({
        connectionString: cfg.connectionString,
        max: cfg.maxConnections,
        idleTimeoutMillis: cfg.idleTimeoutMs,
        connectionTimeoutMillis: cfg.connectionTimeoutMs,
        statement_timeout: cfg.statementTimeoutMs,
        query_timeout: cfg.statementTimeoutMs,
        application_name: cfg.applicationName,
        ssl: sslOption(cfg),
      }));

  const pool = factory(config);
  let closed = false;

  // An idle client error (server restart, network reset) is reported by the
  // pool, not by a waiting query. Without this handler Node would crash the
  // process; we surface the category and let the pool replace the client.
  pool.on('error', (error: unknown) => {
    const mapped = toDatabaseError(error);
    options.logger?.({ kind: 'pool-error', category: mapped.category });
  });

  async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResultLike<T>> {
    if (closed) throw new DatabaseError('unavailable', 'The database connection pool is closed.');
    try {
      return normalizeResult(await pool.query<T>(text, values as unknown[]));
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  const database: Database = {
    summary: describeDatabaseConfig(config),
    query,
    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      if (closed) throw new DatabaseError('unavailable', 'The database connection pool is closed.');
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw toDatabaseError(error);
      }
      const tx: Queryable = {
        async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
          text: string,
          values: readonly unknown[] = [],
        ) {
          try {
            return normalizeResult(await client.query<R>(text, values as unknown[]));
          } catch (error) {
            throw toDatabaseError(error);
          }
        },
      };
      let result: T;
      await client.query('BEGIN');
      try {
        result = await fn(tx);
      } catch (error) {
        // An error thrown by the caller's own work is not a database failure:
        // a wallet refusal, an exhausted limit or a domain conflict must reach
        // the caller as itself, or every refusal in the app turns into "the
        // database rejected the statement". Errors from `tx.query` are already
        // DatabaseError and are rethrown unchanged.
        try {
          await client.query('ROLLBACK');
        } catch {
          // A rollback can fail when the connection itself died. The caller's
          // error is still the useful one.
        }
        client.release();
        throw error;
      }
      try {
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // See above.
        }
        throw toDatabaseError(error);
      } finally {
        client.release();
      }
    },
    async health(): Promise<DatabaseHealth> {
      const started = Date.now();
      const counts = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };
      if (closed) {
        return { status: 'unavailable', latencyMs: 0, pool: counts, reason: 'unavailable' };
      }
      try {
        await pool.query('SELECT 1');
        return { status: 'ok', latencyMs: Date.now() - started, pool: counts, reason: null };
      } catch (error) {
        return {
          status: 'unavailable',
          latencyMs: Date.now() - started,
          pool: counts,
          reason: toDatabaseError(error).category,
        };
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.end();
    },
    get closed() {
      return closed;
    },
  };
  return database;
}
