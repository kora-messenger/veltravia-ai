/**
 * Typed, scrubbed errors for Codebase Intelligence (Step 16).
 *
 * Error messages NEVER include source file content, secret-shaped values,
 * or host filesystem paths. They carry a stable machine code and a
 * bounded, scrubbed human message.
 */

export const CODEBASE_ERROR_CODES = [
  'CODEBASE_INVALID_REQUEST',
  'CODEBASE_PROJECT_NOT_FOUND',
  'CODEBASE_WORKSPACE_NOT_FOUND',
  'CODEBASE_WORKSPACE_MISMATCH',
  'CODEBASE_INDEX_NOT_FOUND',
  'CODEBASE_INDEX_STALE',
  'CODEBASE_INDEX_BUILD_IN_PROGRESS',
  'CODEBASE_INDEX_BUILD_FAILED',
  'CODEBASE_CANCELLED',
  'CODEBASE_LIMIT_EXCEEDED',
  'CODEBASE_SYMBOL_NOT_FOUND',
  'CODEBASE_FILE_NOT_FOUND',
  'CODEBASE_SOURCE_READ_FAILED',
  'CODEBASE_PARSE_ERROR',
] as const;

export type CodebaseErrorCode = (typeof CODEBASE_ERROR_CODES)[number];

export function isCodebaseErrorCode(value: unknown): value is CodebaseErrorCode {
  return typeof value === 'string' && (CODEBASE_ERROR_CODES as readonly string[]).includes(value);
}

/** Strip control characters and clamp length so untrusted source data never leaks through messages. */
export function scrubCodebaseText(input: string, maxLength = 300): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}…`;
}

export class CodebaseError extends Error {
  readonly code: CodebaseErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: CodebaseErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = 'CodebaseError';
    this.code = code;
    this.details = details;
  }
}

export function isCodebaseError(error: unknown): error is CodebaseError {
  return (
    error instanceof CodebaseError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'CodebaseError' &&
      isCodebaseErrorCode((error as { code?: unknown }).code))
  );
}

/** Maps provider read failures onto the typed error, scrubbing any host detail. */
export function toCodebaseReadError(error: unknown, path: string): CodebaseError {
  if (isCodebaseError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : 'unknown source read failure';
  return new CodebaseError('CODEBASE_SOURCE_READ_FAILED', `failed to read source file ${path}`, {
    cause: scrubCodebaseText(message, 120),
  });
}
