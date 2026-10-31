/**
 * Typed reasoning errors. Every message is safe to return to a caller: it
 * never contains a credential, a raw provider payload or hidden reasoning.
 */

export const REASONING_ERROR_CODES = [
  'REASONING_INVALID_REQUEST',
  'REASONING_INVALID_MODEL_OUTPUT',
  'REASONING_TOOL_NOT_ALLOWED',
  'REASONING_TOOL_INPUT_INVALID',
  'REASONING_PROVIDER_UNAVAILABLE',
  'REASONING_PROVIDER_AUTH_FAILED',
  'REASONING_PROVIDER_RATE_LIMITED',
  'REASONING_PROVIDER_TIMEOUT',
  'REASONING_PROVIDER_ERROR',
  'REASONING_LIMIT_EXCEEDED',
  'REASONING_CANCELLED',
  'REASONING_RUN_NOT_FOUND',
  'REASONING_RUN_STATE',
  'REASONING_RUN_NOT_CANCELLABLE',
  'REASONING_CONFIRMATION_INVALID',
  'REASONING_TOOL_UNAVAILABLE',
  'REASONING_TOOL_FAILED',
  'REASONING_CONTEXT_REJECTED',
  'REASONING_SECRET_REJECTED',
  'REASONING_DUPLICATE_REQUEST',
  'REASONING_UNKNOWN_PROFILE',
] as const;

export type ReasoningErrorCode = (typeof REASONING_ERROR_CODES)[number];

export class ReasoningError extends Error {
  readonly code: ReasoningErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ReasoningErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ReasoningError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isReasoningError(error: unknown): error is ReasoningError {
  return error instanceof ReasoningError;
}

/** Failure categories that are worth one bounded retry. Others never retry. */
const RETRYABLE: ReadonlySet<ReasoningErrorCode> = new Set([
  'REASONING_PROVIDER_RATE_LIMITED',
  'REASONING_PROVIDER_TIMEOUT',
  'REASONING_PROVIDER_UNAVAILABLE',
]);

export function isRetryableReasoningError(error: unknown): boolean {
  return isReasoningError(error) && RETRYABLE.has(error.code);
}

/** Errors a caller should treat as a bad request rather than a server fault. */
const CLIENT_CODES: ReadonlySet<ReasoningErrorCode> = new Set([
  'REASONING_INVALID_REQUEST',
  'REASONING_TOOL_NOT_ALLOWED',
  'REASONING_TOOL_INPUT_INVALID',
  'REASONING_RUN_NOT_FOUND',
  'REASONING_RUN_STATE',
  'REASONING_CONFIRMATION_INVALID',
  'REASONING_TOOL_UNAVAILABLE',
  'REASONING_TOOL_FAILED',
  'REASONING_CONTEXT_REJECTED',
  'REASONING_SECRET_REJECTED',
  'REASONING_DUPLICATE_REQUEST',
  'REASONING_UNKNOWN_PROFILE',
]);

export function reasoningHttpStatus(code: ReasoningErrorCode): number {
  if (CLIENT_CODES.has(code)) {
    return code === 'REASONING_RUN_NOT_FOUND' ? 404 : 400;
  }
  if (code === 'REASONING_PROVIDER_AUTH_FAILED') return 502;
  if (code === 'REASONING_PROVIDER_UNAVAILABLE') return 503;
  if (code === 'REASONING_LIMIT_EXCEEDED') return 429;
  if (code === 'REASONING_CANCELLED') return 409;
  if (code === 'REASONING_RUN_NOT_CANCELLABLE') return 409;
  if (code === 'REASONING_INVALID_MODEL_OUTPUT') return 502;
  return 502;
}

/**
 * Scrubs anything credential-shaped from text that leaves the engine. The
 * provider gateway already scrubs its own errors; this is defense in depth
 * for text the engine composes itself.
 */
export function scrubReasoningText(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, '[redacted]');
}
