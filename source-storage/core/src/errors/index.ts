/**
 * Typed, scrubbed errors for native source storage (Step 31).
 *
 * Messages name a code and a bounded human sentence. They never include file
 * content, secret-shaped values or host paths.
 */

export const SOURCE_ERROR_CODES = [
  'SOURCE_INVALID_REQUEST',
  'SOURCE_REPOSITORY_NOT_FOUND',
  'SOURCE_PATH_INVALID',
  'SOURCE_PATH_NOT_FOUND',
  'SOURCE_PATH_CONFLICT',
  'SOURCE_REVISION_CONFLICT',
  'SOURCE_FILE_TOO_LARGE',
  'SOURCE_LIMIT_EXCEEDED',
  'SOURCE_CHANGE_SET_FAILED',
  'SOURCE_ROLLBACK_FAILED',
  'SOURCE_SNAPSHOT_NOT_FOUND',
  'SOURCE_SNAPSHOT_FAILED',
  'SOURCE_SECRET_REJECTED',
  'SOURCE_HISTORY_EMPTY',
] as const;

export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];

export function isSourceErrorCode(value: unknown): value is SourceErrorCode {
  return typeof value === 'string' && (SOURCE_ERROR_CODES as readonly string[]).includes(value);
}

/** Strip control characters and clamp length so untrusted text never leaks through messages. */
export function scrubSourceText(input: string, maxLength = 300): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}…`;
}

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SourceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${scrubSourceText(message)}`);
    this.name = 'SourceError';
    this.code = code;
    this.details = details;
  }
}

export function isSourceError(value: unknown): value is SourceError {
  return value instanceof SourceError;
}

/** HTTP status for each error code, so the API never guesses. */
export function sourceHttpStatus(code: SourceErrorCode): number {
  switch (code) {
    case 'SOURCE_INVALID_REQUEST':
    case 'SOURCE_PATH_INVALID':
      return 400;
    case 'SOURCE_SECRET_REJECTED':
      return 422;
    case 'SOURCE_REPOSITORY_NOT_FOUND':
    case 'SOURCE_PATH_NOT_FOUND':
    case 'SOURCE_SNAPSHOT_NOT_FOUND':
      return 404;
    case 'SOURCE_PATH_CONFLICT':
    case 'SOURCE_REVISION_CONFLICT':
      return 409;
    case 'SOURCE_FILE_TOO_LARGE':
      return 413;
    case 'SOURCE_LIMIT_EXCEEDED':
      return 422;
    case 'SOURCE_CHANGE_SET_FAILED':
    case 'SOURCE_ROLLBACK_FAILED':
    case 'SOURCE_SNAPSHOT_FAILED':
      return 500;
    case 'SOURCE_HISTORY_EMPTY':
      return 200;
    default:
      return 500;
  }
}
