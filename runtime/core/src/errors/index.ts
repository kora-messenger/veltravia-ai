/**
 * Runtime typed errors - scrubbed, coded, and safe to cross the API boundary.
 * Error messages and details NEVER contain secrets, environment values, host
 * paths, infrastructure identifiers, or raw untrusted application output.
 */

export const RUNTIME_ERROR_CODES = [
  'RUNTIME_INVALID_REQUEST',
  'RUNTIME_PLAN_REJECTED',
  'RUNTIME_ENV_REJECTED',
  'RUNTIME_TYPE_UNSUPPORTED',
  'RUNTIME_NOT_FOUND',
  'RUNTIME_INVALID_TRANSITION',
  'RUNTIME_REVISION_MISMATCH',
  'RUNTIME_START_FAILED',
  'RUNTIME_EXPIRED',
  'RUNTIME_LIMIT_EXCEEDED',
  'RUNTIME_CANCELLED',
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

/** Base class for every runtime error. `toJSON()` is the API-safe shape. */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  /** Structured context - fields and rules only, never values. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RuntimeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): { code: RuntimeErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

export function isRuntimeError(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError;
}

export class InvalidRuntimeRequestError extends RuntimeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('RUNTIME_INVALID_REQUEST', `Invalid runtime request: ${message}`, details);
    this.name = 'InvalidRuntimeRequestError';
  }
}

/** Plan validation failure (command shape, port bounds, limits, evidence). */
export class RuntimePlanRejectedError extends RuntimeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('RUNTIME_PLAN_REJECTED', `Runtime plan rejected: ${message}`, details);
    this.name = 'RuntimePlanRejectedError';
  }
}

/** Secret-shaped environment entry - rejected before any runtime exists. */
export class RuntimeEnvironmentRejectedError extends RuntimeError {
  constructor(keyName: string) {
    super(
      'RUNTIME_ENV_REJECTED',
      'Runtime environment rejected: a declared entry is credential-shaped and cannot be passed to a preview runtime',
      { field: keyName },
    );
    this.name = 'RuntimeEnvironmentRejectedError';
  }
}

export class RuntimeTypeUnsupportedError extends RuntimeError {
  constructor(runtimeType: string, activeTypes: readonly string[]) {
    super(
      'RUNTIME_TYPE_UNSUPPORTED',
      `Runtime type "${runtimeType}" is not supported yet (active: ${activeTypes.join(', ')})`,
      { requested: runtimeType, active: [...activeTypes] },
    );
    this.name = 'RuntimeTypeUnsupportedError';
  }
}

export class RuntimeNotFoundError extends RuntimeError {
  constructor(runtimeId: string) {
    super('RUNTIME_NOT_FOUND', `Runtime "${runtimeId}" was not found`, { runtimeId });
    this.name = 'RuntimeNotFoundError';
  }
}

export class RuntimeInvalidTransitionError extends RuntimeError {
  constructor(from: string, to: string) {
    super('RUNTIME_INVALID_TRANSITION', `Cannot transition a runtime from "${from}" to "${to}"`, {
      from,
      to,
    });
    this.name = 'RuntimeInvalidTransitionError';
  }
}

export class RuntimeRevisionMismatchError extends RuntimeError {
  constructor(runtimeId: string, runtimeRevision: number, currentRevision: number) {
    super(
      'RUNTIME_REVISION_MISMATCH',
      `Runtime "${runtimeId}" is bound to revision ${runtimeRevision} but the workspace is at revision ${currentRevision} - restart the runtime to pick up the latest revision`,
      { runtimeId, runtimeRevision, currentRevision },
    );
    this.name = 'RuntimeRevisionMismatchError';
  }
}

export class RuntimeStartFailedError extends RuntimeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('RUNTIME_START_FAILED', `Runtime start failed: ${message}`, details);
    this.name = 'RuntimeStartFailedError';
  }
}

export class RuntimeExpiredError extends RuntimeError {
  constructor(runtimeId: string) {
    super('RUNTIME_EXPIRED', `Runtime "${runtimeId}" has expired`, { runtimeId });
    this.name = 'RuntimeExpiredError';
  }
}

export class RuntimeLimitExceededError extends RuntimeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('RUNTIME_LIMIT_EXCEEDED', `Runtime limit exceeded: ${message}`, details);
    this.name = 'RuntimeLimitExceededError';
  }
}

export class RuntimeCancelledError extends RuntimeError {
  constructor(runtimeId: string) {
    super('RUNTIME_CANCELLED', `Runtime "${runtimeId}" was cancelled`, { runtimeId });
    this.name = 'RuntimeCancelledError';
  }
}
