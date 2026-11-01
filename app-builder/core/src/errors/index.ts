/**
 * Typed, scrubbed errors for the App Builder (Step 30).
 *
 * Messages never carry project file content, secret-shaped values, provider
 * credentials or host paths: they name a machine code and a bounded message.
 */

export const APP_BUILDER_ERROR_CODES = [
  'APP_BUILDER_INVALID_REQUEST',
  'APP_BUILDER_UNKNOWN_TECHNOLOGY',
  'APP_BUILDER_UNSUPPORTED_TECHNOLOGY',
  'APP_BUILDER_INVALID_SPECIFICATION',
  'APP_BUILDER_STACK_MISMATCH',
  'APP_BUILDER_PLAN_NOT_FOUND',
  'APP_BUILDER_PLAN_ALREADY_MATERIALIZED',
  'APP_BUILDER_PROJECT_NOT_FOUND',
  'APP_BUILDER_WORKSPACE_NOT_FOUND',
  'APP_BUILDER_LIMIT_EXCEEDED',
  'APP_BUILDER_SECRET_REJECTED',
  'APP_BUILDER_NOT_AVAILABLE',
  'APP_BUILDER_MATERIALIZE_FAILED',
] as const;

export type AppBuilderErrorCode = (typeof APP_BUILDER_ERROR_CODES)[number];

export function isAppBuilderErrorCode(value: unknown): value is AppBuilderErrorCode {
  return (
    typeof value === 'string' && (APP_BUILDER_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Strip control characters and clamp length so untrusted text never leaks out. */
export function scrubAppBuilderText(input: string, maxLength = 300): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}…`;
}

export class AppBuilderError extends Error {
  readonly code: AppBuilderErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: AppBuilderErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${scrubAppBuilderText(message)}`);
    this.name = 'AppBuilderError';
    this.code = code;
    this.details = details;
  }
}

export function isAppBuilderError(value: unknown): value is AppBuilderError {
  return value instanceof AppBuilderError;
}

/** HTTP status for a code, so routes never invent their own mapping. */
export function appBuilderHttpStatus(code: AppBuilderErrorCode): number {
  switch (code) {
    case 'APP_BUILDER_INVALID_REQUEST':
    case 'APP_BUILDER_INVALID_SPECIFICATION':
    case 'APP_BUILDER_SECRET_REJECTED':
      return 400;
    case 'APP_BUILDER_UNKNOWN_TECHNOLOGY':
    case 'APP_BUILDER_PLAN_NOT_FOUND':
    case 'APP_BUILDER_PROJECT_NOT_FOUND':
    case 'APP_BUILDER_WORKSPACE_NOT_FOUND':
      return 404;
    case 'APP_BUILDER_UNSUPPORTED_TECHNOLOGY':
    case 'APP_BUILDER_STACK_MISMATCH':
    case 'APP_BUILDER_PLAN_ALREADY_MATERIALIZED':
      return 409;
    case 'APP_BUILDER_LIMIT_EXCEEDED':
      return 413;
    case 'APP_BUILDER_NOT_AVAILABLE':
      return 503;
    case 'APP_BUILDER_MATERIALIZE_FAILED':
      return 502;
    default:
      return 500;
  }
}
