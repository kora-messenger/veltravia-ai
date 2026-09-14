/**
 * Decision validation. Raw decision-source output is never executed: it is
 * parsed into a validated structure first. Unknown decision types, unknown
 * action types, and secret-shaped content are rejected.
 */

import { CodingError } from '../errors/index.js';
import { validateCodingPlan } from '../policy/index.js';
import type { CodingDecision } from '../types/index.js';

const MAX_SUMMARY = 2000;

/** Validates one decision from the source before anything acts on it. */
export function validateCodingDecision(decision: unknown): CodingDecision {
  if (
    decision === null ||
    typeof decision !== 'object' ||
    typeof (decision as { type?: unknown }).type !== 'string'
  ) {
    throw new CodingError('CODING_INVALID_DECISION', 'decision must be an object with a type');
  }
  const candidate = decision as {
    type: string;
    plan?: unknown;
    action?: unknown;
    summary?: unknown;
    reason?: unknown;
  };
  switch (candidate.type) {
    case 'plan':
      return { type: 'plan', plan: validateCodingPlan(candidate.plan as never) };
    case 'action': {
      if (candidate.action === null || typeof candidate.action !== 'object') {
        throw new CodingError(
          'CODING_INVALID_DECISION',
          'action decision requires an action object',
        );
      }
      return { type: 'action', action: candidate.action as never };
    }
    case 'complete': {
      if (typeof candidate.summary !== 'string' || candidate.summary.length < 1) {
        throw new CodingError('CODING_INVALID_DECISION', 'complete decision requires a summary');
      }
      if (candidate.summary.length > MAX_SUMMARY) {
        throw new CodingError('CODING_INVALID_DECISION', 'complete summary is too long');
      }
      return { type: 'complete', summary: candidate.summary };
    }
    case 'fail': {
      if (typeof candidate.reason !== 'string' || candidate.reason.length < 1) {
        throw new CodingError('CODING_INVALID_DECISION', 'fail decision requires a reason');
      }
      return { type: 'fail', reason: candidate.reason.slice(0, MAX_SUMMARY) };
    }
    default:
      throw new CodingError(
        'CODING_INVALID_DECISION',
        `unknown decision type "${candidate.type}"`,
        {
          details: { type: candidate.type },
        },
      );
  }
}
