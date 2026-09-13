/**
 * Typed connector error system.
 *
 * Every failure inside the connector framework is a ConnectorError subclass
 * with a stable machine code - mirroring the AI Core error design so the
 * whole platform has one error philosophy. Vendor-specific error shapes must
 * never leave a future connector; they are normalized at the boundary.
 *
 * SECURITY: the base constructor scrubs token/secret-looking substrings out
 * of the message and of any `details` strings, so a credential that
 * accidentally reaches an error can never leak through `message`, `details`,
 * or `toJSON()`. Tests assert this.
 */

/** Stable machine-readable error codes (registry-unique). */
export const CONNECTOR_ERROR_CODES = [
  'CONNECTOR_NOT_FOUND',
  'DUPLICATE_CONNECTOR',
  'INVALID_CONNECTOR',
  'CONNECTOR_CONFIGURATION',
  'CONNECTOR_AUTHENTICATION',
  'CONNECTOR_PERMISSION',
  'CONNECTOR_OPERATION',
  'CONNECTOR_CONNECTION',
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/** Redacts common token/secret shapes from free text before it can surface. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '[REDACTED]')
    .replace(/sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/xox[bpars]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[_-]?key|token|password|secret)\b(\s*[:=]\s*)(["']?)[^"'\s]{8,}\3/gi,
      '$1$2[REDACTED]',
    )
    .replace(/[A-Fa-f0-9]{40,}/g, '[REDACTED]');
}

/** Recursively scrubs secret-like strings out of structured detail values. */
export function scrubDetails(details: unknown): unknown {
  if (typeof details === 'string') return redactSecrets(details);
  if (Array.isArray(details)) return details.map(scrubDetails);
  if (details !== null && typeof details === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) out[key] = scrubDetails(value);
    return out;
  }
  return details;
}

export interface ConnectorErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Base class for every connector-framework failure. */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ConnectorErrorCode, message: string, options: ConnectorErrorOptions = {}) {
    super(redactSecrets(message), { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options.details !== undefined) {
      this.details = scrubDetails(options.details) as Readonly<Record<string, unknown>>;
    }
  }

  /** Serializable, stack-free, secret-free representation for API surfaces. */
  toJSON(): { code: ConnectorErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: { ...this.details } };
  }
}

/** A connector id was used that is not registered. */
export class ConnectorNotFoundError extends ConnectorError {
  constructor(connectorId: string) {
    super('CONNECTOR_NOT_FOUND', `No connector registered with id "${connectorId}".`, {
      details: { connectorId },
    });
  }
}

/** A connector was registered with an id that already exists. */
export class DuplicateConnectorError extends ConnectorError {
  constructor(connectorId: string) {
    super('DUPLICATE_CONNECTOR', `A connector with id "${connectorId}" is already registered.`, {
      details: { connectorId },
    });
  }
}

/** A connector implementation failed structural validation. */
export class InvalidConnectorError extends ConnectorError {
  /** All validation problems, joined into the message for greppable errors. */
  constructor(reasons: readonly string[]) {
    super('INVALID_CONNECTOR', `Invalid connector: ${reasons.join('; ')}.`, {
      details: { reasons: [...reasons] },
    });
  }
}

/** A connector is misconfigured (bad options, missing required settings). */
export class ConnectorConfigurationError extends ConnectorError {
  constructor(connectorId: string, reason: string, options: ConnectorErrorOptions = {}) {
    super('CONNECTOR_CONFIGURATION', `Connector "${connectorId}" is misconfigured: ${reason}`, {
      ...options,
      details: { connectorId, ...(options.details ?? {}) },
    });
  }
}

/** A connector's credentials were rejected or are missing/expired/revoked. */
export class ConnectorAuthenticationError extends ConnectorError {
  constructor(connectorId: string, reason: string, options: ConnectorErrorOptions = {}) {
    super(
      'CONNECTOR_AUTHENTICATION',
      `Connector "${connectorId}" could not authenticate: ${reason}`,
      {
        ...options,
        details: { connectorId, ...(options.details ?? {}) },
      },
    );
  }
}

/** A permission requirement was not satisfied (not granted, not declared). */
export class ConnectorPermissionError extends ConnectorError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('CONNECTOR_PERMISSION', message, { details });
  }
}

/** An operation is unknown, malformed, or failed (execution itself is Step 5). */
export class ConnectorOperationError extends ConnectorError {
  constructor(
    connectorId: string,
    operationId: string,
    reason: string,
    options: ConnectorErrorOptions = {},
  ) {
    super(
      'CONNECTOR_OPERATION',
      `Operation "${operationId}" on connector "${connectorId}" failed: ${reason}`,
      {
        ...options,
        details: { connectorId, operationId, ...(options.details ?? {}) },
      },
    );
  }
}

/** A connector lifecycle transition (connect/disconnect) failed. */
export class ConnectorConnectionError extends ConnectorError {
  constructor(connectorId: string, reason: string, options: ConnectorErrorOptions = {}) {
    super(
      'CONNECTOR_CONNECTION',
      `Connector "${connectorId}" connection attempt failed: ${reason}`,
      {
        ...options,
        details: { connectorId, ...(options.details ?? {}) },
      },
    );
  }
}

/** Type guard for ConnectorError (works across compiled/js source copies). */
export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError;
}
