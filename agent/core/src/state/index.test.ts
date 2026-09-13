import { describe, expect, it } from 'vitest';
import {
  canTransitionAgentStatus,
  createAgentState,
  isAgentStatus,
  isTerminalAgentStatus,
} from './index.js';

describe('agent statuses', () => {
  it('recognizes every status', () => {
    for (const status of [
      'idle',
      'planning',
      'waiting_for_tool',
      'waiting_for_confirmation',
      'executing',
      'completed',
      'failed',
      'cancelled',
      'limit_reached',
    ]) {
      expect(isAgentStatus(status)).toBe(true);
    }
    expect(isAgentStatus('dreaming')).toBe(false);
  });

  it('marks exactly the four terminal statuses', () => {
    expect(isTerminalAgentStatus('completed')).toBe(true);
    expect(isTerminalAgentStatus('failed')).toBe(true);
    expect(isTerminalAgentStatus('cancelled')).toBe(true);
    expect(isTerminalAgentStatus('limit_reached')).toBe(true);
    expect(isTerminalAgentStatus('idle')).toBe(false);
    expect(isTerminalAgentStatus('planning')).toBe(false);
  });
});

describe('the controlled transition table', () => {
  it('allows the valid lifecycle transitions', () => {
    expect(canTransitionAgentStatus('idle', 'planning')).toBe(true);
    expect(canTransitionAgentStatus('planning', 'waiting_for_tool')).toBe(true);
    expect(canTransitionAgentStatus('planning', 'executing')).toBe(true);
    expect(canTransitionAgentStatus('waiting_for_tool', 'executing')).toBe(true);
    expect(canTransitionAgentStatus('executing', 'planning')).toBe(true);
    expect(canTransitionAgentStatus('executing', 'waiting_for_confirmation')).toBe(true);
    expect(canTransitionAgentStatus('waiting_for_confirmation', 'executing')).toBe(true);
    expect(canTransitionAgentStatus('waiting_for_confirmation', 'planning')).toBe(true);
    expect(canTransitionAgentStatus('planning', 'completed')).toBe(true);
    expect(canTransitionAgentStatus('planning', 'failed')).toBe(true);
    expect(canTransitionAgentStatus('planning', 'cancelled')).toBe(true);
    expect(canTransitionAgentStatus('planning', 'planning')).toBe(true); // iterations
  });

  it('rejects invalid transitions', () => {
    expect(canTransitionAgentStatus('idle', 'executing')).toBe(false);
    expect(canTransitionAgentStatus('idle', 'completed')).toBe(false);
    expect(canTransitionAgentStatus('waiting_for_tool', 'planning')).toBe(false);
    expect(canTransitionAgentStatus('executing', 'waiting_for_tool')).toBe(false);
    expect(canTransitionAgentStatus('executing', 'completed')).toBe(false);
  });

  it('terminal statuses never transition - completed→executing and failed→executing are impossible', () => {
    expect(canTransitionAgentStatus('completed', 'executing')).toBe(false);
    expect(canTransitionAgentStatus('failed', 'executing')).toBe(false);
    expect(canTransitionAgentStatus('cancelled', 'planning')).toBe(false);
    expect(canTransitionAgentStatus('limit_reached', 'planning')).toBe(false);
    for (const terminal of ['completed', 'failed', 'cancelled', 'limit_reached'] as const) {
      for (const target of [
        'idle',
        'planning',
        'executing',
        'completed',
        'failed',
        'cancelled',
        'limit_reached',
      ] as const) {
        expect(canTransitionAgentStatus(terminal, target)).toBe(false);
      }
    }
  });
});

describe('createAgentState', () => {
  it('starts idle with empty history and zero counters', () => {
    const state = createAgentState({
      agentId: 'agent.mock',
      runId: 'run-1',
      task: 'Explain Veltravia AI.',
      createdAt: '2026-09-13T16:00:00.000Z',
    });
    expect(state.status).toBe('idle');
    expect(state.iteration).toBe(0);
    expect(state.toolCallCount).toBe(0);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.toolInvocations).toEqual([]);
    expect(state.pendingConfirmation).toBeUndefined();
    expect(state.finalResult).toBeUndefined();
    expect(state.error).toBeUndefined();
  });
});
