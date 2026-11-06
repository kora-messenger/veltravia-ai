/**
 * Database configuration, read from the environment.
 *
 * The connection string is treated as a credential: it is never logged, never
 * echoed in an error and never included in a health payload. Everything a log
 * line or an operator may see goes through `describeDatabaseConfig`, which
 * exposes host/port/database only.
 */

export type DatabaseSslMode = 'disable' | 'require' | 'verify';

export interface DatabaseConfig {
  /** Full connection string. Never log this field. */
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly ssl: DatabaseSslMode;
  readonly maxConnections: number;
  readonly idleTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
  /** True when the URL points at loopback; local development only. */
  readonly loopback: boolean;
}

export class DatabaseConfigurationError extends Error {
  /** Which setting was wrong. Never contains the value. */
  readonly setting: string;

  constructor(setting: string, message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
    this.setting = setting;
  }
}

const DEFAULT_APPLICATION_NAME = 'veltravia-ai';

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DatabaseConfigurationError(
      name,
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

function readSslMode(env: NodeJS.ProcessEnv, loopback: boolean): DatabaseSslMode {
  const raw = env.VELTRAVIA_DB_SSL?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    // Local development over loopback stays plaintext; anything else must be
    // encrypted so a misconfigured production deployment cannot leak traffic.
    return loopback ? 'disable' : 'require';
  }
  if (raw === 'disable' || raw === 'require' || raw === 'verify') return raw;
  throw new DatabaseConfigurationError(
    'VELTRAVIA_DB_SSL',
    'VELTRAVIA_DB_SSL must be one of: disable, require, verify.',
  );
}

/**
 * Parses a connection string into a config. Throws a typed error rather than
 * returning a partially valid config, so the server refuses to start on bad
 * input instead of failing on the first query.
 */
export function parseDatabaseUrl(url: string, env: NodeJS.ProcessEnv = {}): DatabaseConfig {
  if (url.trim() === '') {
    throw new DatabaseConfigurationError('VELTRAVIA_DATABASE_URL', 'The database URL is empty.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Deliberately does not include the URL itself.
    throw new DatabaseConfigurationError(
      'VELTRAVIA_DATABASE_URL',
      'The database URL is not a valid URL.',
    );
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new DatabaseConfigurationError(
      'VELTRAVIA_DATABASE_URL',
      'The database URL must use the postgres:// or postgresql:// scheme.',
    );
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (database === '') {
    throw new DatabaseConfigurationError(
      'VELTRAVIA_DATABASE_URL',
      'The database URL must name a database.',
    );
  }
  const host = parsed.hostname === '' ? 'localhost' : parsed.hostname;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const port = parsed.port === '' ? 5432 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DatabaseConfigurationError(
      'VELTRAVIA_DATABASE_URL',
      'The database URL has an invalid port.',
    );
  }

  return {
    connectionString: url,
    host,
    port,
    database,
    ssl: readSslMode(env, loopback),
    maxConnections: readInt(env, 'VELTRAVIA_DB_POOL_MAX', 10, 1, 100),
    idleTimeoutMs: readInt(env, 'VELTRAVIA_DB_IDLE_TIMEOUT_MS', 10_000, 1_000, 600_000),
    connectionTimeoutMs: readInt(env, 'VELTRAVIA_DB_CONNECT_TIMEOUT_MS', 10_000, 500, 120_000),
    statementTimeoutMs: readInt(env, 'VELTRAVIA_DB_STATEMENT_TIMEOUT_MS', 15_000, 1_000, 300_000),
    applicationName: env.VELTRAVIA_DB_APPLICATION_NAME?.trim() || DEFAULT_APPLICATION_NAME,
    loopback,
  };
}

/**
 * Reads the configured database, or null when none is configured. Null means
 * "run with the in-memory stores", which is what tests and a bare development
 * server do. Production refuses to start without a database (see
 * `deployment/config.ts`).
 */
export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig | null {
  const url = env.VELTRAVIA_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || '';
  if (url === '') return null;
  return parseDatabaseUrl(url, env);
}

/** Safe, loggable summary. Contains no user, password or connection string. */
export function describeDatabaseConfig(config: DatabaseConfig): {
  host: string;
  port: number;
  database: string;
  ssl: DatabaseSslMode;
  maxConnections: number;
} {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    ssl: config.ssl,
    maxConnections: config.maxConnections,
  };
}
