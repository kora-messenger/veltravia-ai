import { describe, expect, it } from 'vitest';
import { runActivityEntries, toolActivityEntries } from './tool-activity';
import type { AgentRunUiState } from './use-agent-run';
import type { PendingConfirmationView, ToolResultView } from '../../api/agents';

function toolResult(overrides: Partial<ToolResultView> = {}): ToolResultView {
  return {
    invocationId: 'inv-1',
    toolId: 'mock.summarize',
    status: 'success',
    output: { summary: 'offline demo summary' },
    error: null,
    requestedAt: '2026-09-15T07:00:02.000Z',
    completedAt: '2026-09-15T07:00:03.000Z',
    ...overrides,
  };
}

function pending(overrides: Partial<PendingConfirmationView> = {}): PendingConfirmationView {
  return {
    confirmationId: 'conf-1',
    toolId: 'mock.purge',
    invocationId: 'inv-2',
    riskLevel: 'critical',
    state: 'required',
    requestedAt: '2026-09-15T07:00:04.000Z',
    expiresAt: '2026-09-15T07:05:04.000Z',
    ...overrides,
  };
}

function state(overrides: Partial<AgentRunUiState> = {}): AgentRunUiState {
  return {
    phase: 'idle',
    prompt: null,
    runId: null,
    finalOutput: null,
    failureMessage: null,
    cancellable: false,
    retryable: false,
    pollingPaused: false,
    cancelError: null,
    toolResults: [],
    pendingConfirmation: null,
    confirmationSubmitting: false,
    confirmationError: null,
    ...overrides,
  };
}

describe('toolActivityEntries', () => {
  it('maps recorded tool results in the backend order and nothing else', () => {
    const entries = toolActivityEntries(
      [
        toolResult(),
        toolResult({ invocationId: 'inv-2', toolId: 'mock.purge', status: 'denied', output: null }),
      ],
      null,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 'tool:inv-1',
      label: 'Ran mock.summarize',
      status: 'completed',
    });
    expect(entries[1]).toMatchObject({
      id: 'tool:inv-2',
      status: 'denied',
      confirmationRequired: true,
    });
  });

  it('renders untrusted output as plain text and bounds it', () => {
    const big = { blob: 'x'.repeat(4000) };
    const [entry] = toolActivityEntries([toolResult({ output: big })], null);
    expect(entry.detail).toContain('blob');
    expect((entry.detail ?? '').length).toBeLessThanOrEqual(1650);
    expect(entry.detail).toContain('output truncated');
  });

  it('appends the pending confirmation as an awaiting entry with its risk level', () => {
    const [entry] = toolActivityEntries([], pending());
    expect(entry).toMatchObject({
      id: 'confirmation:conf-1',
      status: 'awaiting-confirmation',
      riskLevel: 'critical',
      confirmationRequired: true,
    });
  });

  it('marks an expired confirmation as expired - never decidable again', () => {
    const [entry] = toolActivityEntries([], pending({ state: 'expired' }));
    expect(entry.status).toBe('expired');
    expect(entry.detail).toContain('expired');
  });

  it('invents nothing for an idle run', () => {
    expect(toolActivityEntries([], null)).toEqual([]);
  });
});

describe('runActivityEntries', () => {
  it('maps every run phase to exactly one honest entry', () => {
    const cases: readonly [AgentRunUiState['phase'], string, string][] = [
      ['creating', 'Starting the run', 'queued'],
      ['running', 'Working on your request', 'running'],
      ['paused', 'Waiting for your decision', 'awaiting-confirmation'],
      ['completed', 'Run finished', 'completed'],
      ['failed', 'Run failed', 'failed'],
      ['cancelled', 'Run cancelled', 'cancelled'],
      ['limit-reached', 'Run stopped at a safety limit', 'cancelled'],
    ];
    for (const [phase, label, status] of cases) {
      const [entry] = runActivityEntries(state({ phase }));
      expect(entry.label).toBe(label);
      expect(entry.status).toBe(status);
    }
    expect(runActivityEntries(state())).toEqual([]);
  });
});
