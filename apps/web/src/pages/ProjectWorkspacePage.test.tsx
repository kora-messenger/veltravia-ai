import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '../theme/ThemeProvider';
import { ToastProvider } from '../components/ui';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';
import { getProject, type ProjectView } from '../api/projects';
import { listWorkspaces, type WorkspaceView } from '../api/workspaces';
import { ApiError } from '../api/client';
import { cancelAgentRun, createAgentRun, listAgents, type AgentRunView } from '../api/agents';

vi.mock('../api/projects', () => ({
  getProject: vi.fn(),
  formatTimestamp: (iso: string) => iso,
  PROJECT_TYPE_OPTIONS: ['web', 'mobile', 'backend', 'fullstack', 'library', 'other'],
}));

vi.mock('../api/workspaces', () => ({
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
}));

vi.mock('../api/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/agents')>();
  return {
    ...actual,
    listAgents: vi.fn(),
    createAgentRun: vi.fn(),
    getAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
  };
});

const mockedGetProject = vi.mocked(getProject);
const mockedListWorkspaces = vi.mocked(listWorkspaces);
const mockedListAgents = vi.mocked(listAgents);
const mockedCreateRun = vi.mocked(createAgentRun);
const mockedCancelRun = vi.mocked(cancelAgentRun);

function agentRun(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: 'run-1',
    agentId: 'agent.demo.answer',
    status: 'completed',
    finalOutput: 'Veltravia AI is a platform for building software with AI.',
    error: null,
    limitReason: null,
    createdAt: '2026-09-15T07:00:00.000Z',
    updatedAt: '2026-09-15T07:00:01.000Z',
    ...overrides,
  };
}

function project(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id: 'prj-1',
    name: 'Alpha',
    description: 'First project',
    status: 'active',
    projectType: 'web',
    version: '1.0.0',
    revision: 3,
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T12:00:00.000Z',
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: 'ws-1',
    projectId: 'prj-1',
    name: 'Main',
    status: 'active',
    createdAt: '2026-09-13T10:05:00.000Z',
    ...overrides,
  };
}

function renderWorkspace(projectId: string | null = 'prj-1') {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <ProjectWorkspacePage projectId={projectId} />
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.fetch = vi.fn();
  mockedGetProject.mockResolvedValue(project());
  mockedListWorkspaces.mockResolvedValue([workspace()]);
  mockedListAgents.mockResolvedValue([
    { id: 'agent.demo.answer', displayName: 'Demo Answer Agent', description: 'd' },
  ]);
  mockedCreateRun.mockResolvedValue(agentRun());
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('ProjectWorkspacePage', () => {
  it('renders the three workspace regions once the project loads', async () => {
    renderWorkspace();
    expect(await screen.findByRole('heading', { name: 'Build with Veltravia AI' })).toBeDefined();
    expect(screen.getByRole('navigation', { name: 'Project context' })).toBeDefined();
    expect(screen.getByRole('complementary', { name: 'Activity' })).toBeDefined();
    expect(screen.getByRole('form', { name: 'Message composer' })).toBeDefined();
    expect(screen.getByRole('button', { name: '← Project' })).toBeDefined();
  });

  it('shows project identity in the header and context panel', async () => {
    renderWorkspace();
    // The project name appears in the workspace header and the context panel.
    expect((await screen.findAllByText('Alpha')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('navigation', { name: 'Project context' })).toBeDefined();
    expect(screen.getAllByText('Main').length).toBeGreaterThanOrEqual(1);
  });

  it('labels the file tree as an illustration, not live files', async () => {
    renderWorkspace();
    expect(await screen.findByText(/illustration only/i)).toBeDefined();
  });

  it('shows a loading state while the project loads', () => {
    mockedGetProject.mockReturnValue(new Promise(() => undefined));
    renderWorkspace();
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('shows a not-found error state with a route back to projects', async () => {
    mockedGetProject.mockRejectedValue(new ApiError(404, 'PROJECT_NOT_FOUND', 'project not found'));
    renderWorkspace();
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('Project not found')).toBeDefined();
    expect(screen.getByRole('button', { name: /back to projects/i })).toBeDefined();
  });

  it('shows a retryable workspace-unavailable error for other failures', async () => {
    mockedGetProject.mockRejectedValue(new ApiError(500, 'INTERNAL', 'unexpected failure'));
    renderWorkspace();
    expect(await screen.findByText('Workspace unavailable')).toBeDefined();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });

  it('renders correctly under the dark theme', async () => {
    window.localStorage.setItem('veltravia.theme-preference', 'dark');
    renderWorkspace();
    expect(await screen.findByRole('heading', { name: 'Build with Veltravia AI' })).toBeDefined();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('submits the prompt to the Agent API and shows the real assistant answer', async () => {
    renderWorkspace();
    const input = await screen.findByRole('textbox', { name: 'Message Veltravia AI' });
    fireEvent.change(input, { target: { value: 'Explain this project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    // The user's own words render in the conversation…
    expect(await screen.findByText('Explain this project')).toBeDefined();
    // …and the run went through the Agent API with the routed project id.
    expect(mockedCreateRun).toHaveBeenCalledTimes(1);
    expect(mockedCreateRun).toHaveBeenCalledWith({
      agentId: 'agent.demo.answer',
      task: 'Explain this project',
      projectId: 'prj-1',
    });
    // The backend's actual answer appears, labeled as assistant output.
    expect(
      await screen.findByText('Veltravia AI is a platform for building software with AI.'),
    ).toBeDefined();
    expect(screen.getByText('Veltravia AI')).toBeDefined();
    // No run status strip remains after completion.
    expect(screen.queryByText(/working…/i)).toBeNull();
  });

  it('marks the composer read-only for archived projects', async () => {
    mockedGetProject.mockResolvedValue(project({ status: 'archived' }));
    renderWorkspace();
    const input = await screen.findByRole('textbox', { name: 'Message Veltravia AI' });
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('opens the context and activity drawers from the header', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Build with Veltravia AI' });
    fireEvent.click(screen.getByRole('button', { name: 'Project context' }));
    expect(await screen.findByRole('dialog', { name: 'Alpha context' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(await screen.findByRole('dialog', { name: 'Activity' })).toBeDefined();
  });

  it('shows an honest running state and cancels only on server confirmation', async () => {
    let resolveCancel: (value: AgentRunView) => void = () => {};
    mockedCreateRun.mockResolvedValue(agentRun({ status: 'awaiting_tool', finalOutput: null }));
    mockedCancelRun.mockImplementation(
      () =>
        new Promise<AgentRunView>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    renderWorkspace();
    const input = await screen.findByRole('textbox', { name: 'Message Veltravia AI' });
    fireEvent.change(input, { target: { value: 'Plan a refactor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText(/working…/i)).toBeDefined();
    // The composer is disabled while the run is active (one run at a time).
    expect(
      (screen.getByRole('textbox', { name: 'Message Veltravia AI' }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    const cancel = screen.getByRole('button', { name: /cancel run/i });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(mockedCancelRun).toHaveBeenCalledTimes(1);
    // Nothing is claimed before the server responds.
    expect(screen.getByText(/working…/i)).toBeDefined();
    await act(async () => {
      resolveCancel(agentRun({ status: 'cancelled', finalOutput: null }));
    });
    expect(await screen.findByText(/cancelled — this run stopped at your request/i)).toBeDefined();
    // The user's submitted message survives cancellation.
    expect(screen.getByText('Plan a refactor')).toBeDefined();
    // No assistant answer was invented for the cancelled run.
    expect(
      screen.queryByText('Veltravia AI is a platform for building software with AI.'),
    ).toBeNull();
  });

  it('renders a failed run honestly, with retry creating a NEW run', async () => {
    mockedCreateRun.mockResolvedValueOnce(
      agentRun({
        runId: 'run-1',
        status: 'failed',
        finalOutput: null,
        error: { code: 'AGENT_MODEL_ERROR', message: 'The model could not be reached.' },
      }),
    );
    mockedCreateRun.mockResolvedValueOnce(agentRun({ runId: 'run-2' }));
    renderWorkspace();
    const input = await screen.findByRole('textbox', { name: 'Message Veltravia AI' });
    fireEvent.change(input, { target: { value: 'Summarize the architecture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    // The failure is reported both as a conversation note and in the status
    // strip - it must never be shown as an assistant answer.
    expect(screen.getAllByText(/the model could not be reached/i).length).toBeGreaterThanOrEqual(1);
    // No assistant answer appears for a failed run.
    expect(
      screen.queryByText('Veltravia AI is a platform for building software with AI.'),
    ).toBeNull();
    // The user's message stays; retry restarts the SAME prompt as a new run.
    expect(screen.getByText('Summarize the architecture')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/working…|veltravia ai is a platform/i)).toBeDefined();
    expect(mockedCreateRun).toHaveBeenCalledTimes(2);
    expect(mockedCreateRun).toHaveBeenLastCalledWith({
      agentId: 'agent.demo.answer',
      task: 'Summarize the architecture',
      projectId: 'prj-1',
    });
  });

  it('shows an honest error when the run cannot be created (no fake answer)', async () => {
    mockedCreateRun.mockRejectedValue(new ApiError(0, 'NETWORK', 'Cannot reach the service.'));
    renderWorkspace();
    const input = await screen.findByRole('textbox', { name: 'Message Veltravia AI' });
    fireEvent.change(input, { target: { value: 'Anything' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/was not answered/i)).toBeDefined();
    expect(
      screen.queryByText('Veltravia AI is a platform for building software with AI.'),
    ).toBeNull();
  });

  it('keeps the composer read-only when no agent is available', async () => {
    mockedListAgents.mockResolvedValue([]);
    renderWorkspace();
    const input = await screen.findByRole('textbox', { name: 'Message Veltravia AI' });
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(mockedCreateRun).not.toHaveBeenCalled();
  });

  it('contains no credential-shaped values anywhere in the rendered surface', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Build with Veltravia AI' });
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(html).not.toMatch(/ghp_[A-Za-z0-9]+/);
    expect(html).not.toMatch(/api[_-]?key\s*=/i);
  });
});
