// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TestingApi from '../../api/app-testing';
import type { AppTestReport, RunStatus, StartedRun, TestRunState } from '../../api/app-testing';
import { useTestingRun } from './useTestingRun';

type Api = typeof TestingApi;

function status(state: TestRunState, pending: RunStatus['pendingApproval'] = null): RunStatus {
  return {
    runId: 'run-1',
    state,
    projectId: 'prj-1',
    workspaceId: 'ws-1',
    pendingApproval: pending,
    repairAttempts: 0,
    commandsExecuted: 0,
    failure: null,
    notes: [],
  };
}

const STARTED: StartedRun = {
  runId: 'run-1',
  state: 'awaiting_approval',
  projectId: 'prj-1',
  workspaceId: 'ws-1',
  inspection: {
    fileCount: 2,
    truncated: false,
    frontend: 'react',
    backend: 'fastify',
    testRunner: 'vitest',
    databases: [],
    entryPoints: [],
    apiRoutes: [],
    pageRoutes: [],
    existingTests: [],
    dependencies: [],
    hasAuth: false,
    hasForms: false,
    notes: [],
  },
  proposedTests: [],
  skippedKinds: [],
  notes: [],
};

function report(overrides: Partial<AppTestReport> = {}): AppTestReport {
  return {
    projectId: 'prj-1',
    runId: 'run-1',
    environment: {
      runtimeId: 'mock',
      osIsolation: false,
      executedRealCode: false,
      networkPolicy: 'disabled',
    },
    status: 'BLOCKED',
    statusReason: 'waiting',
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    tests: [],
    bugs: [],
    findings: [],
    regression: { ran: false, total: 0, passed: 0, failed: 0, regressed: [], fixed: [], note: '' },
    fullyTested: false,
    generatedAt: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  return {
    startRun: vi.fn().mockResolvedValue(STARTED),
    fetchStatus: vi.fn().mockResolvedValue(status('awaiting_approval', { kind: 'plan_approval' })),
    fetchReport: vi.fn().mockResolvedValue(report()),
    fetchRepairPlan: vi.fn().mockResolvedValue({
      runId: 'run-1',
      state: 'completed',
      awaitingApproval: false,
      diagnosis: null,
      repairPlan: null,
      approvalRoute: '/api/testing/runs/run-1/approval',
    }),
    cancelRun: vi.fn().mockResolvedValue({ runId: 'run-1', state: 'cancelled' }),
    decide: vi.fn().mockResolvedValue(status('running')),
    ...overrides,
  } as unknown as Api;
}

const INPUT = { projectId: 'prj-1', workspaceId: 'ws-1' };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('starting a run', () => {
  it('starts, then reads the status and the report', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    expect(api.startRun).toHaveBeenCalledWith(INPUT);
    expect(result.current.started?.runId).toBe('run-1');
    expect(result.current.status?.state).toBe('awaiting_approval');
    expect(result.current.report?.status).toBe('BLOCKED');
    expect(result.current.error).toBe('');
  });

  it('shows the failure and no stale run when starting fails', async () => {
    const api = fakeApi({
      startRun: vi.fn().mockRejectedValue(new Error('That project was not found.')),
    });
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    expect(result.current.started).toBeNull();
    expect(result.current.status).toBeNull();
    expect(result.current.error).not.toBe('');
    expect(result.current.busy).toBe(false);
  });
});

describe('following a run', () => {
  it('does not poll while the run waits for a person', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    const calls = (api.fetchStatus as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect((api.fetchStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it('keeps checking a working run, and stops once it finishes', async () => {
    const states: RunStatus[] = [status('running'), status('running'), status('completed')];
    const fetchStatus = vi
      .fn()
      .mockImplementation(() => Promise.resolve(states.shift() ?? status('completed')));
    const api = fakeApi({ fetchStatus });
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    await waitFor(() => expect(result.current.status?.state).toBe('completed'));
    const settled = fetchStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetchStatus.mock.calls.length).toBe(settled);
  });

  it('keeps checking after one failed check instead of freezing', async () => {
    let call = 0;
    const fetchStatus = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(status('running'));
      if (call === 2) return Promise.reject(new Error('Cannot reach the service.'));
      return Promise.resolve(status('completed'));
    });
    const api = fakeApi({ fetchStatus });
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    await waitFor(() => expect(result.current.status?.state).toBe('completed'), { timeout: 3000 });
  });

  it('loads the repair plan when a repair needs approval', async () => {
    const api = fakeApi({
      fetchStatus: vi
        .fn()
        .mockResolvedValue(status('awaiting_repair_approval', { kind: 'repair_approval' })),
    });
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    expect(api.fetchRepairPlan).toHaveBeenCalledWith('run-1');
    expect(result.current.repairPlan?.approvalRoute).toBe('/api/testing/runs/run-1/approval');
  });

  it('stops polling and ignores late replies after the page is left', async () => {
    let release: (value: RunStatus) => void = () => undefined;
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(status('running'))
      .mockImplementationOnce(() => new Promise<RunStatus>((resolve) => (release = resolve)));
    const api = fakeApi({ fetchStatus });
    const { result, unmount } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    unmount();
    const calls = fetchStatus.mock.calls.length;
    release(status('completed'));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchStatus.mock.calls.length).toBe(calls);
  });
});

describe('a person’s decisions', () => {
  it('sends an approval to the approval route and then refreshes', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    await act(async () => {
      await result.current.decide('approve');
    });
    expect(api.decide).toHaveBeenCalledWith('run-1', 'approve');
    expect((api.fetchStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it('sends a rejection as a rejection', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    await act(async () => {
      await result.current.decide('reject');
    });
    expect(api.decide).toHaveBeenCalledWith('run-1', 'reject');
  });

  it('decides nothing before a run exists', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.decide('approve');
    });
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('shows why a decision failed and re-reads the real state', async () => {
    const api = fakeApi({
      decide: vi.fn().mockRejectedValue(new Error('That run already finished.')),
    });
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    const before = (api.fetchStatus as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await result.current.decide('approve');
    });
    expect(result.current.error).not.toBe('');
    expect((api.fetchStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
    expect(result.current.busy).toBe(false);
  });

  it('cancels, then reads the cancelled state', async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(status('awaiting_approval', { kind: 'plan_approval' }))
      .mockResolvedValue(status('cancelled'));
    const api = fakeApi({ fetchStatus });
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    await act(async () => {
      await result.current.start(INPUT);
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(api.cancelRun).toHaveBeenCalledWith('run-1');
    expect(result.current.status?.state).toBe('cancelled');
  });
});

describe('starting a second run', () => {
  it('drops the first run’s answers once a new run begins', async () => {
    let releaseFirst: (value: RunStatus) => void = () => undefined;
    const fetchStatus = vi
      .fn()
      .mockImplementationOnce(() => new Promise<RunStatus>((resolve) => (releaseFirst = resolve)))
      .mockResolvedValue(status('awaiting_approval', { kind: 'plan_approval' }));
    const startRun = vi
      .fn()
      .mockResolvedValueOnce({ ...STARTED, runId: 'run-1' })
      .mockResolvedValueOnce({ ...STARTED, runId: 'run-2' });
    const api = fakeApi({ fetchStatus, startRun });
    const { result } = renderHook(() => useTestingRun({ api, pollMs: 50 }));
    void act(() => {
      void result.current.start(INPUT);
    });
    await act(async () => {
      await result.current.start(INPUT);
    });
    await act(async () => {
      releaseFirst({ ...status('completed'), runId: 'run-1' });
      await Promise.resolve();
    });
    expect(result.current.started?.runId).toBe('run-2');
    expect(result.current.status?.state).not.toBe('completed');
  });
});
