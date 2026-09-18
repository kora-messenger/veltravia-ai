/**
 * Typed Testing & Debugging Agent errors. Every message is scrubbed of
 * secret-shaped values before construction completes; nothing here ever
 * carries credentials, tokens, or raw environment contents.
 */

import { scrubSecretShapedValues } from './scrub.js';

export const TEST_ERROR_CODES = [
  'TESTING_INVALID_REQUEST',
  'TESTING_SECRET_REJECTED',
  'TESTING_UNSUPPORTED_PROJECT',
  'TESTING_INVALID_PLAN',
  'TESTING_PLAN_REJECTED',
  'TESTING_APPROVAL_REQUIRED',
  'TESTING_NOT_AWAITING_APPROVAL',
  'TESTING_RUN_NOT_FOUND',
  'TESTING_RUN_TERMINAL',
  'TESTING_INVALID_TRANSITION',
  'TESTING_COMMAND_LIMIT',
  'TESTING_REPAIR_LIMIT',
  'TESTING_REPAIR_REJECTED',
  'TESTING_REPAIR_FAILED',
  'TESTING_REVISION_CONFLICT',
  'TESTING_TEST_FAILED',
  'TESTING_INVALID_DIAGNOSIS',
  'TESTING_INVALID_REPAIR_PLAN',
  'TESTING_DEBUG_ERROR',
  'TESTING_CANCELLED',
] as const;

export type TestErrorCode = (typeof TEST_ERROR_CODES)[number];

const SECRET_KEY_PATTERNS = [/api[_-]?key/i, /secret/i, /token/i, /password/i, /credential/i];

/** Secret-shaped value patterns (GitHub, OpenAI-style, JWT, AWS-style). */
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{12,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** True when a string looks like a secret-shaped credential value. */
export function isSecretShaped(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** True when a key name itself marks its value as a credential. */
export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** Scrubs secret-shaped values from free text (bounded to sane size first). */
export function scrubTestingSecrets(input: string): string {
  return scrubSecretShapedValues(input);
}

export class TestingError extends Error {
  public readonly code: TestErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: TestErrorCode, message: string, options?: { details?: unknown }) {
    const safeMessage = scrubTestingSecrets(message).slice(0, 2000);
    super(safeMessage);
    this.name = 'TestingError';
    this.code = code;
    const rawDetails =
      typeof options?.details === 'object' && options?.details !== null
        ? (options.details as Record<string, unknown>)
        : undefined;
    this.details = rawDetails === undefined ? undefined : this.scrubDetails(rawDetails);
  }

  /** Details never contain credentials or oversized values. */
  private scrubDetails(details: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      if (isSecretKeyName(key) || (typeof value === 'string' && isSecretShaped(value))) {
        safe[key] = '[redacted]';
        continue;
      }
      safe[key] = typeof value === 'string' ? scrubTestingSecrets(value).slice(0, 500) : value;
    }
    return safe;
  }

  toJSON(): { readonly code: string; readonly message: string; readonly details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isTestingError(error: unknown): error is TestingError {
  return error instanceof TestingError;
}
