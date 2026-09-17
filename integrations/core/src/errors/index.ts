import { redactSecrets, scrubDetails } from '@veltravia/connector-core';

/**
 * Typed, sanitized integration errors.
 *
 * Mirrors the connector error philosophy: a stable machine code, a
 * message scrubbed of any credential shape, and a stack-free JSON surface
 * for the API. External provider failures are ALWAYS wrapped/sanitized
 * here - authorization headers and credentials can never leak upward.
 */

export const INTEGRATION_ERROR_CODES = [
  'INTEGRATION_NOT_FOUND',
  'INTEGRATION_DUPLICATE',
  'INTEGRATION_INVALID',
  'INTEGRATION_DISABLED',
  'INTEGRATION_IN_USE',
  'CONNECTION_NOT_FOUND',
  'CONNECTION_NOT_AUTHORIZED',
  'CONNECTION_LIMIT_REACHED',
  'MISSING_SCOPE',
  'INTEGRATION_EXECUTION_FAILED',
  'INTEGRATION_CREDENTIAL_UNAVAILABLE',
  'INTEGRATION_CONFIGURATION_INVALID',
] as const;

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

export function isIntegrationErrorCode(value: unknown): value is IntegrationErrorCode {
  return (
    typeof value === 'string' && (INTEGRATION_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface IntegrationErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Base class for every integration-framework failure. */
export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: IntegrationErrorCode, message: string, options: IntegrationErrorOptions = {}) {
    super(redactSecrets(message), { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options.details !== undefined) {
      this.details = scrubDetails(options.details) as Readonly<Record<string, unknown>>;
    }
  }

  /** Serializable, stack-free, secret-free representation for API surfaces. */
  toJSON(): { code: IntegrationErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: { ...this.details } };
  }
}

export function isIntegrationError(error: unknown): error is IntegrationError {
  return error instanceof IntegrationError;
}

/** The integration id requested is not registered. */
export class IntegrationNotFoundError extends IntegrationError {
  constructor(integrationId: string) {
    super('INTEGRATION_NOT_FOUND', `Integration "${integrationId}" is not registered.`, {
      details: { integrationId },
    });
  }
}

/** A different integration with the same id is already registered. */
export class DuplicateIntegrationError extends IntegrationError {
  constructor(integrationId: string) {
    super('INTEGRATION_DUPLICATE', `Integration "${integrationId}" is already registered.`, {
      details: { integrationId },
    });
  }
}

/** The integration definition or manifest violated the contract. */
export class InvalidIntegrationError extends IntegrationError {
  constructor(reasons: readonly string[]) {
    super('INTEGRATION_INVALID', `Invalid integration: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
  }
}

/** The integration is disabled - no connection or operation may proceed. */
export class IntegrationDisabledError extends IntegrationError {
  constructor(integrationId: string) {
    super('INTEGRATION_DISABLED', `Integration "${integrationId}" is disabled.`, {
      details: { integrationId },
    });
  }
}

/** The integration still has connections - it cannot be removed. */
export class IntegrationInUseError extends IntegrationError {
  constructor(integrationId: string, activeConnections: number) {
    super(
      'INTEGRATION_IN_USE',
      `Integration "${integrationId}" still has ${String(activeConnections)} connection(s) - disconnect them before removing it.`,
      { details: { integrationId, activeConnections } },
    );
  }
}

/** The connection id does not exist - or exists outside the owner boundary. */
export class ConnectionNotFoundError extends IntegrationError {
  constructor(connectionId: string, ownerLabel?: string) {
    super(
      'CONNECTION_NOT_FOUND',
      ownerLabel === undefined
        ? `Connection "${connectionId}" does not exist.`
        : `Connection "${connectionId}" does not exist for owner "${ownerLabel}".`,
      { details: { connectionId } },
    );
  }
}

/** The connection exists but the owner is not allowed to act on it. */
export class ConnectionNotAuthorizedError extends IntegrationError {
  constructor(connectionId: string, ownerLabel: string) {
    super(
      'CONNECTION_NOT_AUTHORIZED',
      `Owner "${ownerLabel}" is not allowed to access connection "${connectionId}".`,
      { details: { connectionId } },
    );
  }
}

/** The owner hit the per-integration connection limit. */
export class ConnectionLimitReachedError extends IntegrationError {
  constructor(integrationId: string, limit: number) {
    super(
      'CONNECTION_LIMIT_REACHED',
      `Owner reached the connection limit (${String(limit)}) for integration "${integrationId}".`,
      { details: { integrationId, limit } },
    );
  }
}

/** The connection has not been granted a scope the operation requires. */
export class MissingScopeError extends IntegrationError {
  constructor(integrationId: string, missingScopes: readonly string[]) {
    super(
      'MISSING_SCOPE',
      `Integration "${integrationId}" is missing granted scope(s): ${missingScopes.join(', ')}.`,
      { details: { integrationId, missingScopes: [...missingScopes] } },
    );
  }
}

/** The operation execution failed - provider errors are sanitized here. */
export class IntegrationExecutionFailedError extends IntegrationError {
  constructor(integrationId: string, operationId: string, detail: string, cause?: unknown) {
    super('INTEGRATION_EXECUTION_FAILED', detail, {
      cause,
      details: { integrationId, operationId },
    });
  }
}

/** No credential is available for the connection inside the secret store. */
export class IntegrationCredentialUnavailableError extends IntegrationError {
  constructor(integrationId: string) {
    super(
      'INTEGRATION_CREDENTIAL_UNAVAILABLE',
      `No credential is available for integration "${integrationId}" - connect cannot proceed.`,
      { details: { integrationId } },
    );
  }
}

/** The requested connection configuration is not valid for this integration. */
export class IntegrationConfigurationInvalidError extends IntegrationError {
  constructor(integrationId: string, reasons: readonly string[]) {
    super(
      'INTEGRATION_CONFIGURATION_INVALID',
      `Connection configuration for "${integrationId}" is invalid: ${reasons.join('; ')}.`,
      { details: { integrationId, reasons: [...reasons] } },
    );
  }
}
