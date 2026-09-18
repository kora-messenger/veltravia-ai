import { describe, expect, it } from 'vitest';

import { TestingError } from '../errors/index.js';
import { listTestRunStates, transition } from './index.js';

describe('TestRun state machine', () => {
  it('exposes every declared state in order', () => {
    const states = listTestRunStates();
    expect(states).toEqual([
      'created',
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
    ]);
  });

  it('allows the full happy path', () => {
    let state = 'created' as ReturnType<typeof listTestRunStates>[number];
    state = transition(state, 'planning');
    state = transition(state, 'awaiting_approval');
    state = transition(state, 'approved');
    state = transition(state, 'running');
    state = transition(state, 'completed');
    expect(state).toBe('completed');
  });

  it('allows the repair loop path', () => {
    let state = 'running' as ReturnType<typeof listTestRunStates>[number];
    state = transition(state, 'analyzing');
    state = transition(state, 'awaiting_repair_approval');
    state = transition(state, 'repairing');
    state = transition(state, 'retesting');
    state = transition(state, 'analyzing');
    state = transition(state, 'failed');
    expect(state).toBe('failed');
  });

  it('pauses and resumes a forced tool confirmation from any drive phase', () => {
    for (const phase of ['running', 'repairing', 'retesting'] as const) {
      let state = phase as ReturnType<typeof listTestRunStates>[number];
      state = transition(state, 'awaiting_approval');
      state = transition(state, phase);
      expect(state).toBe(phase);
    }
  });

  it('rejects no-op transitions with a typed error', () => {
    expect(() => transition('running', 'running')).toThrowError(TestingError);
  });

  it('rejects undefined transitions with a typed error', () => {
    expect(() => transition('completed', 'running')).toThrowError(/invalid transition/);
    expect(() => transition('failed', 'planning')).toThrowError(/invalid transition/);
    expect(() => transition('cancelled', 'awaiting_approval')).toThrowError(/invalid transition/);
    expect(() => transition('approved', 'planning')).toThrowError(/invalid transition/);
  });

  it('can be cancelled from every non-terminal state', () => {
    const nonTerminal = [
      'created',
      'planning',
      'awaiting_approval',
      'approved',
      'running',
      'analyzing',
      'awaiting_repair_approval',
      'repairing',
      'retesting',
    ] as const;
    for (const state of nonTerminal) {
      expect(transition(state, 'cancelled')).toBe('cancelled');
    }
  });

  it('terminal states are terminal forever', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      for (const target of listTestRunStates()) {
        if (target === state) continue;
        expect(() => transition(state, target)).toThrowError(TestingError);
      }
    }
  });
});
