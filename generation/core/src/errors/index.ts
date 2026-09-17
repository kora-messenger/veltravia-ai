/**
 * Generation Engine errors: typed, scrubbed, and safe to serialize to the
 * API (never carry values - especially secret-shaped input - only names).
 */

import { isProjectError } from '@veltravia/project-core';

export const GENERATION_ERROR_CODES = [
  'GENERATION_INVALID_REQUEST',
  'GENERATION_SECRET_REJECTED',
  'GENERATION_INVALID_SPEC',
  'GENERATION_UNSUPPORTED_APP_TYPE',
  'GENERATION_UNSUPPORTED_TEMPLATE',
  'GENERATION_INVALID_PLAN',
  'GENERATION_PLAN_REJECTED',
  'GENERATION_APPROVAL_REQUIRED',
  'GENERATION_NOT_AWAITING_APPROVAL',
  'GENERATION_RUN_NOT_FOUND',
  'GENERATION_RUN_TERMINAL',
  'GENERATION_INVALID_TRANSITION',
  'GENERATION_FILE_LIMIT',
  'GENERATION_COMMAND_LIMIT',
  'GENERATION_REPAIR_LIMIT',
  'GENERATION_DURATION_LIMIT',
  'GENERATION_VALIDATION_FAILED',
  'GENERATION_TEST_FAILED',
  'GENERATION_PROJECT_CONFLICT',
  'GENERATION_CANCELLED',
  'GENERATION_PLANNER_ERROR',
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: GenerationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: GenerationErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: scrubGenerationSecrets(this.message),
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }
}

export function isGenerationError(error: unknown): error is GenerationError {
  return error instanceof GenerationError;
}

const SECRET_PATTERN =
  /(sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

/** Scrubs secret-shaped fragments from text destined for views/errors. */
export function scrubGenerationSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[redacted]');
}

/** Wraps unknown errors; project-engine causes are preserved as details. */
export function toGenerationError(
  error: unknown,
  fallbackMessage = 'generation failure',
): GenerationError {
  if (isGenerationError(error)) return error;
  const details: Record<string, unknown> = {};
  if (isProjectError(error)) {
    details.cause = error.code;
  }
  return new GenerationError(
    'GENERATION_PLANNER_ERROR',
    scrubGenerationSecrets(error instanceof Error ? error.message : fallbackMessage),
    details,
  );
}
