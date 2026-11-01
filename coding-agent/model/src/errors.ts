/** Typed, scrubbed errors for the model-powered coding agent. */

import { CodingError, type CodingErrorCode } from '@veltravia/coding-agent-core';

export type ModelCodingErrorCode =
  | 'CODING_MODEL_UNAVAILABLE'
  | 'CODING_MODEL_INVALID_OUTPUT'
  | 'CODING_MODEL_REFUSED'
  | 'CODING_MODEL_CANCELLED'
  | 'CODING_MODEL_PROVIDER_ERROR';

/**
 * Extends the agent's own `CodingError` on purpose: the run manager reports a
 * typed code only for errors it recognises, and anything else becomes a generic
 * `CODING_INVALID_DECISION`. A model failure must reach the caller as itself.
 */
export class ModelCodingError extends CodingError {
  declare readonly code: ModelCodingErrorCode;

  constructor(code: ModelCodingErrorCode, message: string) {
    super(code as CodingErrorCode, message);
    this.name = 'ModelCodingError';
  }
}

/** Removes credential-shaped fragments from anything a provider returned. */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi,
];

export function scrubModelText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}
