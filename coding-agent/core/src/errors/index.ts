/**
 * Typed, scrubbed Coding Agent errors. Error surfaces never expose secrets,
 * host paths, credentials, or internal security data.
 */

export const CODING_ERROR_CODES = [
  'CODING_INVALID_REQUEST',
  'CODING_SECRET_REJECTED',
  'CODING_PROJECT_NOT_FOUND',
  'CODING_WORKSPACE_NOT_FOUND',
  'CODING_PROJECT_NOT_ACTIVE',
  'CODING_INVALID_PLAN',
  'CODING_PLAN_REJECTED',
  'CODING_INVALID_DECISION',
  'CODING_STALE_REVISION',
  'CODING_RUN_NOT_FOUND',
  'CODING_RUN_TERMINAL',
  'CODING_NOT_AWAITING_APPROVAL',
  'CODING_INVALID_TRANSITION',
  'CODING_TOOL_CALL_LIMIT',
  'CODING_ITERATION_LIMIT',
  'CODING_DURATION_LIMIT',
  'CODING_CONSECUTIVE_FAILURES',
  'CODING_CANCELLED',
] as const;

export type CodingErrorCode = (typeof CODING_ERROR_CODES)[number];

/** Secret-shaped patterns scrubbed from every coding-agent error and audit surface. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIzaSy[A-Za-z0-9_-]{10,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{15,}/g,
  /eyJhbGciOi[A-Za-z0-9._-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:api[_-]?key|secret|password|token|credential)s?\s*[:=]\s*\S+/gi,
  /\b(?:postgres(?:ql)?|mongodb(?:\+\w+)?|mysql|redis|amqp):\/\/[^\s'"<>]+/gi,
];

/** Scrubs secret-shaped substrings from any text used in errors/audit. */
export function scrubCodingSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text);
}

export interface CodingErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class CodingError extends Error {
  readonly code: CodingErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CodingErrorCode, message: string, options: CodingErrorOptions = {}) {
    super(scrubCodingSecrets(message));
    this.name = 'CodingError';
    this.code = code;
    // Details are scrubbed too: no secret can ride along inside error data.
    this.details =
      options.details === undefined || Object.keys(options.details).length === 0
        ? {}
        : (JSON.parse(scrubCodingSecrets(JSON.stringify(options.details))) as Record<
            string,
            unknown
          >);
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isCodingError(error: unknown): error is CodingError {
  return error instanceof CodingError;
}

/** Normalizes unknown failures into a typed, scrubbed coding error. */
export function toCodingError(error: unknown, fallbackMessage = 'unexpected failure'): CodingError {
  if (isCodingError(error)) return error;
  const message = scrubCodingSecrets(
    error instanceof Error ? (error.message ?? fallbackMessage) : fallbackMessage,
  );
  return new CodingError('CODING_INVALID_REQUEST', message);
}
