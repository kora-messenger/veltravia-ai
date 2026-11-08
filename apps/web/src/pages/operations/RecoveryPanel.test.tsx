import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ThemeProvider } from '../../theme/ThemeProvider';
import { ToastProvider } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  cancelRecoveryCase,
  getRecoveryCase,
  reanalyseRecoveryCase,
  type RecoveryCaseView,
  type RecoveryOverviewView,
  type RepairAttemptView,
} from '../../api/recovery';
import type { TaskView, WorkerView } from '../../api/operations';
import { RecoveryPanel } from './RecoveryPanel';
import { recoveryNotificationsFor, isRecoveredWithEvidence } from './recovery-status';

vi.mock('../../api/recovery', () => ({
  RECOVERY_STATUSES: [
    'open',
    'diagnosing',
    'repairing',
    'awaiting_verification',
    'recovered',
    'escalated',
    'blocked',
    'cancelled',
  ],
  FAILURE_CATEGORIES: [
    'missing_deliverables',
    'unverified_completion',
    'verification_failed',
    'worker_timeout',
    'worker_cancelled',
    'worker_blocked',
    'permission_refused',
    'change_conflict',
    'incompatible_output',
    'repeated_attempts',
    'unknown',
  ],
  getRecoveryCase: vi.fn(),
  reanalyseRecoveryCase: vi.fn(),
  cancelRecoveryCase: vi.fn(),
  listRecoveryCases: vi.fn(),
  getRecoveryOverview: vi.fn(),
}));

const mockedDetail = vi.mocked(getRecoveryCase);
const mockedReanalyse = vi.mocked(reanalyseRecoveryCase);
const mockedCancel = vi.mocked(cancelRecoveryCase);

const at = '2026-11-07T10:00:00.000Z';

function caseRecord(overrides: Partial<RecoveryCaseView> = {}): RecoveryCaseView {
  return {
    id: 'rcv_case_1',
    projectId: 'prj_1',
    taskId: 'tsk_original',
    workerId: 'wkr_failed',
    workerType: 'backend',
    status: 'open',
    diagnosis: {
      primary: 'missing_deliverables',
      classification: 'permanent',
      findings: [],
      likelyCause: 'The loader file was never written.',
      affectedDeliverables: ['src/settings/load.ts'],
      recommendedAction: 'repair_worker',
      requiredPermissions: [],
      confidence: 'medium',
      reason: 'One evidence source: the worker produced nothing for a declared file.',
      evidence: [{ kind: 'worker_result', ref: 'wkr_failed', detail: 'no file written' }],
      insufficient: false,
    },
    observation: {
      projectId: 'prj_1',
      taskId: 'tsk_original',
      workerId: 'wkr_failed',
      workerType: 'backend',
      workerStatus: 'awaiting_review',
      failure: null,
      deliverables: {
        declared: ['src/settings/load.ts', 'src/settings/notes.md'],
        produced: [],
        missing: ['src/settings/load.ts'],
      },
      verification: null,
      changeSet: null,
      revision: { base: null, now: null },
      declaration: {
        scope: ['src/settings'],
        acceptanceCriteria: ['loads settings'],
        allowedTools: ['project.read'],
      },
    },
    limits: { maxAttempts: 3, maxTotalDurationMs: 600_000, maxReassignments: 1 },
    attempts: 0,
    reassignments: 0,
    stoppedReason: null,
    escalation: null,
    verification: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...overrides,
  };
}

function overview(overrides: Partial<RecoveryOverviewView> = {}): RecoveryOverviewView {
  return {
    total: 4,
    byStatus: { open: 1, repairing: 1, recovered: 1, escalated: 1 },
    byCategory: { missing_deliverables: 2 },
    awaitingDiagnosis: 1,
    repairing: 1,
    awaitingVerification: 0,
    recovered: 1,
    needsIntervention: 1,
    insufficientEvidence: 1,
    verificationFailed: 1,
    exhausted: 1,
    attemptsUsed: 4,
    attemptsRemaining: 5,
    truncated: false,
    generatedAt: at,
    ...overrides,
  };
}

function attempt(overrides: Partial<RepairAttemptView> = {}): RepairAttemptView {
  return {
    id: 'att_1',
    attempt: 1,
    action: 'repair_worker',
    workerId: 'wkr_repair_1',
    workerType: 'backend',
    startedAt: at,
    endedAt: at,
    outcome: 'failed',
    summary: 'The repair wrote the loader but the tests still failed.',
    verificationRunId: 'run_1',
    changeSetId: 'cs_1',
    waitedMs: 2000,
    ...overrides,
  };
}

const tasks = [
  {
    id: 'tsk_original',
    title: 'Settings loader',
    objective: 'Load the settings.',
    status: 'failed',
    projectId: 'prj_1',
    parentTaskId: null,
  },
  {
    id: 'tsk_child_1',
    title: 'Repair: tsk_original',
    objective: 'Redo the loader.',
    status: 'failed',
    projectId: 'prj_1',
    parentTaskId: 'tsk_original',
  },
] as unknown as readonly TaskView[];

const workers = [
  { id: 'wkr_failed', workerType: 'backend', status: 'failed', taskId: 'tsk_original' },
  { id: 'wkr_repair_1', workerType: 'backend', status: 'failed', taskId: 'tsk_child_1' },
] as unknown as readonly WorkerView[];

interface RenderOptions {
  readonly cases?: readonly RecoveryCaseView[];
  readonly filters?: Parameters<typeof RecoveryPanel>[0]['filters'];
  readonly onFiltersChange?: (filters: Parameters<typeof RecoveryPanel>[0]['filters']) => void;
  readonly onOpenTask?: (taskId: string) => void;
  readonly onOpenWorker?: (workerId: string) => void;
  readonly onOpenChangeSet?: (changeSetId: string) => void;
  readonly onChanged?: (message: string) => void;
  readonly onNotifyFailed?: (message: string) => void;
  readonly overviewValue?: RecoveryOverviewView;
  readonly readAt?: number;
}

function renderPanel(options: RenderOptions = {}) {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <RecoveryPanel
          cases={options.cases ?? [caseRecord()]}
          overview={options.overviewValue ?? overview()}
          filters={options.filters ?? {}}
          onFiltersChange={options.onFiltersChange ?? (() => undefined)}
          tasks={tasks}
          workers={workers}
          projects={['prj_1']}
          onRefresh={() => undefined}
          onChanged={options.onChanged ?? (() => undefined)}
          onNotifyFailed={options.onNotifyFailed ?? (() => undefined)}
          onOpenTask={options.onOpenTask ?? (() => undefined)}
          onOpenWorker={options.onOpenWorker ?? (() => undefined)}
          onOpenChangeSet={options.onOpenChangeSet ?? (() => undefined)}
          readAt={options.readAt ?? 1}
        />
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDetail.mockResolvedValue({
    case: caseRecord(),
    attempts: [],
    events: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('recovery overview', () => {
  it('shows every count the server reported, including insufficient evidence', () => {
    renderPanel();
    const section = screen.getByLabelText('Recovery');
    expect(within(section).getByText('Recovery cases')).toBeTruthy();
    expect(within(section).getByText('4')).toBeTruthy();
    expect(within(section).getByText('Insufficient evidence')).toBeTruthy();
    expect(within(section).getByText('Attempts used up')).toBeTruthy();
    expect(within(section).getByText(/5 repair attempts left across open cases/)).toBeTruthy();
  });

  it('asks the server for the filtered set when a tile is chosen', () => {
    const onFiltersChange = vi.fn();
    renderPanel({ onFiltersChange });
    fireEvent.click(screen.getByRole('button', { name: /Needs intervention/i }));
    expect(onFiltersChange).toHaveBeenCalledWith({ status: ['escalated'] });
    fireEvent.click(screen.getByRole('button', { name: /Insufficient evidence/i }));
    expect(onFiltersChange).toHaveBeenCalledWith({ insufficientEvidence: true });
  });
});

describe('case listing', () => {
  it('lists a case with its state, failure and attempt budget', () => {
    renderPanel();
    const table = screen.getByRole('table');
    expect(within(table).getByText('rcv_case_1')).toBeTruthy();
    expect(within(table).getByText('Declared work was not produced')).toBeTruthy();
    expect(within(table).getByText('0 of 3')).toBeTruthy();
    expect(within(table).getByText('Awaiting diagnosis')).toBeTruthy();
  });

  it('shows an empty state rather than an empty table', () => {
    renderPanel({ cases: [] });
    expect(screen.getByText('No recovery cases match')).toBeTruthy();
    expect(screen.getByText(/No Superagent failure has needed repair yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('explains an empty result that is empty because of a filter', () => {
    renderPanel({ cases: [], filters: { status: ['recovered'] } });
    expect(screen.getByText(/Nothing matches Recovered/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
  });
});

describe('case details', () => {
  it('separates observed facts from the diagnosis', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    await screen.findByRole('region', { name: 'Recovery case rcv_case_1' });

    const observed = await screen.findByLabelText('Observed facts');
    expect(within(observed).getByText(/awaiting review/)).toBeTruthy();
    expect(within(observed).getByText(/Missing: src\/settings\/load.ts/)).toBeTruthy();
    expect(within(observed).getByText(/These are read from the worker/)).toBeTruthy();

    const diagnosis = screen.getByLabelText('Diagnosis');
    expect(within(diagnosis).getByText('The loader file was never written.')).toBeTruthy();
    expect(within(diagnosis).getByText('Medium confidence')).toBeTruthy();
    expect(within(diagnosis).getByText(/repair worker/)).toBeTruthy();
    expect(within(diagnosis).getByText('wkr_failed')).toBeTruthy();
  });

  it('shows insufficient_evidence and the reason instead of inventing a cause', async () => {
    const record = caseRecord({
      diagnosis: {
        primary: null,
        classification: null,
        findings: [],
        likelyCause: null,
        affectedDeliverables: [],
        recommendedAction: null,
        requiredPermissions: [],
        confidence: 'low',
        reason: 'The worker record carries no failure, no verification run and no change set.',
        evidence: [],
        insufficient: true,
      },
    });
    mockedDetail.mockResolvedValue({ case: record, attempts: [], events: [] });
    renderPanel({ cases: [record] });
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));

    await screen.findByText('insufficient_evidence');
    expect(
      screen.getByText(
        'The worker record carries no failure, no verification run and no change set.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'The case needs a person to decide what to do next. No explanation was invented to fill the gap.',
      ),
    ).toBeTruthy();
    // A declining diagnosis names no cause and recommends no action.
    expect(screen.queryByText(/Recommended action/)).toBeNull();
    expect(screen.queryByText('Low confidence')).toBeNull();
  });

  it('reports a failed read without pretending the case is gone', async () => {
    mockedDetail.mockRejectedValue(new ApiError(404, 'RECOVERY_CASE_NOT_FOUND', 'No such case.'));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    expect(await screen.findByText('This case could not be read')).toBeTruthy();
    expect(screen.getByText('No such case.')).toBeTruthy();
  });
});

describe('repair attempt timeline', () => {
  it('shows each attempt with its own child task and the retry budget', async () => {
    const record = caseRecord({ status: 'repairing', attempts: 1 });
    mockedDetail.mockResolvedValue({
      case: record,
      attempts: [attempt()],
      events: [],
    });
    renderPanel({ cases: [record] });
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));

    const timeline = await screen.findByLabelText('Repair attempts');
    expect(within(timeline).getByText('Attempt 1')).toBeTruthy();
    expect(within(timeline).getByText('failed')).toBeTruthy();
    // The repair ran on its own child task, resolved through the worker record.
    expect(within(timeline).getByText('tsk_child_1')).toBeTruthy();
    expect(within(timeline).getByText(/\(1 of 3 · 2 left\)/)).toBeTruthy();
    expect(
      within(timeline).getByText(/Each repair runs on its own child task under the original one/),
    ).toBeTruthy();
    expect(within(timeline).getByText(/The failed task is never/)).toBeTruthy();
    expect(within(timeline).getByText(/waited 2s before starting/)).toBeTruthy();
  });

  it('says so plainly when no repair has been attempted', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    expect(await screen.findByText('No repair has been attempted yet.')).toBeTruthy();
  });
});

describe('recovered status is evidence-gated', () => {
  it('shows recovered only when a stored run actually passed', async () => {
    const record = caseRecord({
      status: 'recovered',
      attempts: 1,
      verification: {
        runId: 'run_passed',
        status: 'passed',
        executed: true,
        executedCount: 2,
        failedOperations: [],
        evidence: [],
      },
    });
    mockedDetail.mockResolvedValue({ case: record, attempts: [], events: [] });
    renderPanel({ cases: [record] });
    const table = screen.getByRole('table');
    expect(within(table).getByText('Recovered')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    const evidence = await screen.findByLabelText('Verification evidence');
    expect(within(evidence).getByText('run_passed')).toBeTruthy();
    expect(within(evidence).getByText('2 commands executed')).toBeTruthy();
    expect(
      within(evidence).getByText(
        'This evidence is the stored run that allows the case to be called recovered.',
      ),
    ).toBeTruthy();
  });

  it('refuses to display recovered when no passing run is stored', async () => {
    const record = caseRecord({ status: 'recovered', verification: null });
    mockedDetail.mockResolvedValue({ case: record, attempts: [], events: [] });
    renderPanel({ cases: [record] });

    const table = screen.getByRole('table');
    expect(within(table).queryByText('Recovered')).toBeNull();
    expect(within(table).getByText('Awaiting verification')).toBeTruthy();
    expect(isRecoveredWithEvidence(record)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    const warning = await screen.findByRole('alert');
    expect(
      within(warning).getByText(
        /no stored verification run passed. It is shown as awaiting verification until evidence exists/,
      ),
    ).toBeTruthy();
  });

  it('never calls a run that executed nothing a recovery', () => {
    const record = caseRecord({
      status: 'recovered',
      verification: {
        runId: 'run_empty',
        status: 'passed',
        executed: false,
        executedCount: 0,
        failedOperations: [],
        evidence: [],
      },
    });
    expect(isRecoveredWithEvidence(record)).toBe(false);
  });
});

describe('verification evidence', () => {
  it('names the failing operations of a failed run', async () => {
    const record = caseRecord({
      status: 'escalated',
      attempts: 3,
      verification: {
        runId: 'run_failed',
        status: 'failed',
        executed: true,
        executedCount: 3,
        failedOperations: ['unit', 'typecheck'],
        evidence: [],
      },
      escalation: {
        reason: 'budget_exhausted',
        message: 'Three repair attempts did not produce a passing run.',
        attempted: ['rewrite the loader'],
        remaining: ['src/settings/notes.md was never written'],
        at,
      },
    });
    mockedDetail.mockResolvedValue({ case: record, attempts: [], events: [] });
    renderPanel({ cases: [record] });
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));

    const evidence = await screen.findByLabelText('Verification evidence');
    expect(within(evidence).getByText('Failed')).toBeTruthy();
    expect(within(evidence).getByText('unit, typecheck')).toBeTruthy();

    const escalation = screen.getByLabelText('Escalation');
    expect(within(escalation).getByText('budget exhausted')).toBeTruthy();
    expect(within(escalation).getByText('rewrite the loader')).toBeTruthy();
    expect(within(escalation).getByText('src/settings/notes.md was never written')).toBeTruthy();
  });
});

describe('case management', () => {
  it('cancels only after an explicit confirmation', async () => {
    const onChanged = vi.fn();
    mockedCancel.mockResolvedValue(caseRecord({ status: 'cancelled' }));
    renderPanel({ onChanged });
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    await screen.findByText('Attempt 1').catch(() => undefined);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel recovery' }));
    expect(mockedCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it running' }));
    expect(mockedCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel recovery' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    await waitFor(() =>
      expect(mockedCancel).toHaveBeenCalledWith('rcv_case_1', expect.any(String)),
    );
    expect(onChanged).toHaveBeenCalledWith('The recovery case was cancelled.');
  });

  it('reports a refused cancellation in words the owner can read', async () => {
    const onNotifyFailed = vi.fn();
    mockedCancel.mockRejectedValue(
      new ApiError(409, 'RECOVERY_CASE_NOT_CANCELLABLE', 'This case already finished.'),
    );
    renderPanel({ onNotifyFailed });
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel recovery' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    await waitFor(() => expect(onNotifyFailed).toHaveBeenCalledWith('This case already finished.'));
  });

  it('re-reads the stored evidence when asked to diagnose again', async () => {
    const onChanged = vi.fn();
    mockedReanalyse.mockResolvedValue(caseRecord());
    renderPanel({ onChanged });
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Diagnose again' }));
    await waitFor(() => expect(mockedReanalyse).toHaveBeenCalledWith('rcv_case_1'));
    expect(onChanged).toHaveBeenCalledWith(
      'The case was diagnosed again from the stored evidence.',
    );
  });

  it('opens the original task, the failed worker and the change set', async () => {
    const onOpenTask = vi.fn();
    const onOpenWorker = vi.fn();
    const onOpenChangeSet = vi.fn();
    mockedDetail.mockResolvedValue({
      case: caseRecord({ attempts: 1 }),
      attempts: [attempt()],
      events: [],
    });
    renderPanel({ onOpenTask, onOpenWorker, onOpenChangeSet });
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));

    const facts = await screen.findByLabelText('Verification evidence').catch(() => null);
    expect(facts).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'tsk_original' }));
    expect(onOpenTask).toHaveBeenCalledWith('tsk_original');
    fireEvent.click(screen.getByRole('button', { name: 'wkr_failed' }));
    expect(onOpenWorker).toHaveBeenCalledWith('wkr_failed');
    fireEvent.click(screen.getByRole('button', { name: 'cs_1' }));
    expect(onOpenChangeSet).toHaveBeenCalledWith('cs_1');
  });

  it('opens a case as a full-screen sheet on a narrow screen', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery case rcv_case_1' }));
    const region = await screen.findByRole('region', { name: 'Recovery case rcv_case_1' });
    // The class the mobile media query turns into a fixed, full-screen pane.
    expect(region.className).toContain('v-recovery__detail--open');
  });
});

describe('recovery notifications', () => {
  it('announces a repair assignment, an exhausted budget, a recovery and no duplicates', () => {
    const seen = new Set<string>();
    // Each case is seen in an earlier state, so these are transitions.
    const before = [
      caseRecord({ status: 'open' }),
      caseRecord({ id: 'rcv_case_2', status: 'open' }),
      caseRecord({ id: 'rcv_case_3', status: 'awaiting_verification', attempts: 1 }),
      caseRecord({ id: 'rcv_case_4', status: 'repairing', attempts: 1 }),
    ];
    const after = [
      caseRecord({ status: 'repairing', attempts: 1 }),
      caseRecord({ id: 'rcv_case_2', status: 'escalated', attempts: 3 }),
      caseRecord({
        id: 'rcv_case_3',
        status: 'recovered',
        attempts: 1,
        verification: {
          runId: 'run_passed',
          status: 'passed',
          executed: true,
          executedCount: 1,
          failedOperations: [],
          evidence: [],
        },
      }),
      caseRecord({ id: 'rcv_case_4', status: 'cancelled' }),
    ];

    const first = recoveryNotificationsFor(before, after, seen);
    const events = first.map((entry) => entry.event);
    expect(events).toContain('repair_assigned');
    expect(events).toContain('recovery_needs_intervention');
    expect(events).toContain('recovery_budget_exhausted');
    expect(events).toContain('recovery_recovered');
    expect(events).toContain('recovery_cancelled');

    for (const entry of first) seen.add(entry.key);
    expect(recoveryNotificationsFor(before, after, seen)).toHaveLength(0);
  });

  it('does not announce a repair that was never verified as recovered', () => {
    const before = [caseRecord({ status: 'awaiting_verification' })];
    const after = [caseRecord({ status: 'recovered', verification: null })];
    const events = recoveryNotificationsFor(before, after, new Set()).map((entry) => entry.event);
    expect(events).not.toContain('recovery_recovered');
  });
});
