/**
 * Typed Project Memory errors. Every message is scrubbed of secret-shaped
 * values before construction completes; nothing here ever carries
 * credentials, tokens, or raw memory content dumps.
 */

import { scrubSecretShapedValues } from './scrub.js';

export const MEMORY_ERROR_CODES = [
  'MEMORY_INVALID_REQUEST',
  'MEMORY_SECRET_REJECTED',
  'MEMORY_NOT_FOUND',
  'MEMORY_LIMIT_REACHED',
  'MEMORY_REVISION_CONFLICT',
  'MEMORY_INVALID_TRANSITION',
  'MEMORY_SEARCH_TOO_LARGE',
  'MEMORY_INVALID_CANDIDATE',
  'MEMORY_STORAGE_ERROR',
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

/** Secret-shaped value patterns (GitHub, OpenAI-style, JWT, AWS-style, PEM). */
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /ghu_[A-Za-z0-9]{20,}/,
  /ghs_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{12,}/,
  /AIzaSy[A-Za-z0-9_-]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const;

/** True when a string looks like a secret-shaped credential value. */
export function isSecretShaped(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Scrubs secret-shaped values from free text (bounded to sane size first). */
export function scrubMemorySecrets(input: string): string {
  const bounded = input.slice(0, 4096);
  return scrubSecretShapedValues(bounded);
}

export interface MemoryErrorOptions {
  readonly code: MemoryErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class MemoryError extends Error {
  public readonly code: MemoryErrorCode;
  public readonly status: number;
  public readonly details: Readonly<Record<string, unknown>>;

  constructor(options: MemoryErrorOptions) {
    super(scrubMemorySecrets(options.message));
    this.name = 'MemoryError';
    this.code = options.code;
    this.status = options.status ?? 400;
    // Details are metadata only (field names, counts, revisions) - scrubbed.
    this.details = scrubDetails(options.details);
  }
}

function scrubDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (details === undefined) return {};
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      scrubbed[key] = scrubMemorySecrets(value);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

export function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError;
}

/** 400 - invalid input shape, unknown enum value, oversized field. */
export class InvalidMemoryRequestError extends MemoryError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'MEMORY_INVALID_REQUEST', message, status: 400, details });
  }
}

/** 400 - secret-shaped content or provenance rejected (field named, never the value). */
export class MemorySecretRejectedError extends MemoryError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'MEMORY_SECRET_REJECTED', message, status: 400, details });
  }
}

/**
 * 404 - the memory does not exist IN THE REQUESTED PROJECT SCOPE. Cross-project
 * ids intentionally surface as not-found: existence in another project is
 * never leaked.
 */
export class MemoryNotFoundError extends MemoryError {
  constructor(memoryId: string, projectId: string) {
    super({
      code: 'MEMORY_NOT_FOUND',
      message: `No memory found with id "${memoryId}" in project "${projectId}".`,
      status: 404,
      details: { memoryId, projectId },
    });
  }
}

/** 409 - the per-project memory ceiling was reached; nothing was stored. */
export class MemoryLimitReachedError extends MemoryError {
  constructor(max: number, projectId: string) {
    super({
      code: 'MEMORY_LIMIT_REACHED',
      message: `This project already holds the maximum of ${max} memories. Archive or delete memories before adding more.`,
      status: 409,
      details: { max, projectId },
    });
  }
}

/** 409 - the update was based on an outdated revision; nothing was overwritten. */
export class MemoryRevisionConflictError extends MemoryError {
  constructor(memoryId: string, currentRevision: number) {
    super({
      code: 'MEMORY_REVISION_CONFLICT',
      message: `Memory "${memoryId}" changed since it was read (current revision ${currentRevision}). Reload and retry.`,
      status: 409,
      details: { memoryId, currentRevision },
    });
  }
}

/** 409 - the lifecycle transition is not allowed from the current status. */
export class InvalidMemoryTransitionError extends MemoryError {
  constructor(message: string) {
    super({ code: 'MEMORY_INVALID_TRANSITION', message, status: 409 });
  }
}

/** 400 - the search text exceeded the bound. */
export class MemorySearchTooLargeError extends MemoryError {
  constructor(max: number) {
    super({
      code: 'MEMORY_SEARCH_TOO_LARGE',
      message: `Search text exceeds the maximum of ${max} characters.`,
      status: 400,
      details: { max },
    });
  }
}

/** 400 - a workflow produced an invalid memory candidate (never stored). */
export class InvalidMemoryCandidateError extends MemoryError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'MEMORY_INVALID_CANDIDATE', message, status: 400, details });
  }
}

/** 500 - the repository failed (typed, scrubbed, never raw driver output). */
export class MemoryStorageError extends MemoryError {
  constructor(message: string) {
    super({ code: 'MEMORY_STORAGE_ERROR', message, status: 500 });
  }
}
