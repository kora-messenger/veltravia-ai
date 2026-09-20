// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { PreviewPanel } from './PreviewPanel';
import {
  createRuntime,
  fetchRuntimeLogs,
  listRuntimes,
  restartRuntime,
  startRuntime,
  stopRuntime,
  type RuntimeView,
} from '../../api/runtimes';
import { ApiError } from '../../api/client';
import type { WorkspaceView } from '../../api/workspaces';

vi.mock('../../api/runtimes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/runtimes')>();
  return {
    ...actual,
    listRuntimes: vi.fn(),
    createRuntime: vi.fn(),
    startRuntime: vi.fn(),
    stopRuntime: vi.fn(),
    restartRuntime: vi.fn(),
    fetchRuntimeLogs: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const mockedList = vi.mocked(listRuntimes);
const mockedCreate = vi.mocked(createRuntime);
const mockedStart = vi.mocked(startRuntime);
const mockedStop = vi.mocked(stopRuntime);
const mockedRestart = vi.mocked(restartRuntime);
const mockedLogs = vi.mocked(fetchRuntimeLogs);

function workspace(id: string, name = 'Main'): WorkspaceView {
  return {
    id,
    name,
    status: 'active',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
  } as WorkspaceView;
}

function runtimeView(overrides: Partial<RuntimeView> = {}): RuntimeView {
  return {
    runtimeId: 'rt_1',
    workspaceId: 'ws-1',
    status: 'running',
    runtimeType: 'web',
    isolationLevel: 'simulated',
    executorId: 'mock-runtime',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T02:00:00Z',
    previewUrl: '/preview/rt_1',
    lastHealth: 'healthy',
    failure: null,
    revision: 1,
    currentRevision: 1,
    stale: false,
    plan: {
      runtimeType: 'web',
      revision: 1,
      buildLabel: 'npm run build',
      startLabel: 'npm run preview',
      port: 4173,
      evidence: [],
    },
    ...overrides,
  };
}

function renderPanel(workspaces: WorkspaceView[] = [workspace('ws-1')]) {
  return render(
    <ToastProvider>
      <PreviewPanel projectId="prj-1" workspaces={workspaces} />
    </ToastProvider>,
  );
}

describe('PreviewPanel - no runtime yet', () => {
  it('offers to create a preview and calls the API with only workspace + project ids', async () => {
    mockedList.mockResolvedValue([]);
    mockedCreate.mockResolvedValue(runtimeView({ status: 'created', previewUrl: null }));
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Create preview' });
    fireEvent.click(button);
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith('prj-1', { workspaceId: 'ws-1' }),
    );
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it('shows an honest error when creation is rejected (no previewable plan)', async () => {
    mockedList.mockResolvedValue([]);
    mockedCreate.mockRejectedValue(
      new ApiError(422, 'RUNTIME_PLAN_REJECTED', 'no previewable app found'),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Create preview' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no previewable app found');
  });
});

describe('PreviewPanel - runtime lifecycle', () => {
  it('starts a created runtime and shows the simulated preview frame', async () => {
    mockedList
      .mockResolvedValueOnce([
        runtimeView({ status: 'created', previewUrl: null, lastHealth: null }),
      ])
      .mockResolvedValue([runtimeView()]);
    mockedStart.mockResolvedValue(runtimeView());
    renderPanel();

    const start = await screen.findByRole('button', { name: 'Start' });
    fireEvent.click(start);
    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith('prj-1', 'rt_1'));
    await screen.findByTitle('Preview of ws-1');
  });

  it('labels the preview as simulated and shows the plan honestly', async () => {
    mockedList.mockResolvedValue([runtimeView()]);
    renderPanel();
    expect(await screen.findByText(/simulated executor/)).toBeTruthy();
    expect(screen.getByText(/npm run preview/)).toBeTruthy();
  });

  it('stops a running runtime', async () => {
    mockedList.mockResolvedValue([runtimeView()]);
    mockedStop.mockResolvedValue(runtimeView({ status: 'stopped', previewUrl: null }));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(mockedStop).toHaveBeenCalledWith('prj-1', 'rt_1'));
  });

  it('offers restart-at-latest-files and shows a stale badge', async () => {
    mockedList.mockResolvedValue([
      runtimeView({ status: 'stopped', previewUrl: null, stale: true, currentRevision: 2 }),
    ]);
    mockedRestart.mockResolvedValue({
      next: runtimeView({ revision: 2, currentRevision: 2 }),
      previous: runtimeView({ status: 'stopped' }),
    });
    renderPanel();

    expect(await screen.findByText(/Stale/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart at latest files' }));
    await waitFor(() => expect(mockedRestart).toHaveBeenCalledWith('prj-1', 'rt_1'));
  });

  it('renders a structured failure report honestly', async () => {
    mockedList.mockResolvedValue([
      runtimeView({
        status: 'failed',
        previewUrl: null,
        lastHealth: null,
        failure: { kind: 'build_failed', phase: 'build', message: 'the build command failed' },
      }),
    ]);
    renderPanel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('build');
    expect(alert.textContent).toContain('the build command failed');
    expect(alert.textContent).toContain('build_failed');
  });
});

describe('PreviewPanel - logs', () => {
  it('shows bounded, display-only runtime logs', async () => {
    mockedList.mockResolvedValue([runtimeView()]);
    mockedLogs.mockResolvedValue({
      entries: [
        { timestamp: 't1', level: 'info', phase: 'build', message: 'vite build ok' },
        { timestamp: 't2', level: 'warning', phase: 'start', message: 'port 4173 busy, retrying' },
      ],
      truncated: false,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'View logs' }));
    const log = await screen.findByRole('log');
    expect(log.textContent).toContain('vite build ok');
    expect(log.textContent).toContain('port 4173 busy, retrying');
    expect(mockedLogs).toHaveBeenCalledWith('prj-1', 'rt_1');
  });

  it('hides logs on the second click', async () => {
    mockedList.mockResolvedValue([runtimeView()]);
    mockedLogs.mockResolvedValue({ entries: [], truncated: false });
    renderPanel();

    const toggle = await screen.findByRole('button', { name: 'View logs' });
    fireEvent.click(toggle);
    await waitFor(() => expect(mockedLogs).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Hide logs' }));
    expect(screen.queryByRole('log')).toBeNull();
  });
});

describe('PreviewPanel - boundaries', () => {
  it('renders an honest load error with a retry', async () => {
    mockedList.mockRejectedValue(new ApiError(500, 'INTERNAL', 'unexpected failure'));
    renderPanel();
    expect(await screen.findByText('unexpected failure')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it('shows the empty state when no workspaces are active', async () => {
    mockedList.mockResolvedValue([]);
    render(
      <ToastProvider>
        <PreviewPanel
          projectId="prj-1"
          workspaces={[{ ...workspace('ws-1'), status: 'archived' }]}
        />
      </ToastProvider>,
    );
    expect(await screen.findByText(/Create an active workspace to preview/)).toBeTruthy();
  });

  it('never renders command, port, or environment configuration UI', async () => {
    mockedList.mockResolvedValue([runtimeView()]);
    const { container } = renderPanel();
    await screen.findByTitle('Preview of ws-1');
    expect(container.textContent).not.toContain('environment');
    expect(container.querySelectorAll('input[type="text"]').length).toBe(0);
  });

  it('scopes the workspace picker to active workspaces', async () => {
    mockedList.mockResolvedValue([]);
    renderPanel([
      workspace('ws-1', 'Main'),
      { ...workspace('ws-2', 'Archive'), status: 'archived' },
    ]);
    const combobox = await screen.findByRole('combobox');
    const options = Array.from(combobox.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Main']);
  });
});
