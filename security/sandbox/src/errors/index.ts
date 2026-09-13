/**
 * Sandbox typed errors - scrubbed, coded, and safe to cross the API boundary.
 * Error messages and details NEVER contain secrets, environment values, or
 * raw untrusted output.
 */

export const SANDBOX_ERROR_CODES = [
  'SANDBOX_INVALID_REQUEST',
  'SANDBOX_POLICY_REJECTED',
  'SANDBOX_COMMAND_NOT_ALLOWED',
  'SANDBOX_ENVIRONMENT_REJECTED',
  'SANDBOX_NETWORK_REJECTED',
  'SANDBOX_LIMITS_REJECTED',
  'SANDBOX_NOT_FOUND',
  'EXECUTION_NOT_FOUND',
  'SANDBOX_INVALID_TRANSITION',
  'SANDBOX_EXPIRED',
  'SANDBOX_NOT_READY',
  'SANDBOX_FAILED',
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

/** Base class for every sandbox error. `toJSON()` is the API-safe shape. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  /** Structured context - fields and rules only, never values. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: SandboxErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): { code: SandboxErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

export class InvalidSandboxRequestError extends SandboxError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('SANDBOX_INVALID_REQUEST', `Invalid sandbox request: ${message}`, details);
    this.name = 'InvalidSandboxRequestError';
  }
}

/** Creation-time profile validation failure (policy shape, allowlist, etc.). */
export class SandboxPolicyRejectedError extends SandboxError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('SANDBOX_POLICY_REJECTED', `Sandbox policy rejected: ${message}`, details);
    this.name = 'SandboxPolicyRejectedError';
  }
}

export class CommandNotAllowedError extends SandboxError {
  constructor(command: string, reason: string) {
    // The command NAME is part of the request (caller-controlled, validated
    // shape) - echoing it is safe and required for debugging; values that
    // failed shape validation are never echoed.
    super('SANDBOX_COMMAND_NOT_ALLOWED', `Command not allowed: ${reason}`, { command });
    this.name = 'CommandNotAllowedError';
  }
}

export class EnvironmentRejectedError extends SandboxError {
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super('SANDBOX_ENVIRONMENT_REJECTED', `Environment rejected: ${reason}`, details);
    this.name = 'EnvironmentRejectedError';
  }
}

export class NetworkPolicyRejectedError extends SandboxError {
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super('SANDBOX_NETWORK_REJECTED', `Network policy rejected: ${reason}`, details);
    this.name = 'NetworkPolicyRejectedError';
  }
}

export class LimitsRejectedError extends SandboxError {
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super('SANDBOX_LIMITS_REJECTED', `Resource limits rejected: ${reason}`, details);
    this.name = 'LimitsRejectedError';
  }
}

export class SandboxNotFoundError extends SandboxError {
  constructor(sandboxId: string) {
    super('SANDBOX_NOT_FOUND', `No sandbox found with id "${sandboxId}".`, { sandboxId });
    this.name = 'SandboxNotFoundError';
  }
}

export class ExecutionNotFoundError extends SandboxError {
  constructor(executionId: string) {
    super('EXECUTION_NOT_FOUND', `No execution found with id "${executionId}".`, { executionId });
    this.name = 'ExecutionNotFoundError';
  }
}

/** Illegal lifecycle transition (e.g. destroyed -> running, stopped -> running). */
export class InvalidSandboxTransitionError extends SandboxError {
  constructor(from: string, to: string) {
    super(
      'SANDBOX_INVALID_TRANSITION',
      `Invalid sandbox transition: ${from} -> ${to}.`,
      { from, to },
    );
    this.name = 'InvalidSandboxTransitionError';
  }
}

export class SandboxExpiredError extends SandboxError {
  constructor(sandboxId: string, expiresAt: string) {
    super('SANDBOX_EXPIRED', `Sandbox "${sandboxId}" expired at ${expiresAt}.`, {
      sandboxId,
      expiresAt,
    });
    this.name = 'SandboxExpiredError';
  }
}

export class SandboxNotReadyError extends SandboxError {
  constructor(sandboxId: string, status: string) {
    super('SANDBOX_NOT_READY', `Sandbox "${sandboxId}" is ${status}; execution is rejected.`, {
      sandboxId,
      status,
    });
    this.name = 'SandboxNotReadyError';
  }
}

export function isSandboxError(value: unknown): value is SandboxError {
  return value instanceof SandboxError;
}
