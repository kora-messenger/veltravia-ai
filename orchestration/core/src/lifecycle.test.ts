import { describe, expect, it } from 'vitest';

import { OrchestrationError } from './errors.js';
import {
  TASK_TRANSITIONS,
  assertTransition,
  canTransition,
  isKnownStatus,
  transitionIsGuarded,
} from './lifecycle.js';
import { TASK_STATUSES } from './types.js';

describe('the task lifecycle', () => {
  it('lets a queued task be planned, assigned or run, and nothing else', () => {
    expect(TASK_TRANSITIONS.queued).toEqual(['planning', 'assigned', 'running', 'cancelled']);
    expect(canTransition('queued', 'planning')).toBe(true);
    expect(canTransition('queued', 'completed')).toBe(false);
  });

  it('gives completed and cancelled no way out', () => {
    expect(TASK_TRANSITIONS.completed).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
    for (const status of TASK_STATUSES) {
      expect(canTransition('completed', status)).toBe(false);
      expect(canTransition('cancelled', status)).toBe(false);
    }
  });

  it('lets a running task wait for review rather than complete itself', () => {
    expect(canTransition('running', 'awaiting_review')).toBe(true);
    // Review is a separate, recorded decision.
    expect(transitionIsGuarded('awaiting_review', 'completed')).toBe(true);
    expect(transitionIsGuarded('running', 'completed')).toBe(false);
  });

  it('lets a failed task go back to the queue only through retry', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(transitionIsGuarded('failed', 'queued')).toBe(true);
    expect(canTransition('failed', 'running')).toBe(false);
  });

  it('refuses a transition it does not know, with the states named', () => {
    expect(() => assertTransition('blocked', 'completed')).toThrowError(
      /cannot move from blocked to completed/,
    );
    try {
      assertTransition('blocked', 'completed');
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError);
      expect((error as OrchestrationError).code).toBe('TASK_TRANSITION_INVALID');
    }
  });

  it('rejects a status that is not in the vocabulary', () => {
    expect(isKnownStatus('running')).toBe(true);
    expect(isKnownStatus('done')).toBe(false);
    expect(isKnownStatus(42)).toBe(false);
  });
});
