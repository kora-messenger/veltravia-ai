// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type {
  AppTestReport,
  Bug,
  RunStatus,
  StartedRun,
  TestRunState,
} from '../../api/app-testing';
import * as testingApi from '../../api/app-testing';
import * as projectsApi from '../../api/projects';
import * as workspacesApi from '../../api/workspaces';
import { ApiError } from '../../api/client';
import { TestingPage } from './TestingPage';

vi.mock('../../api/app-testing', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/app-testing')>('../../api/app-testing');
  return {
    ...actual,
    startRun: vi.fn(),
    fetchStatus: vi.fn(),
    fetchReport: vi.fn(),
    fetchRepairPlan: vi.fn(),
    cancelRun: vi.fn(),
    decide: vi.fn(),
  };
});
vi.mock('../../api/projects', () => ({ getProject: vi.fn(), listProjects: vi.fn() }));
vi.mock('../../api/workspaces', () => ({ listWorkspaces: vi.fn(), createWorkspace: vi.fn() }));

const api = vi.mocked(testingApi);
const projects = vi.mocked(projectsApi);
const workspaces = vi.mocked(workspacesApi);

const PROJECT: projectsApi.ProjectView = {
  id: 'prj-1',
  name: 'Notes API',
  description: '',
  status: 'active',
  projectType: 'other',
  version: '1',
  revision: 1,
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};
const WORKSPACE: workspacesApi.WorkspaceView = {
  id: 'ws-1',
  projectId: 'prj-1',
  name: 'main',
  status: 'active',
  createdAt: '2026-11-05T09:00:00.000Z',
  revision: 1,
};

const STARTED: StartedRun = {
  runId: 'run-1',
  state: 'awaiting_approval',
  projectId: 'prj-1',
  workspaceId: 'ws-1',
  inspection: {
    fileCount: 4,
    truncated: false,
    frontend: 'react',
    backend: 'fastify',
    testRunner: 'vitest',
    databases: ['postgres'],
    entryPoints: ['src/server.ts'],
    apiRoutes: [
      { method: 'GET', path: '/health', file: 'src/server.ts', guarded: false },
      { method: 'POST', path: '/items', file: 'src/server.ts', guarded: true },
    ],
    pageRoutes: [],
    existingTests: [],
    dependencies: ['fastify', 'react'],
    hasAuth: true,
    hasForms: false,
    notes: [],
  },
  proposedTests: [
    {
      id: 'tc-api-1',
      kind: 'api',
      title: 'GET /health responds without a server error',
      target: 'GET /health',
      path: 'generated-tests/api/get-health.test.ts',
      runner: 'vitest',
    },
  ],
  skippedKinds: [{ kind: 'component', reason: 'Needs a browser or component runtime.' }],
  notes: [],
};

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
    statusReason: 'The test plan is waiting for a person to approve it, so nothing has run yet.',
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

const BUG: Bug = {
  id: 'bug-1',
  category: 'functional',
  severity: 'high',
  certainty: 'confirmed',
  title: 'Test failed: math > subtracts',
  summary: 'The assertion appears to compare 1 with 2.',
  affectedFiles: ['src/math.ts'],
  evidence: 'expected 1 to be 2',
  recommendation: 'Check what subtract returns.',
  source: 't-2',
};
const SUSPECTED: Bug = {
  ...BUG,
  id: 'bug-s1',
  certainty: 'suspected',
  severity: 'medium',
  category: 'security',
  title: 'Possible dynamic code execution',
  summary: 'Static analysis flagged this. No test failed.',
  recommendation: 'Remove eval.',
};

function renderPage(projectId: string | null = 'prj-1') {
  return render(<TestingPage projectId={projectId} />);
}

beforeEach(() => {
  projects.getProject.mockResolvedValue(PROJECT);
  workspaces.listWorkspaces.mockResolvedValue([WORKSPACE]);
  api.startRun.mockResolvedValue(STARTED);
  api.fetchStatus.mockResolvedValue(status('awaiting_approval', { kind: 'plan_approval' }));
  api.fetchReport.mockResolvedValue(report());
  api.fetchRepairPlan.mockResolvedValue({
    runId: 'run-1',
    state: 'completed',
    awaitingApproval: false,
    diagnosis: null,
    repairPlan: null,
    approvalRoute: '/api/testing/runs/run-1/approval',
  });
  api.cancelRun.mockResolvedValue({ runId: 'run-1', state: 'cancelled' });
  api.decide.mockResolvedValue(status('running'));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function started() {
  renderPage();
  fireEvent.click(
    await screen
      .findByTestId('testing-start')
      .catch(() => screen.getAllByText('Start testing')[0]!),
  );
  await screen.findByTestId('testing-found');
}

describe('opening the page', () => {
  it('shows the project and offers to start before any run exists', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Notes API' })).toBeTruthy();
    expect(screen.getAllByText('Start testing').length).toBeGreaterThan(0);
    expect(screen.getByText(/Nothing runs until you approve the plan/)).toBeTruthy();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it('starts nothing by itself', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Notes API' });
    expect(api.startRun).not.toHaveBeenCalled();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('says so when the project cannot be opened', async () => {
    projects.getProject.mockRejectedValue(new ApiError('That project was not found.', 404, null));
    renderPage();
    expect(await screen.findByText('Could not open this project')).toBeTruthy();
  });

  it('says so when there is no project at all', async () => {
    renderPage(null);
    expect(await screen.findByText('Could not open this project')).toBeTruthy();
  });

  it('explains when the project has no workspace to test', async () => {
    workspaces.listWorkspaces.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No workspace yet')).toBeTruthy();
    expect(screen.queryByText('Start testing')).toBeNull();
  });

  it('shows a loading state first', () => {
    projects.getProject.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText(/Loading project/)).toBeTruthy();
  });
});

describe('starting a run', () => {
  it('starts with this project and workspace', async () => {
    await started();
    expect(api.startRun).toHaveBeenCalledWith({ projectId: 'prj-1', workspaceId: 'ws-1' });
  });

  it('shows what was found in the application', async () => {
    await started();
    const found = within(screen.getByTestId('testing-found'));
    expect(found.getByText('react')).toBeTruthy();
    expect(found.getByText('fastify')).toBeTruthy();
    expect(found.getByText('vitest')).toBeTruthy();
    expect(found.getByText('postgres')).toBeTruthy();
  });

  it('lists proposed tests as proposals and says nothing is written yet', async () => {
    await started();
    expect(screen.getByText(/GET \/health responds without a server error/)).toBeTruthy();
    expect(
      screen.getByText(/Nothing is written to your project until you approve it/),
    ).toBeTruthy();
  });

  it('lists the kinds it could not generate, with the reason', async () => {
    await started();
    fireEvent.click(screen.getByText(/Not generated \(1\)/));
    expect(screen.getByText(/Needs a browser or component runtime/)).toBeTruthy();
  });

  it('shows why starting failed, and no run', async () => {
    api.startRun.mockRejectedValue(
      new ApiError('That project or testing run was not found.', 404, null),
    );
    renderPage();
    fireEvent.click((await screen.findAllByText('Start testing'))[0]!);
    expect(await screen.findByTestId('testing-error')).toBeTruthy();
    expect(screen.queryByTestId('testing-found')).toBeNull();
  });
});

describe('approval controls', () => {
  it('asks for the plan to be approved, and runs nothing before that', async () => {
    await started();
    const card = within(await screen.findByTestId('testing-approval'));
    expect(card.getByText('Approve the test plan')).toBeTruthy();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('sends Approve as an approval', async () => {
    await started();
    const card = within(await screen.findByTestId('testing-approval'));
    fireEvent.click(card.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('run-1', 'approve'));
  });

  it('sends Reject as a rejection', async () => {
    await started();
    const card = within(await screen.findByTestId('testing-approval'));
    fireEvent.click(card.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('run-1', 'reject'));
  });

  it('explains a repair approval and that tests run again afterwards', async () => {
    api.fetchStatus.mockResolvedValue(
      status('awaiting_repair_approval', { kind: 'repair_approval' }),
    );
    await started();
    const card = within(await screen.findByTestId('testing-approval'));
    expect(card.getByText('Approve a proposed repair')).toBeTruthy();
    expect(card.getByText(/tests run again/)).toBeTruthy();
  });

  it('shows no approval controls when nothing is waiting', async () => {
    api.fetchStatus.mockResolvedValue(status('completed'));
    await started();
    await screen.findByTestId('testing-state');
    expect(screen.queryByTestId('testing-approval')).toBeNull();
  });

  it('shows why a decision failed', async () => {
    api.decide.mockRejectedValue(new ApiError('That run already finished.', 409, null));
    await started();
    const card = within(await screen.findByTestId('testing-approval'));
    fireEvent.click(card.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByTestId('testing-error')).toBeTruthy();
  });
});

describe('the result', () => {
  const finished = report({
    status: 'FAILED',
    statusReason: '1 test failed.',
    executed: 2,
    passed: 1,
    failed: 1,
    tests: [
      {
        id: 't-1',
        kind: 'unit',
        title: 'math > adds',
        outcome: 'passed',
        skipReason: null,
        error: null,
        durationMs: 3,
      },
      {
        id: 't-2',
        kind: 'unit',
        title: 'math > subtracts',
        outcome: 'failed',
        skipReason: null,
        error: 'AssertionError: expected 1 to be 2',
        durationMs: 2,
      },
    ],
    bugs: [BUG],
  });

  beforeEach(() => {
    api.fetchStatus.mockResolvedValue(status('completed'));
    api.fetchReport.mockResolvedValue(finished);
  });

  it('shows the status, the reason and the counts', async () => {
    await started();
    expect((await screen.findByTestId('testing-status')).textContent).toBe('Failed');
    expect(screen.getByTestId('testing-headline').textContent).toBe('1 test failed.');
    expect(screen.getByTestId('count-passed').textContent).toBe('1');
    expect(screen.getByTestId('count-failed').textContent).toBe('1');
    expect(screen.getByTestId('count-skipped').textContent).toBe('0');
  });

  it('marks each test passed or failed', async () => {
    await started();
    const list = within(await screen.findByTestId('testing-test-list'));
    expect(list.getByText('math > adds')).toBeTruthy();
    expect(list.getByText('math > subtracts')).toBeTruthy();
    expect(list.getAllByText('Passed').length).toBe(1);
    expect(list.getAllByText('Failed').length).toBe(1);
  });

  it('reveals the error details only when a test is opened', async () => {
    await started();
    await screen.findByTestId('testing-test-list');
    expect(screen.queryByLabelText('Error details')).toBeNull();
    fireEvent.click(screen.getByText('math > subtracts'));
    expect(screen.getByLabelText('Error details').textContent).toContain('expected 1 to be 2');
  });

  it('shows the problem with severity, files and a suggested fix', async () => {
    await started();
    const bugs = within(await screen.findByTestId('testing-bug-list'));
    expect(bugs.getByText('Test failed: math > subtracts')).toBeTruthy();
    expect(bugs.getByText('high')).toBeTruthy();
    expect(bugs.getByText('Confirmed by a failing test')).toBeTruthy();
    expect(bugs.getByText(/src\/math\.ts/)).toBeTruthy();
    expect(bugs.getByText(/Check what subtract returns/)).toBeTruthy();
  });

  it('tells a suspected problem from a confirmed one', async () => {
    api.fetchReport.mockResolvedValue({ ...finished, bugs: [BUG, SUSPECTED] });
    await started();
    const bugs = within(await screen.findByTestId('testing-bug-list'));
    expect(bugs.getByText('Confirmed by a failing test')).toBeTruthy();
    expect(bugs.getByText('Suspected, not confirmed')).toBeTruthy();
  });

  it('puts the most serious problem first', async () => {
    api.fetchReport.mockResolvedValue({
      ...finished,
      bugs: [{ ...SUSPECTED, id: 'bug-low', severity: 'low', title: 'A small thing' }, BUG],
    });
    await started();
    const items = (await screen.findByTestId('testing-bug-list')).querySelectorAll('li');
    expect(items[0]?.textContent).toContain('Test failed: math > subtracts');
  });

  it('offers Rerun, and no Start, once the run has finished', async () => {
    await started();
    expect(await screen.findByTestId('testing-rerun')).toBeTruthy();
    expect(screen.queryByTestId('testing-start')).toBeNull();
    expect(screen.queryByTestId('testing-cancel')).toBeNull();
  });

  it('starts a fresh run when Rerun is pressed', async () => {
    await started();
    fireEvent.click(await screen.findByTestId('testing-rerun'));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(2));
  });
});

describe('never claiming more than was proved', () => {
  it('does not say a passing run on a simulated runtime was fully tested', async () => {
    api.fetchStatus.mockResolvedValue(status('completed'));
    api.fetchReport.mockResolvedValue(
      report({
        status: 'PARTIALLY_PASSED',
        statusReason:
          'No test failed, but the commands ran on the "mock" runtime, which executes no real code.',
        executed: 1,
        passed: 1,
        tests: [
          {
            id: 't-1',
            kind: 'unit',
            title: 'node --version',
            outcome: 'passed',
            skipReason: null,
            error: null,
            durationMs: 1,
          },
        ],
      }),
    );
    await started();
    expect((await screen.findByTestId('testing-status')).textContent).toBe('Partially passed');
    expect(screen.getByTestId('testing-headline').textContent).toContain('executes no real code');
    expect(screen.getByTestId('testing-headline').textContent).not.toMatch(/all .* passed/i);
    expect(screen.getByTestId('testing-environment').textContent).toContain(
      'does not execute real code',
    );
    expect(screen.getByTestId('testing-not-full').textContent).toContain('not a complete test');
  });

  it('says a blocked run did not test anything', async () => {
    await started();
    expect((await screen.findByTestId('testing-status')).textContent).toBe('Blocked');
    expect(screen.getByTestId('testing-headline').textContent).toContain('nothing has run yet');
    expect(screen.getByTestId('testing-not-full')).toBeTruthy();
  });

  it('shows the real tests as none yet, rather than an empty pass', async () => {
    await started();
    expect(await screen.findByTestId('testing-no-tests')).toBeTruthy();
  });

  it('says no problems were found only for what was checked', async () => {
    api.fetchStatus.mockResolvedValue(status('completed'));
    await started();
    expect((await screen.findByTestId('testing-no-bugs')).textContent).toContain(
      'only covers what was checked',
    );
  });

  it('says a cancelled run was cancelled, and adds no incompleteness warning to it', async () => {
    api.fetchStatus.mockResolvedValue(status('cancelled'));
    api.fetchReport.mockResolvedValue(
      report({ status: 'CANCELLED', statusReason: 'The run was cancelled before it finished.' }),
    );
    await started();
    expect((await screen.findByTestId('testing-status')).textContent).toBe('Cancelled');
    expect(screen.queryByTestId('testing-not-full')).toBeNull();
  });
});

describe('cancelling', () => {
  it('offers Cancel while a run is waiting, and sends it', async () => {
    await started();
    fireEvent.click(await screen.findByTestId('testing-cancel'));
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith('run-1'));
  });

  it('offers Cancel while a run is working', async () => {
    api.fetchStatus.mockResolvedValue(status('running'));
    await started();
    expect(await screen.findByTestId('testing-cancel')).toBeTruthy();
  });
});

describe('small screens', () => {
  it('offers the three sections as tabs and switches between them', async () => {
    await started();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Found', 'Results', 'Problems']);
    expect(screen.getByRole('tab', { name: 'Results' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Problems' }));
    expect(screen.getByRole('tab', { name: 'Problems' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByTestId('testing-page').className).toContain('v-testing--panel-problems');
  });
});
