/**
 * Structured database errors.
 *
 * Every failure crossing the storage boundary is a `DatabaseError` with a
 * stable category the API can map to an HTTP status, and a message that never
 * contains SQL text, parameters or the connection string. The PostgreSQL
 * SQLSTATE is preserved on the error so operators can diagnose without the
 * application leaking anything.
 */

export type DatabaseErrorCategory =
  /** The database could not be reached, or the pool is exhausted. */
  | 'unavailable'
  /** A statement was rejected (constraint, type, syntax). */
  | 'query'
  /** A uniqueness constraint rejected the write. */
  | 'conflict'
  /** A foreign key or check constraint rejected the write. */
  | 'constraint'
  /** A transaction was rolled back because the caller lost a race. */
  | 'serialization'
  /** The caller had no owner scope, or a scope that does not match the row. */
  | 'owner'
  /** Migrations are missing or the schema is older than the code expects. */
  | 'schema';

export class DatabaseError extends Error {
  readonly category: DatabaseErrorCategory;
  /** PostgreSQL SQLSTATE, when the server produced one. */
  readonly sqlState: string | null;
  /** Constraint name for constraint violations, never a value. */
  readonly constraint: string | null;

  constructor(
    category: DatabaseErrorCategory,
    message: string,
    options: { sqlState?: string | null; constraint?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DatabaseError';
    this.category = category;
    this.sqlState = options.sqlState ?? null;
    this.constraint = options.constraint ?? null;
  }
}

/** The caller has no owner scope on the async context. */
export class OwnerScopeMissingError extends DatabaseError {
  constructor() {
    super(
      'owner',
      'A database operation ran without an owner scope. Every project, revision and record read is owner-scoped.',
    );
    this.name = 'OwnerScopeMissingError';
  }
}

/** The caller's scope does not own the row it tried to write. */
export class OwnerScopeMismatchError extends DatabaseError {
  constructor() {
    // No owner value and no record id: a mismatch must not confirm existence.
    super('owner', 'The record does not belong to the calling owner.');
    this.name = 'OwnerScopeMismatchError';
  }
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

const UNAVAILABLE_STATES = new Set([
  '08000',
  '08001',
  '08003',
  '08006',
  '08004',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

function isPostgresError(value: unknown): value is PostgresErrorLike {
  return typeof value === 'object' && value !== null;
}

/**
 * Classifies a driver error. The original error is kept as `cause` for a
 * server-side log; the message here is safe to surface.
 */
export function toDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const code = isPostgresError(error) && typeof error.code === 'string' ? error.code : null;
  const constraint =
    isPostgresError(error) && typeof error.constraint === 'string' ? error.constraint : null;

  if (code === null) {
    // No SQLSTATE: a socket, DNS or pool-level failure.
    return new DatabaseError('unavailable', 'The database is unavailable.', { cause: error });
  }
  if (UNAVAILABLE_STATES.has(code)) {
    return new DatabaseError('unavailable', 'The database is unavailable.', {
      sqlState: code,
      cause: error,
    });
  }
  if (code === UNIQUE_VIOLATION) {
    return new DatabaseError('conflict', 'A record with that identity already exists.', {
      sqlState: code,
      constraint,
      cause: error,
    });
  }
  if (code === FOREIGN_KEY_VIOLATION) {
    return new DatabaseError('constraint', 'A referenced record does not exist.', {
      sqlState: code,
      constraint,
      cause: error,
    });
  }
  if (code === CHECK_VIOLATION || code === NOT_NULL_VIOLATION) {
    return new DatabaseError('constraint', 'The record does not satisfy the schema constraints.', {
      sqlState: code,
      constraint,
      cause: error,
    });
  }
  if (code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED) {
    return new DatabaseError(
      'serialization',
      'The write lost a race with a concurrent transaction and was not applied.',
      { sqlState: code, cause: error },
    );
  }
  return new DatabaseError('query', 'The database rejected the operation.', {
    sqlState: code,
    constraint,
    cause: error,
  });
}

/** Maps a storage failure to an HTTP status. Kept beside the error types so
 * routes never invent their own mapping. */
export function databaseHttpStatus(error: unknown): number {
  if (!(error instanceof DatabaseError)) return 500;
  switch (error.category) {
    case 'unavailable':
      return 503;
    case 'conflict':
      return 409;
    case 'constraint':
    case 'query':
      return 400;
    case 'serialization':
      return 409;
    case 'owner':
      return 404;
    case 'schema':
      return 500;
    default:
      return 500;
  }
}
