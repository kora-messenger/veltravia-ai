/**
 * The TestRun state machine: every transition is explicit, validated, and
 * auditable. Terminal states are terminal forever; a cancelled run never
 * resumes. Invalid transitions throw typed errors instead of being coerced.
 */

import { TestingError } from '../errors/index.js';
import { TEST_RUN_STATES, isTestRunTerminal, type TestRunState } from '../types/index.js';

/** Events that drive the machine (one per meaningful phase change). */
export const TEST_TRANSITION_EVENTS = [
  'planning',
  'awaiting_approval',
  'approved',
  'running',
  'analyzing',
  'awaiting_repair_approval',
  'repairing',
  'retesting',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TestTransitionEvent = (typeof TEST_TRANSITION_EVENTS)[number];

/** The explicit transition table. Keys absent = no transition defined. */
export const TEST_TRANSITIONS: Readonly<Record<TestRunState, readonly TestRunState[]>> = {
  created: ['planning', 'cancelled'],
  planning: ['awaiting_approval', 'failed', 'cancelled'],
  // Resume targets depend on the phase that paused (tracked as resumeState):
  // a forced sandbox.execute confirmation returns to running/retesting/repairing.
  awaiting_approval: ['approved', 'running', 'repairing', 'retesting', 'failed', 'cancelled'],
  approved: ['running', 'failed', 'cancelled'],
  running: [
    'awaiting_approval', // a forced sandbox.execute confirmation pauses the run
    'analyzing',
    'completed',
    'failed',
    'cancelled',
  ],
  analyzing: [
    'awaiting_repair_approval',
    'retesting', // diagnosis decided no repair is needed (retest only)
    'failed',
    'cancelled',
  ],
  awaiting_repair_approval: ['repairing', 'failed', 'cancelled'],
  repairing: [
    'awaiting_approval', // the coding agent paused for a tool confirmation
    'retesting',
    'failed',
    'cancelled',
  ],
  retesting: [
    'awaiting_approval', // another forced sandbox.execute confirmation
    'analyzing', // retest failed again - bounded loop continues
    'completed',
    'failed',
    'cancelled',
  ],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Applies one event; throws a typed error on an undefined transition. */
export function transition(from: TestRunState, to: TestRunState): TestRunState {
  if (from === to) {
    throw new TestingError('TESTING_INVALID_TRANSITION', `no-op transition ${from} -> ${to}`);
  }
  const allowed = TEST_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new TestingError('TESTING_INVALID_TRANSITION', `invalid transition ${from} -> ${to}`);
  }
  return to;
}

/** All states in declared order. */
export function listTestRunStates(): readonly TestRunState[] {
  return TEST_RUN_STATES;
}

export { isTestRunTerminal };
