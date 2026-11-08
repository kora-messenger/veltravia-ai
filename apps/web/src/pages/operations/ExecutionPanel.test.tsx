import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ThemeProvider } from '../../theme/ThemeProvider';
import { ToastProvider } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  dispatchExecution,
  getExecution,
  listExecutions,
  reviewExecutionTask,
  syncExecution,
  cancelExecution,
  type ExecutionSummaryView,
  type ExecutionView,
} from '../../api/executions';
import { ExecutionPanel } from './ExecutionPanel';

vi.mock('../../api/executions', () => ({
  EXECUTION_STATUSES: ['executing', 'awaiting_review', 'completed'],
  PROGRESS_STATES: ['ready', 'running', 'review', 'done', 'waiting', 'blocked', 'failed'],
  listExecutions: vi.fn(),
  getExecution: vi.fn(),
  startExecution: vi.fn(),
  dispatchExecution: vi.fn(),
  syncExecution: vi.fn(),
  reviewExecutionTask: vi.fn(),
  cancelExecution: vi.fn(),
  getExecutionCapabilities: vi.fn(),
}));

const summary: ExecutionSummaryView = {
  id: 'exe_1',
  projectId: 'proj_1',
  status: 'executing',
  objective: 'Add a settings loader',
  taskIds: ['tsk_1', 'tsk_2'],
  workerIds: ['wkr_1'],
  createdAt: '2026-11-08T06:00:00.000Z',
  updatedAt: '2026-11-08T06:05:00.000Z',
  stoppedReason: null,
};

function view(overrides: Partial<ExecutionView> = {}): ExecutionView & { report: never } {
  const base = {
    execution: summary,
    plan: {
      objective: 'Add a settings loader',
      tasks: [
        {
          key: 'understand',
          title: 'Establish what the request needs',
          workerType: 'analysis',
          phase: 'sequential',
          dependsOn: [],
          scope: ['src'],
          verification: 'none',
          approval: null,
          taskId: 'tsk_1',
        },
        {
          key: 'verify',
          title: 'Prove the work with a verification run',
          workerType: 'testing',
          phase: 'sequential',
          dependsOn: ['understand'],
          scope: ['tests'],
          verification: 'unit',
          approval: null,
          taskId: 'tsk_2',
        },
      ],
      approvals: [],
      notes: [],
    },
    progress: {
      outcome: 'executing',
      tasks: [
        {
          key: 'understand',
          title: 'Establish what the request needs',
          status: 'review',
          workerId: 'wkr_1',
          note: null,
        },
        {
          key: 'verify',
          title: 'Prove the work with a verification run',
          status: 'waiting',
          workerId: null,
          note: null,
        },
      ],
      counts: { review: 1, waiting: 1 },
      evidence: { verificationRuns: 0, changeSets: 0, recoveryCases: 0 },
    },
  } as unknown as ExecutionView;
  return { ...base, ...overrides } as ExecutionView & { report: never };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'exe_1',
    objective: 'Add a settings loader',
    outcome: 'partial',
    completed: [],
    partial: [],
    blocked: [],
    failed: [],
    notStarted: ['Prove the work with a verification run'],
    verification: [],
    limits: [],
    ...overrides,
  };
}

function renderPanel() {
  const onChanged = vi.fn();
  render(
    <ThemeProvider>
      <ToastProvider>
        <ExecutionPanel onChanged={onChanged} />
      </ToastProvider>
    </ThemeProvider>,
  );
  return { onChanged };
}

describe('ExecutionPanel', () => {
  beforeEach(() => {
    vi.mocked(listExecutions).mockResolvedValue([summary]);
    vi.mocked(getExecution).mockResolvedValue(
      view({ report: report() } as unknown as Partial<ExecutionView>) as never,
    );
    vi.mocked(dispatchExecution).mockResolvedValue(view() as never);
    vi.mocked(syncExecution).mockResolvedValue(view() as never);
    vi.mocked(reviewExecutionTask).mockResolvedValue(view() as never);
    vi.mocked(cancelExecution).mockResolvedValue(view() as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('says when no execution has been started instead of showing an empty table', async () => {
    vi.mocked(listExecutions).mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByText(/No execution has been started yet/)).toBeTruthy());
  });

  it('reports work waiting for a decision as needing review, not as done', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Open execution exe_1/ }));

    await waitFor(() => expect(screen.getByText('Needs review')).toBeTruthy());
    expect(screen.queryByText('Done')).toBeNull();
    // Dependents are not presented as started while their prerequisite waits.
    expect(screen.getByText('Waiting')).toBeTruthy();
  });

  it('accepts work through the execution route and re-reads the records', async () => {
    const { onChanged } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Open execution exe_1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(vi.mocked(reviewExecutionTask)).toHaveBeenCalledWith('exe_1', 'tsk_1', 'accept'),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('starts ready tasks and reconciles without claiming the work is finished', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Open execution exe_1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start ready tasks' }));
    await waitFor(() => expect(vi.mocked(dispatchExecution)).toHaveBeenCalledWith('exe_1'));

    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile progress' }));
    await waitFor(() => expect(vi.mocked(syncExecution)).toHaveBeenCalledWith('exe_1'));
    expect(vi.mocked(syncExecution)).toHaveBeenCalledTimes(1);
  });

  it('states that nothing is proven when no stored verification run covers the work', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Open execution exe_1/ }));

    await waitFor(() =>
      expect(screen.getByText(/No stored verification run covers this execution yet/)).toBeTruthy(),
    );
  });

  it('shows a readable failure and changes nothing when the records cannot be read', async () => {
    vi.mocked(listExecutions).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'Server busy'));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/The execution records could not be read/)).toBeTruthy(),
    );
    expect(vi.mocked(dispatchExecution)).not.toHaveBeenCalled();
  });
});
