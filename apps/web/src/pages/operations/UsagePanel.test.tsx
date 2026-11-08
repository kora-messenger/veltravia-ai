// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UsagePanel } from './UsagePanel';
import type { UsageLimitView, UsageRecordView, UsageSnapshot } from '../../api/usage';

/**
 * The usage panel (Step 52).
 *
 * The assertions worth having are about honesty, not layout: a limit nothing
 * measures must not be drawn as a bar, provider spend must never be folded into
 * this platform's spend, and an empty month must say it is empty.
 */

const api = vi.hoisted(() => ({
  getUsageSnapshot: vi.fn(),
  getUsageCapabilities: vi.fn(),
  listUsageRecords: vi.fn(),
}));

vi.mock('../../api/usage', () => api);

vi.mock('../../components/ui', async () => {
  const actual = await vi.importActual<typeof import('../../components/ui')>('../../components/ui');
  return { ...actual };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const limit = (
  over: Partial<UsageLimitView> & Pick<UsageLimitView, 'key' | 'label'>,
): UsageLimitView => ({
  category: null,
  unit: 'calls',
  value: 100,
  used: 10,
  remaining: 90,
  scope: 'plan',
  enforcement: 'hard',
  note: null,
  ...over,
});

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    durable: true,
    developmentMode: false,
    entitlement: {
      planId: 'development',
      label: 'Included allowance',
      source: 'default',
      developmentMode: false,
      managedProviders: false,
      byokProviders: true,
      note: 'Included allowance: your own provider keys are used.',
    },
    period: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' },
    projectId: null,
    counters: {
      database_storage: 0,
      backend_execution: 125_000,
      file_storage: 0,
      bandwidth: 0,
      hosting: 0,
      background_jobs: 3,
      realtime: 0,
      ai_provider: 0,
    },
    gauges: { fileBytes: 2_048, openJobs: 1 },
    cost: {
      infrastructureUsd: 0.42,
      managedProviderUsd: 0,
      byokProviderUsd: 1.75,
      unpricedCalls: 0,
    },
    limits: [
      limit({ key: 'backgroundJobs', label: 'Background jobs this month', value: 100, used: 3 }),
      limit({
        key: 'fileStorageBytes',
        label: 'File storage',
        unit: 'bytes',
        value: 1_073_741_824,
        used: 2_048,
      }),
      limit({
        key: 'databaseStorageBytes',
        label: 'Database storage',
        unit: 'bytes',
        value: 1_073_741_824,
        used: null,
        remaining: null,
        enforcement: 'not_enforced',
        note: 'Nothing in this deployment observes this yet, so its limit is reported but not enforced.',
      }),
    ],
    records: 3,
    ...over,
  };
}

const records: readonly UsageRecordView[] = [];

const capabilities = {
  durable: true,
  developmentMode: false,
  enforcement: 'partial' as const,
  notes: ['Counters accumulate over the calendar month.'],
  categories: [
    {
      category: 'database_storage' as const,
      status: 'unavailable',
      note: 'not probed',
      limit: 'databaseStorageBytes' as const,
    },
    {
      category: 'background_jobs' as const,
      status: 'measured',
      note: 'counted',
      limit: 'backgroundJobs' as const,
    },
  ],
};

describe('UsagePanel', () => {
  it('draws a bar only where something measured the number', async () => {
    api.getUsageSnapshot.mockResolvedValue(snapshot());
    api.getUsageCapabilities.mockResolvedValue(capabilities);
    api.listUsageRecords.mockResolvedValue(records);

    render(<UsagePanel />);
    await waitFor(() => expect(screen.getByText('Usage and quotas')).toBeTruthy());

    // Two measured limits, one unmeasured: exactly two progress bars.
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);

    // The unmeasured one says so rather than showing an empty bar.
    expect(screen.getByText('Database storage')).toBeTruthy();
    expect(screen.getByText('Not measured')).toBeTruthy();
    expect(screen.getByText(/nothing measures this yet/)).toBeTruthy();
  });

  it('keeps this platform’s spend apart from the owner’s provider spend', async () => {
    api.getUsageSnapshot.mockResolvedValue(snapshot());
    api.getUsageCapabilities.mockResolvedValue(capabilities);
    api.listUsageRecords.mockResolvedValue(records);

    render(<UsagePanel />);
    await waitFor(() => expect(screen.getByText('Usage and quotas')).toBeTruthy());

    expect(screen.getByText('This platform')).toBeTruthy();
    expect(screen.getByText('$0.42')).toBeTruthy();
    expect(screen.getByText('Your provider account')).toBeTruthy();
    expect(screen.getByText('$1.75')).toBeTruthy();
    // Never summed into one reassuring total.
    expect(screen.queryByText('$2.17')).toBeNull();
  });

  it('says an empty month is empty instead of rendering a blank table', async () => {
    api.getUsageSnapshot.mockResolvedValue(snapshot({ records: 0 }));
    api.getUsageCapabilities.mockResolvedValue(capabilities);
    api.listUsageRecords.mockResolvedValue([]);

    render(<UsagePanel />);
    await waitFor(() =>
      expect(screen.getByText(/Nothing has been recorded this month/)).toBeTruthy(),
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('warns that memory mode does not survive a restart', async () => {
    api.getUsageSnapshot.mockResolvedValue(
      snapshot({
        durable: false,
        developmentMode: true,
        entitlement: {
          planId: 'development',
          label: 'Development',
          source: 'default',
          developmentMode: true,
          managedProviders: true,
          byokProviders: true,
          note: 'Development mode.',
        },
      }),
    );
    api.getUsageCapabilities.mockResolvedValue({ ...capabilities, durable: false });
    api.listUsageRecords.mockResolvedValue(records);

    render(<UsagePanel />);
    await waitFor(() => expect(screen.getByText(/keeps usage in memory/)).toBeTruthy());
    expect(screen.getByText(/Counts reset when the server restarts/)).toBeTruthy();
  });

  it('reports a failed read with a retry instead of an old number', async () => {
    api.getUsageSnapshot.mockRejectedValue(new Error('network down'));
    api.getUsageCapabilities.mockResolvedValue(capabilities);
    api.listUsageRecords.mockResolvedValue(records);

    render(<UsagePanel />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain('could not be refreshed');
    expect(within(alert).getByText('Try again')).toBeTruthy();
  });
});
