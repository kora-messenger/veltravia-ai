import { describe, expect, it } from 'vitest';

import { GenerationError } from '../errors/index.js';
import { GENERATION_TRANSITIONS, transition } from './index.js';

describe('generation state machine', () => {
  it('allows the documented happy path', () => {
    let state = transition('created', 'planning');
    state = transition(state, 'awaiting_approval');
    state = transition(state, 'initializing');
    state = transition(state, 'generating');
    state = transition(state, 'validating');
    state = transition(state, 'testing');
    state = transition(state, 'completed');
    expect(state).toBe('completed');
  });

  it('allows repair loops back into validating', () => {
    let state = transition('validating', 'repairing');
    state = transition(state, 'validating');
    expect(state).toBe('validating');
  });

  it('rejects invalid transitions with typed errors', () => {
    let caught: unknown;
    try {
      transition('created', 'generating');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GenerationError);
    expect((caught as GenerationError).code).toBe('GENERATION_INVALID_TRANSITION');
  });

  it('rejects no-op transitions', () => {
    expect(() => transition('planning', 'planning')).toThrow(GenerationError);
  });

  it('keeps terminal states terminal', () => {
    for (const terminal of ['completed', 'failed', 'cancelled']) {
      expect(GENERATION_TRANSITIONS[terminal as keyof typeof GENERATION_TRANSITIONS]).toEqual([]);
    }
  });

  it('allows cancellation from every non-terminal state', () => {
    for (const state of Object.keys(GENERATION_TRANSITIONS)) {
      const allowed = GENERATION_TRANSITIONS[state as keyof typeof GENERATION_TRANSITIONS];
      const isTerminalState = allowed.length === 0;
      if (!isTerminalState) {
        expect(allowed).toContain('cancelled');
      }
    }
  });
});
