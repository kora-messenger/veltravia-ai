/** Typed, scrubbed errors for connected-app operations. Messages never carry
 *  credentials, tokens or raw provider payloads. */

export const CONNECTED_APP_ERROR_CODES = [
  'CONNECTED_INVALID_REQUEST',
  'CONNECTED_PROVIDER_UNKNOWN',
  'CONNECTED_NOT_CONNECTED',
  'CONNECTED_REVOKED',
  'CONNECTED_EXPIRED',
  'CONNECTED_INSUFFICIENT_SCOPE',
  'CONNECTED_CAPABILITY_UNSUPPORTED',
  'CONNECTED_RESOURCE_NOT_FOUND',
  'CONNECTED_RESOURCE_FORBIDDEN',
  'CONNECTED_PROVIDER_UNAVAILABLE',
  'CONNECTED_PROVIDER_ERROR',
  'CONNECTED_RATE_LIMITED',
  'CONNECTED_TIMEOUT',
  'CONNECTED_LIMIT_EXCEEDED',
  'CONNECTED_CONTENT_UNSUPPORTED',
  'CONNECTED_SECRET_REJECTED',
  'CONNECTED_UNSAFE_URL',
  'CONNECTED_PARSE_FAILED',
] as const;

export type ConnectedAppErrorCode = (typeof CONNECTED_APP_ERROR_CODES)[number];

export class ConnectedAppError extends Error {
  constructor(
    readonly code: ConnectedAppErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ConnectedAppError';
  }

  get retriable(): boolean {
    return this.code === 'CONNECTED_RATE_LIMITED' || this.code === 'CONNECTED_PROVIDER_UNAVAILABLE';
  }
}

export function isConnectedAppError(value: unknown): value is ConnectedAppError {
  return value instanceof ConnectedAppError;
}
