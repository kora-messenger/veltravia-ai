/** Typed intelligence errors. Messages never carry retrieved content or
 *  secret-shaped values: they are safe to show and to log. */

export const INTELLIGENCE_ERROR_CODES = [
  'INTELLIGENCE_INVALID_REQUEST',
  'INTELLIGENCE_SOURCE_NOT_FOUND',
  'INTELLIGENCE_SOURCE_FORBIDDEN',
  'INTELLIGENCE_LIMIT_EXCEEDED',
  'INTELLIGENCE_TIMEOUT',
  'INTELLIGENCE_CANCELLED',
  'INTELLIGENCE_SECRET_REJECTED',
  'INTELLIGENCE_PROVIDER_UNAVAILABLE',
  'INTELLIGENCE_PROVIDER_ERROR',
  'INTELLIGENCE_JOB_NOT_FOUND',
  'INTELLIGENCE_JOB_STATE',
] as const;

export type IntelligenceErrorCode = (typeof INTELLIGENCE_ERROR_CODES)[number];

export class IntelligenceError extends Error {
  readonly code: IntelligenceErrorCode;

  constructor(code: IntelligenceErrorCode, message: string) {
    super(message);
    this.name = 'IntelligenceError';
    this.code = code;
  }
}

export function isIntelligenceError(value: unknown): value is IntelligenceError {
  return value instanceof IntelligenceError;
}

export function invalidRequest(message: string): IntelligenceError {
  return new IntelligenceError('INTELLIGENCE_INVALID_REQUEST', message);
}
