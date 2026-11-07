import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { ToastProvider } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  listChangeSets,
  listIntegrations,
  listSchedulingDecisions,
  listTasks,
  listVerificationRuns,
  listWorkers,
  type ChangeSetView,
  type TaskView,
  type VerificationRunView,
  type WorkerView,
} from '../../api/operations';
import { OperationsPage } from './OperationsPage';

vi.mock('../../api/operations', () => ({
  listWorkers: vi.fn(),
  listTasks: vi.fn(),
  listChangeSets: vi.fn(),
  listIntegrations: vi.fn(),
  listVerificationRuns: vi.fn(),
  listSchedulingDecisions: vi.fn(),
  getWorker: vi.fn(),
  listWorkerEvents: vi.fn(),
  cancelWorker: vi.fn(),
  requeueWorker: vi.fn(),
  reviewWorker: vi.fn(),
  getChangeSet: vi.fn(),
  changeSetDiff: vi.fn(),
  analyzeChangeSets: vi.fn(),
  recordApproval: vi.fn(),
  runIntegration: vi.fn(),
  rollbackIntegration: vi.fn(),
}));

const mockedListWorkers = vi.mocked(listWorkers);
const mockedListTasks = vi.mocked(listTasks);
const mockedListChangeSets = vi.mocked(listChangeSets);
const mockedListIntegrations = vi.mocked(listIntegrations);
const mockedListVerificationRuns = vi.mocked(listVerificationRuns);
const mockedListSchedulingDecisions = vi.mocked(listSchedulingDecisions);

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    id: 'wrk_1',
    taskId: 'task_1',
    parentTaskId: null,
    workerType: 'backend',
    status: 'awaiting_review',
    assignment: {
      objective: 'Add the settings loader',
      scope: ['src/settings'],
      exclusions: ['src/secrets'],
      deliverables: [],
      acceptanceCriteria: ['Tests pass'],
      allowedTools: ['project.read', 'project.write'],
      permissions: { readProject: true, writeProject: true, runTools: false, network: false },
      limits: { maxDurationMs: 300000, maxToolCalls: 20, maxDeliverables: 5 },
      dependencies: [],
      checkpoints: [],
      cancellationConditions: [],
      reporting: [],
    },
    resources: [{ kind: 'file', path: 'src/settings/load.ts' }],
    result: {
      summary: 'Wrote the loader',
      deliverables: [
        { name: 'loader', kind: 'file', path: 'src/settings/load.ts', summary: 'new file' },
      ],
      evidence: [{ kind: 'note', ref: 'note-1', summary: 'Read the existing config' }],
      notes: null,
      finishedAt: '2026-11-07T09:05:00.000Z',
      simulated: false,
      usage: {
        providerId: 'openrouter',
        modelId: 'openai/gpt-4o-mini',
        modelCalls: 3,
        toolCalls: 5,
        inputTokens: 1200,
        outputTokens: 340,
        live: true,
      },
    },
    review: null,
    failure: null,
    attempts: 1,
    retryNotBefore: null,
    startedAt: '2026-11-07T09:00:00.000Z',
    endedAt: '2026-11-07T09:05:00.000Z',
    lastHeartbeatAt: '2026-11-07T09:04:30.000Z',
    createdAt: '2026-11-07T08:59:00.000Z',
    updatedAt: '2026-11-07T09:05:00.000Z',
    version: 4,
    eventSeq: 6,
    ...overrides,
  };
}

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'task_1',
    projectId: 'prj_1',
    parentTaskId: null,
    title: 'Settings loader',
    objective: 'Ship the settings loader',
    status: 'awaiting_review',
    createdBy: 'primary_agent',
    createdAt: '2026-11-07T08:50:00.000Z',
    updatedAt: '2026-11-07T09:05:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function changeSet(overrides: Partial<ChangeSetView> = {}): ChangeSetView {
  return {
    id: 'chg_1',
    projectId: 'prj_1',
    workspaceId: 'ws_1',
    taskId: 'task_1',
    workerId: 'wrk_1',
    baseRevision: 12,
    title: 'Changes from implementation worker',
    files: [
      {
        path: 'src/settings/load.ts',
        op: 'create',
        baseHash: null,
        proposedHash: 'abc',
        size: 20,
        artifactRef: 'art-1',
      },
    ],
    deliverables: [],
    authorization: { allowedPaths: ['src/settings'], excludedPaths: [], allowedTools: [] },
    verification: { runIds: [], status: 'none' },
    status: 'open',
    createdAt: '2026-11-07T09:06:00.000Z',
    updatedAt: '2026-11-07T09:06:00.000Z',
    integrationId: null,
    scopeComplete: true,
    ...overrides,
  };
}

function verificationRun(overrides: Partial<VerificationRunView> = {}): VerificationRunView {
  return {
    id: 'vr_1',
    projectId: 'prj_1',
    taskId: 'task_1',
    workerId: 'wrk_1',
    revision: '44',
    status: 'passed',
    requestedOperations: ['unit'],
    blocked: [],
    results: [
      {
        operation: 'unit',
        commandId: 'npm:test',
        label: 'Unit tests',
        argv: ['npm', 'run', 'test', '--silent'],
        status: 'passed',
        exitCode: 0,
        durationMs: 4200,
        counts: { discovered: 12, passed: 12, failed: 0, skipped: 0 },
        buildStatus: 'not_applicable',
        errorSummary: null,
        outputTail: '',
        truncated: false,
        reason: null,
        providesOsIsolation: false,
      },
    ],
    evidence: {
      executed: true,
      executedCount: 1,
      passedCount: 1,
      failedCount: 0,
      status: 'passed',
      finishedAt: '2026-11-07T09:10:00.000Z',
    },
    startedAt: '2026-11-07T09:09:00.000Z',
    finishedAt: '2026-11-07T09:10:00.000Z',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <OperationsPage />
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  mockedListWorkers.mockResolvedValue({
    workers: [worker()],
    storage: { store: 'memory', durable: false },
  });
  mockedListTasks.mockResolvedValue([task()]);
  mockedListChangeSets.mockResolvedValue([changeSet()]);
  mockedListIntegrations.mockResolvedValue([]);
  mockedListVerificationRuns.mockResolvedValue([verificationRun()]);
  mockedListSchedulingDecisions.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OperationsPage', () => {
  it('shows a loading state before the first read lands', async () => {
    mockedListWorkers.mockImplementation(() => new Promise(() => undefined));
    renderPage();
    expect(screen.getByText(/Reading the Primary Agent's records/)).toBeTruthy();
  });

  it('renders the fleet, tasks, change sets and verification from the server records', async () => {
    renderPage();
    await screen.findByText('Settings loader');

    expect(screen.getByText('Add the settings loader')).toBeTruthy();
    expect(screen.getAllByText('Awaiting review').length).toBeGreaterThan(0);
    // Change set in the list and its worker count in the summary line.
    expect(screen.getByText('Changes from implementation worker')).toBeTruthy();
    // Verification headline comes from the counts, not from the status alone.
    expect(screen.getByText('12 passed, 0 failed, 0 skipped.')).toBeTruthy();
  });

  it('says plainly that a run with no executed command proved nothing', async () => {
    mockedListVerificationRuns.mockResolvedValue([
      verificationRun({
        status: 'incomplete',
        results: [],
        evidence: {
          executed: false,
          executedCount: 0,
          passedCount: 0,
          failedCount: 0,
          status: 'incomplete',
          finishedAt: null,
        },
      }),
    ]);
    renderPage();
    await screen.findByText(/no verification runtime was configured/);
    expect(screen.getAllByText('Nothing ran').length).toBeGreaterThan(0);
  });

  it('reports a refused operation as nothing ran, naming the reason', async () => {
    mockedListVerificationRuns.mockResolvedValue([
      verificationRun({
        status: 'incomplete',
        results: [],
        blocked: [{ operation: 'unit', reason: 'not_in_profile', detail: 'No test script.' }],
        evidence: {
          executed: false,
          executedCount: 0,
          passedCount: 0,
          failedCount: 0,
          status: 'incomplete',
          finishedAt: null,
        },
      }),
    ]);
    renderPage();
    await screen.findByText(/unit was refused \(not in profile\)/);
  });

  it('shows usage provenance for a live worker and never invents cost', async () => {
    const { getWorker, listWorkerEvents } = await import('../../api/operations');
    vi.mocked(getWorker).mockResolvedValue(worker());
    vi.mocked(listWorkerEvents).mockResolvedValue([]);
    renderPage();
    await screen.findByText('Settings loader');

    fireEvent.click(screen.getByRole('button', { name: /View details for backend wrk_1/ }));
    await screen.findByText('openrouter · openai/gpt-4o-mini');
    expect(screen.getByText('Real provider call')).toBeTruthy();
    expect(screen.getByText(/Costs are not shown/)).toBeTruthy();
  });

  it('labels a simulated worker as not billed', async () => {
    const simulated = worker({
      status: 'completed',
      result: {
        summary: 'Simulated',
        deliverables: [],
        evidence: [],
        notes: null,
        finishedAt: '2026-11-07T09:05:00.000Z',
        simulated: true,
        usage: {
          providerId: null,
          modelId: null,
          modelCalls: 0,
          toolCalls: 2,
          inputTokens: 0,
          outputTokens: 0,
          live: false,
        },
      },
    });
    mockedListWorkers.mockResolvedValue({
      workers: [simulated],
      storage: { store: 'memory', durable: false },
    });
    const { getWorker, listWorkerEvents } = await import('../../api/operations');
    vi.mocked(getWorker).mockResolvedValue(simulated);
    vi.mocked(listWorkerEvents).mockResolvedValue([]);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /View details for backend/ }));
    await screen.findByText('Simulated (not billed)');
    expect(screen.getByText(/No model was called and no real work ran/)).toBeTruthy();
  });

  it('shows an empty state when the Primary Agent has delegated nothing', async () => {
    mockedListWorkers.mockResolvedValue({
      workers: [],
      storage: { store: 'memory', durable: false },
    });
    mockedListTasks.mockResolvedValue([]);
    mockedListChangeSets.mockResolvedValue([]);
    mockedListVerificationRuns.mockResolvedValue([]);
    renderPage();
    await screen.findByText('No Superagents yet');
    expect(screen.getByText(/No tasks have been created yet/)).toBeTruthy();
  });

  it('offers a retry when the first read fails, and changes nothing', async () => {
    mockedListWorkers.mockRejectedValue(new ApiError(503, 'SERVICE_UNAVAILABLE', 'Not ready yet.'));
    renderPage();
    await screen.findByText('The operations dashboard could not load');
    expect(screen.getByText('Not ready yet.')).toBeTruthy();

    mockedListWorkers.mockResolvedValue({
      workers: [worker()],
      storage: { store: 'memory', durable: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Add the settings loader');
  });

  it('filters the fleet by status through the summary tiles', async () => {
    mockedListWorkers.mockResolvedValue({
      workers: [worker(), worker({ id: 'wrk_2', status: 'failed', workerType: 'research' })],
      storage: { store: 'memory', durable: false },
    });
    renderPage();
    await screen.findByText('Settings loader');
    expect(screen.getByText(/2 Superagent records/)).toBeTruthy();

    const tiles = screen.getByRole('region', { name: 'Fleet summary' });
    fireEvent.click(within(tiles).getByRole('button', { name: 'Failed1' }));
    await waitFor(() => {
      // Only the failed worker's row remains: the implementation worker is gone.
      expect(screen.queryByText('backend')).toBeNull();
    });
    expect(screen.getByText('research')).toBeTruthy();
  });

  it('keeps working data visible when a later refresh fails', async () => {
    renderPage();
    await screen.findByText('Settings loader');
    mockedListWorkers.mockRejectedValueOnce(
      new ApiError(0, 'NETWORK', 'Cannot reach the service.'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await screen.findByText(/The latest refresh failed/);
    expect(screen.getByText('Settings loader')).toBeTruthy();
  });

  it('shows scheduling decisions with the reasons work was held', async () => {
    mockedListSchedulingDecisions.mockResolvedValue([
      {
        id: 'dec_1',
        at: '2026-11-07T09:00:00.000Z',
        limit: 2,
        active: 2,
        selected: ['wrk_1'],
        skipped: [{ workerId: 'wrk_9', taskId: 'task_1', reason: 'file claim overlaps wrk_1' }],
      },
    ]);
    renderPage();
    await screen.findByText('1 started, 1 held');
    expect(screen.getByText(/file claim overlaps wrk_1/)).toBeTruthy();
  });

  it('labels the refresh as polling rather than live streaming', async () => {
    renderPage();
    await screen.findByText('Settings loader');
    expect(screen.getByText(/Refreshes every 5s/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause refreshing' }));
    expect(screen.getByText(/Auto-refresh paused/)).toBeTruthy();
  });

  it('opens a change set for review and shows both sides of the file', async () => {
    const { getChangeSet, changeSetDiff } = await import('../../api/operations');
    vi.mocked(getChangeSet).mockResolvedValue({
      changeSet: changeSet(),
      validation: { ok: true, problems: [], stale: [] },
      currentRevision: 12,
    });
    vi.mocked(changeSetDiff).mockResolvedValue({
      changeSetId: 'chg_1',
      title: 'Changes from implementation worker',
      status: 'open',
      baseRevision: 12,
      files: [
        {
          path: 'src/settings/load.ts',
          op: 'create',
          baseHash: null,
          proposedHash: 'abc',
          size: 20,
          base: null,
          proposed: 'export const loaded = true;\n',
          baseStale: false,
          contentAvailable: true,
        },
      ],
      omittedFiles: 0,
      maxChars: 20000,
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Changes from implementation worker' }),
    );

    const pane = await screen.findByRole('region', { name: 'Selected change set' });
    await within(pane).findByText(/Every file is inside scope/);
    expect(within(pane).getByText('Added')).toBeTruthy();
    expect(within(pane).getByText('export const loaded = true;')).toBeTruthy();
    // Integration is not offered before an approval is recorded.
    expect(within(pane).getByRole('button', { name: 'Integrate' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows detected conflicts and refuses to offer approval', async () => {
    const { getChangeSet, changeSetDiff, analyzeChangeSets } = await import('../../api/operations');
    vi.mocked(getChangeSet).mockResolvedValue({
      changeSet: changeSet(),
      validation: { ok: true, problems: [], stale: [] },
      currentRevision: 13,
    });
    vi.mocked(changeSetDiff).mockResolvedValue({
      changeSetId: 'chg_1',
      title: 'Changes from implementation worker',
      status: 'open',
      baseRevision: 12,
      files: [],
      omittedFiles: 0,
      maxChars: 20000,
    });
    vi.mocked(analyzeChangeSets).mockResolvedValue({
      currentRevision: 13,
      reports: [],
      conflicts: [
        {
          kind: 'same_file',
          paths: ['src/settings/load.ts'],
          changeSetIds: ['chg_1', 'chg_2'],
          convergent: false,
          message: 'Two proposals write src/settings/load.ts.',
          suggestion: 'Integrate one, then re-plan the other.',
        },
      ],
      blocked: true,
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Changes from implementation worker' }),
    );
    const pane = await screen.findByRole('region', { name: 'Selected change set' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Analyse conflicts' }));

    await within(pane).findByText('Two proposals write src/settings/load.ts.');
    expect(
      within(pane).getByText(/Nothing will be integrated until they are resolved/),
    ).toBeTruthy();
    expect(within(pane).getByRole('button', { name: 'Approve changes' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('surfaces a refused review in the server’s own words', async () => {
    const { getWorker, listWorkerEvents, reviewWorker } = await import('../../api/operations');
    vi.mocked(getWorker).mockResolvedValue(worker());
    vi.mocked(listWorkerEvents).mockResolvedValue([]);
    vi.mocked(reviewWorker).mockRejectedValue(
      new ApiError(409, 'WORKER_REVIEW_REFUSED', 'The claimed test run does not exist.'),
    );

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /View details for backend/ }));
    const accept = await screen.findByRole('button', { name: 'Accept' });
    fireEvent.click(accept);

    await screen.findByText('The claimed test run does not exist.');
    // Nothing is retried automatically: the worker is still awaiting review.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('asks for confirmation before cancelling a running worker', async () => {
    const running = worker({ status: 'running', endedAt: null, result: null });
    mockedListWorkers.mockResolvedValue({
      workers: [running],
      storage: { store: 'memory', durable: false },
    });
    const { getWorker, listWorkerEvents, cancelWorker } = await import('../../api/operations');
    vi.mocked(getWorker).mockResolvedValue(running);
    vi.mocked(listWorkerEvents).mockResolvedValue([]);
    vi.mocked(cancelWorker).mockResolvedValue(worker({ status: 'cancelled' }));

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /View details for backend/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this work' }));

    // Nothing is cancelled until the confirmation is answered.
    expect(cancelWorker).not.toHaveBeenCalled();
    await screen.findByText('Cancel this work?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the work' }));

    await screen.findByText('Cancelled.');
    expect(cancelWorker).toHaveBeenCalledWith('wrk_1', expect.stringContaining('Cancelled'));
  });
});
