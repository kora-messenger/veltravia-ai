import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ThemeProvider } from '../../theme/ThemeProvider';
import { ToastProvider } from '../../components/ui';
import { ApiError } from '../../api/client';
import type { ReliabilityHealth, SweepResult } from '../../api/reliability';
import { ReliabilityPanel } from './ReliabilityPanel';

vi.mock('../../api/reliability', () => ({
  getReliabilityHealth: vi.fn(),
  getReliabilityCapabilities: vi.fn(),
  getRecoveryDecisions: vi.fn(),
  listKeyRecords: vi.fn(),
  listSideEffects: vi.fn(),
  runSweep: vi.fn(),
}));

const reliability = await import('../../api/reliability');
const mocked = {
  getReliabilityHealth: vi.mocked(reliability.getReliabilityHealth),
  getReliabilityCapabilities: vi.mocked(reliability.getReliabilityCapabilities),
  getRecoveryDecisions: vi.mocked(reliability.getRecoveryDecisions),
  listKeyRecords: vi.mocked(reliability.listKeyRecords),
  listSideEffects: vi.mocked(reliability.listSideEffects),
  runSweep: vi.mocked(reliability.runSweep),
};

const HEALTH: ReliabilityHealth = {
  generatedAt: '2026-11-08T14:00:00.000Z',
  durable: false,
  queue: {
    openExecutions: 2,
    openExecutionLimit: 8,
    tasksQueued: 3,
    workersQueued: 1,
    workersRunning: 1,
    awaitingReview: 2,
    blockedWorkers: 1,
  },
  leases: { active: 1, expired: 0, holders: ['api-1'] },
  abandoned: [],
  retries: { workersWithAttempts: 0, totalAttempts: 0, awaitingRetry: 0 },
  recovery: { open: 1, escalated: 0, last24h: 1 },
  verification: { failedRuns: 0, incompleteRuns: 0 },
  integration: { failed: 0, pending: 0 },
  idempotency: { inFlight: 1, failed: 0, completedLast24h: 4 },
  events: { pending: 1, failed: 0 },
  findings: [
    {
      code: 'coordination_not_durable',
      level: 'attention',
      summary: 'Coordination state lives in this process, not in the database.',
      evidence: ['Idempotency records are held in memory', 'Leases are held in memory'],
    },
  ],
  unavailable: [],
};

const SWEEP: SweepResult = {
  examined: 2,
  skipped: 0,
  recoveredWorkers: 1,
  decisions: [
    {
      executionId: 'exe_1',
      action: 'await_owner',
      reason: 'Work is waiting for your review, not for the machinery.',
      evidence: ['execution status is awaiting_review', 'review has not been recorded'],
      ownerAction: 'Open the execution and accept or reject the finished work.',
    },
  ],
};

function renderPanel() {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <ReliabilityPanel />
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getReliabilityHealth.mockResolvedValue(HEALTH);
  mocked.getReliabilityCapabilities.mockResolvedValue({
    durable: false,
    holder: 'api-1',
    idempotency: { header: 'Idempotency-Key', retentionHours: 24 },
    leases: { ttlSeconds: 90 },
    backpressure: { maxOpenExecutionsPerOwner: 8 },
    excluded: ['durable coordination across restarts'],
  });
  mocked.getRecoveryDecisions.mockResolvedValue([]);
  mocked.listKeyRecords.mockResolvedValue([]);
  mocked.listSideEffects.mockResolvedValue([]);
  mocked.runSweep.mockResolvedValue(SWEEP);
});

afterEach(() => {
  cleanup();
});

describe('ReliabilityPanel', () => {
  it('reports the stored counts and says the coordination is not durable', async () => {
    renderPanel();

    expect(await screen.findByText('Coordination store')).toBeTruthy();
    // Counts are read off the tile they belong to: several tiles can show 2.
    const openTile = screen.getByText('Open executions').closest('.v-ops__tile');
    expect(openTile?.querySelector('.v-ops__tile-value')?.textContent).toBe('2');
    expect(screen.getByText('Memory')).toBeTruthy();
    // The finding is shown with the evidence it rests on, not as a bare warning.
    expect(
      screen.getByText('Coordination state lives in this process, not in the database.'),
    ).toBeTruthy();
    expect(screen.getByText('Leases are held in memory')).toBeTruthy();
  });

  it('says plainly when the snapshot could not be read', async () => {
    mocked.getReliabilityHealth.mockRejectedValue(
      new ApiError(503, 'RELIABILITY_UNAVAILABLE', 'The reliability records are unavailable.'),
    );

    renderPanel();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('The reliability records are unavailable.')).toBeTruthy();
  });

  it('shows what a sweep decided, with the evidence and what you must do', async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /sweep interrupted work/i }));

    await waitFor(() => {
      expect(mocked.runSweep).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('Last sweep')).toBeTruthy();
    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(
      screen.getByText('Work is waiting for your review, not for the machinery.'),
    ).toBeTruthy();
    expect(
      screen.getByText(/You: Open the execution and accept or reject the finished work\./),
    ).toBeTruthy();
  });

  it('does not report an empty sweep as work recovered', async () => {
    mocked.runSweep.mockResolvedValue({
      examined: 0,
      skipped: 0,
      recoveredWorkers: 0,
      decisions: [],
    });

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /sweep interrupted work/i }));

    expect(await screen.findByText('Nothing needed attention')).toBeTruthy();
    expect(screen.queryByText('Recovering')).toBeNull();
  });

  it('lists an open keyed request so a stuck retry is visible', async () => {
    mocked.listKeyRecords.mockResolvedValue([
      {
        scope: 'executions:intake',
        keyHint: 'sweep_…a41',
        status: 'in_progress',
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        fingerprint: 'sha256:abcdef',
        failure: null,
      },
    ]);

    renderPanel();

    expect(await screen.findByText('executions:intake')).toBeTruthy();
    expect(screen.getByText('sweep_…a41')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
  });
});
