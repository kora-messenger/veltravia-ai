/**
 * The App Generation state machine. Every transition is explicit and
 * validated; invalid transitions throw typed errors. No input can jump
 * straight from an idea to filesystem mutation - approval comes first.
 */

import { GenerationError } from '../errors/index.js';
import type { GenerationState } from '../types/index.js';

export const GENERATION_TRANSITIONS: Readonly<Record<GenerationState, readonly GenerationState[]>> =
  {
    created: ['planning', 'cancelled'],
    planning: ['awaiting_approval', 'failed', 'cancelled'],
    awaiting_approval: [
      'initializing',
      'repairing',
      'validating',
      'testing',
      'failed',
      'cancelled',
    ],
    initializing: ['generating', 'failed', 'cancelled'],
    generating: ['validating', 'repairing', 'awaiting_approval', 'failed', 'cancelled'],
    validating: ['testing', 'repairing', 'awaiting_approval', 'failed', 'cancelled'],
    testing: ['repairing', 'completed', 'awaiting_approval', 'failed', 'cancelled'],
    repairing: ['validating', 'awaiting_approval', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  };

export function canTransition(from: GenerationState, to: GenerationState): boolean {
  return GENERATION_TRANSITIONS[from].includes(to);
}

/** Validates and applies one transition; invalid transitions are typed errors. */
export function transition(from: GenerationState, to: GenerationState): GenerationState {
  if (from === to) {
    throw new GenerationError('GENERATION_INVALID_TRANSITION', 'no-op transition', {
      from,
      to,
    });
  }
  if (!canTransition(from, to)) {
    throw new GenerationError(
      'GENERATION_INVALID_TRANSITION',
      `invalid transition ${from} -> ${to}`,
      { from, to },
    );
  }
  return to;
}
