/**
 * The Coding Agent state machine. Every transition is explicit and validated;
 * invalid transitions throw. No input can jump straight to execution.
 */

import type { CodingRunState } from '../types/index.js';
import { CodingError } from '../errors/index.js';

export const CODING_RUN_TRANSITIONS: Readonly<Record<CodingRunState, readonly CodingRunState[]>> = {
  idle: ['analyzing', 'cancelled'],
  analyzing: ['planning', 'failed', 'cancelled'],
  planning: ['awaiting_approval', 'inspecting', 'failed', 'cancelled'],
  awaiting_approval: ['inspecting', 'editing', 'validating', 'planning', 'failed', 'cancelled'],
  inspecting: [
    'inspecting',
    'planning',
    'editing',
    'validating',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled',
  ],
  editing: [
    'editing',
    'inspecting',
    'validating',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled',
  ],
  validating: [
    'iterating',
    'editing',
    'inspecting',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled',
  ],
  iterating: [
    'editing',
    'inspecting',
    'validating',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled',
  ],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: CodingRunState, to: CodingRunState): boolean {
  return CODING_RUN_TRANSITIONS[from].includes(to);
}

/** Validates and applies one transition; invalid transitions are typed errors. */
export function transition(from: CodingRunState, to: CodingRunState): CodingRunState {
  if (from === to) {
    throw new CodingError('CODING_INVALID_TRANSITION', 'no-op transition', {
      details: { from, to },
    });
  }
  if (!canTransition(from, to)) {
    throw new CodingError('CODING_INVALID_TRANSITION', `invalid transition ${from} -> ${to}`, {
      details: { from, to },
    });
  }
  return to;
}
