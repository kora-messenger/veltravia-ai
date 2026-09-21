import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '../theme/ThemeProvider';
import { ToastProvider } from '../components/ui';
import { ProjectDetailPage } from './ProjectDetailPage';
import {
  getProject,
  updateProject,
  archiveProject,
  restoreProject,
  type ProjectView,
} from '../api/projects';
import { listWorkspaces, createWorkspace, type WorkspaceView } from '../api/workspaces';
import { ApiError } from '../api/client';

vi.mock('../api/projects', () => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
  formatTimestamp: (iso: string) => iso,
  PROJECT_TYPE_OPTIONS: ['web', 'mobile', 'backend', 'fullstack', 'library', 'other'],
}));

vi.mock('../api/workspaces', () => ({
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
}));

const mockedGetProject = vi.mocked(getProject);
const mockedUpdateProject = vi.mocked(updateProject);
const mockedArchiveProject = vi.mocked(archiveProject);
const mockedRestoreProject = vi.mocked(restoreProject);
const mockedListWorkspaces = vi.mocked(listWorkspaces);
const mockedCreateWorkspace = vi.mocked(createWorkspace);

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

function renderDetail(projectId: string | null = 'prj-1') {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <ProjectDetailPage projectId={projectId} />
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedGetProject.mockResolvedValue(project());
  mockedListWorkspaces.mockResolvedValue([workspace()]);
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('ProjectDetailPage', () => {
  it('renders project identity, status, and workspaces', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeDefined();
    // Project status + workspace status both read "Active" - both are exposed.
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('First project')).toBeDefined();
    expect(screen.getByText('web')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeDefined();
    expect(screen.getByText('Main')).toBeDefined();
    expect(screen.getByRole('button', { name: '← Projects' })).toBeDefined();
  });

  it('shows an honest empty state when no workspaces exist', async () => {
    mockedListWorkspaces.mockResolvedValue([]);
    renderDetail();
    expect(await screen.findByText(/no workspaces yet/i)).toBeDefined();
  });

  it('shows a not-found state for missing projects without stack traces', async () => {
    mockedGetProject.mockRejectedValueOnce(
      new ApiError(404, 'PROJECT_NOT_FOUND', 'project "prj-x" not found'),
    );
    renderDetail('prj-x');
    expect(await screen.findByText('Project not found')).toBeDefined();
    expect(screen.queryByText(/prj-x/)).toBeNull();
    expect(screen.getByRole('button', { name: /back to projects/i })).toBeDefined();
  });

  it('shows a retryable error state for other failures', async () => {
    mockedGetProject.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'boom'));
    renderDetail();
    expect(await screen.findByRole('alert')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeDefined();
  });

  it('archives through the actions menu with confirmation', async () => {
    mockedArchiveProject.mockResolvedValue(project({ status: 'archived', revision: 4 }));
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: /actions for alpha/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive project' }));

    await waitFor(() => expect(mockedArchiveProject).toHaveBeenCalledWith('prj-1'));
    await waitFor(() => expect(mockedGetProject.mock.calls.length).toBeGreaterThan(1));
  });

  it('restores archived projects and explains the archived state', async () => {
    mockedGetProject.mockResolvedValue(project({ status: 'archived' }));
    mockedRestoreProject.mockResolvedValue(project());
    renderDetail();

    expect(await screen.findByText(/restore it to create new workspaces/i)).toBeDefined();
    // Archived projects cannot create workspaces - the affordance is hidden.
    expect(screen.queryByRole('button', { name: /new workspace/i })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /actions for alpha/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore project' }));

    await waitFor(() => expect(mockedRestoreProject).toHaveBeenCalledWith('prj-1'));
  });

  it('creates a workspace after validation', async () => {
    mockedListWorkspaces.mockResolvedValue([]);
    mockedCreateWorkspace.mockResolvedValue(workspace());
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: /new workspace/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeDefined();

    // Empty name is rejected in the form.
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Give the workspace a name.')).toBeDefined();
    expect(mockedCreateWorkspace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: 'Main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() =>
      expect(mockedCreateWorkspace).toHaveBeenCalledWith('prj-1', { name: 'Main' }),
    );
    await waitFor(() => expect(mockedListWorkspaces.mock.calls.length).toBeGreaterThan(1));
  });

  describe('revision safety', () => {
    it('sends expectedRevision when saving edits', async () => {
      mockedUpdateProject.mockResolvedValue(project({ name: 'Renamed', revision: 4 }));
      renderDetail();

      fireEvent.click(await screen.findByRole('button', { name: /actions for alpha/i }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit details' }));

      const nameField = await screen.findByLabelText(/project name/i);
      await fireEvent.change(nameField, { target: { value: 'Renamed' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(mockedUpdateProject).toHaveBeenCalledWith(
          'prj-1',
          expect.objectContaining({ name: 'Renamed' }),
          3,
        ),
      );
    });

    it('does NOT silently overwrite on a stale revision - it explains and reloads', async () => {
      mockedUpdateProject.mockRejectedValueOnce(
        new ApiError(409, 'REVISION_CONFLICT', 'stale revision'),
      );
      renderDetail();

      fireEvent.click(await screen.findByRole('button', { name: /actions for alpha/i }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit details' }));

      const nameField = await screen.findByLabelText(/project name/i);
      await fireEvent.change(nameField, { target: { value: 'Renamed' } });
      const callsBefore = mockedGetProject.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      // The failed write is surfaced as a conflict message, never ignored.
      expect(await screen.findByText(/changed on the server/i)).toBeDefined();

      // A single update attempt was made; nothing was force-saved twice.
      expect(mockedUpdateProject).toHaveBeenCalledTimes(1);
      // The parent reloads the latest server state so a retry uses fresh data.
      await waitFor(() => expect(mockedGetProject.mock.calls.length).toBeGreaterThan(callsBefore));
    });
  });
});
