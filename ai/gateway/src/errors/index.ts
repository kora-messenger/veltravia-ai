/**
 * Normalized gateway errors. Every provider failure is reduced to one of these
 * categories before it leaves the gateway, so vendor response text (which can
 * echo headers or key fragments) never reaches a caller, a log or the UI.
 */
export const GATEWAY_ERROR_CODES = [
  'GATEWAY_INVALID_REQUEST',
  'GATEWAY_PROVIDER_UNKNOWN',
  'GATEWAY_CONNECTION_NOT_FOUND',
  'GATEWAY_CONNECTION_FORBIDDEN',
  'GATEWAY_CONNECTION_DUPLICATE',
  'GATEWAY_CREDENTIAL_MISSING',
  'GATEWAY_CREDENTIAL_INVALID',
  'GATEWAY_VAULT_UNAVAILABLE',
  'GATEWAY_VAULT_DECRYPT_FAILED',
  'GATEWAY_UNSAFE_ENDPOINT',
  'GATEWAY_CAPABILITY_UNSUPPORTED',
  'GATEWAY_MODEL_UNKNOWN',
  'GATEWAY_NO_PROVIDER_CONFIGURED',
  'GATEWAY_RATE_LIMITED',
  'GATEWAY_TIMEOUT',
  'GATEWAY_PROVIDER_ERROR',
  'GATEWAY_PROVIDER_UNAVAILABLE',
  'GATEWAY_AUTH_FAILED',
  'GATEWAY_LIMIT_EXCEEDED',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export interface GatewayErrorOptions {
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly cause?: unknown;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(code: GatewayErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GatewayError';
    this.code = code;
    if (options.details) this.details = options.details;
  }

  toJSON(): {
    code: GatewayErrorCode;
    message: string;
    details?: Record<string, string | number | boolean>;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: { ...this.details } } : {}),
    };
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}

export function invalidRequest(message: string): GatewayError {
  return new GatewayError('GATEWAY_INVALID_REQUEST', message);
}

export function connectionNotFound(): GatewayError {
  return new GatewayError(
    'GATEWAY_CONNECTION_NOT_FOUND',
    'That provider connection does not exist.',
  );
}

/** A connection that exists but belongs to someone else looks exactly like a
 *  missing one to the caller: existence itself is owner-private. */
export function connectionForbidden(): GatewayError {
  return new GatewayError(
    'GATEWAY_CONNECTION_NOT_FOUND',
    'That provider connection does not exist.',
  );
}

/** The normalized provider failure categories used for usage records and views. */
export const PROVIDER_ERROR_CATEGORIES = [
  'auth',
  'rate_limited',
  'timeout',
  'unavailable',
  'bad_request',
  'unsupported',
  'unknown',
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

export function errorCategoryOf(error: unknown): ProviderErrorCategory {
  if (!isGatewayError(error)) return 'unknown';
  switch (error.code) {
    case 'GATEWAY_AUTH_FAILED':
    case 'GATEWAY_CREDENTIAL_INVALID':
      return 'auth';
    case 'GATEWAY_RATE_LIMITED':
      return 'rate_limited';
    case 'GATEWAY_TIMEOUT':
      return 'timeout';
    case 'GATEWAY_PROVIDER_UNAVAILABLE':
      return 'unavailable';
    case 'GATEWAY_INVALID_REQUEST':
    case 'GATEWAY_MODEL_UNKNOWN':
      return 'bad_request';
    case 'GATEWAY_CAPABILITY_UNSUPPORTED':
    case 'GATEWAY_UNSAFE_ENDPOINT':
      return 'unsupported';
    default:
      return 'unknown';
  }
}
