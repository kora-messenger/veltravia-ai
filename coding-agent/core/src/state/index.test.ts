import { describe, expect, it } from 'vitest';

import { CodingError } from '../errors/index.js';
import { canTransition, CODING_RUN_TRANSITIONS, transition } from './index.js';

describe('coding run state machine', () => {
  it('allows the documented forward path', () => {
    let state = transition('idle', 'analyzing');
    state = transition(state, 'planning');
    state = transition(state, 'inspecting');
    state = transition(state, 'editing');
    state = transition(state, 'validating');
    state = transition(state, 'iterating');
    state = transition(state, 'editing');
    state = transition(state, 'validating');
    state = transition(state, 'completed');
    expect(state).toBe('completed');
  });

  it('allows the plan-approval path', () => {
    let state = transition('idle', 'analyzing');
    state = transition(state, 'planning');
    state = transition(state, 'awaiting_approval');
    state = transition(state, 'inspecting');
    expect(state).toBe('inspecting');
  });

  it('rejects jumping from idle straight to execution', () => {
    expect(() => transition('idle', 'editing')).toThrow(CodingError);
    expect(() => transition('idle', 'validating')).toThrow(CodingError);
    expect(() => transition('idle', 'completed')).toThrow(CodingError);
  });

  it('rejects arbitrary invalid transitions', () => {
    expect(() => transition('analyzing', 'editing')).toThrow(CodingError);
    expect(() => transition('awaiting_approval', 'completed')).toThrow(CodingError);
    expect(() => transition('iterating', 'idle')).toThrow(CodingError);
    expect(() => transition('inspecting', 'planning')).not.toThrow(CodingError);
  });

  it('treats terminal states as absorbing', () => {
    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      expect(CODING_RUN_TRANSITIONS[terminal]).toEqual([]);
      for (const target of Object.keys(
        CODING_RUN_TRANSITIONS,
      ) as (keyof typeof CODING_RUN_TRANSITIONS)[]) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('rejects no-op transitions', () => {
    expect(() => transition('editing', 'editing')).toThrow(CodingError);
  });

  it('allows cancellation from every non-terminal state', () => {
    for (const state of Object.keys(
      CODING_RUN_TRANSITIONS,
    ) as (keyof typeof CODING_RUN_TRANSITIONS)[]) {
      if (state === 'completed' || state === 'failed' || state === 'cancelled') continue;
      expect(canTransition(state, 'cancelled')).toBe(true);
    }
  });

  it('reports invalid transitions with typed, code-carrying errors', () => {
    try {
      transition('idle', 'editing');
      expect.unreachable('transition must throw');
    } catch (error) {
      expect((error as CodingError).code).toBe('CODING_INVALID_TRANSITION');
      expect((error as CodingError).message).not.toMatch(/at |\/home|file:\/\//i);
    }
  });
});
