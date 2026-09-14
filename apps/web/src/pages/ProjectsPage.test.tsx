import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '../theme/ThemeProvider';
import { ToastProvider } from '../components/ui';
import { ProjectsPage } from './ProjectsPage';
import { archiveProject, listProjects, restoreProject, type ProjectView } from '../api/projects';
import { ApiError } from '../api/client';

vi.mock('../api/projects', () => ({
  listProjects: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
  formatTimestamp: (iso: string) => iso,
  PROJECT_TYPE_OPTIONS: ['web', 'mobile', 'backend', 'fullstack', 'library', 'other'],
}));

const mockedListProjects = vi.mocked(listProjects);
const mockedArchiveProject = vi.mocked(archiveProject);
const mockedRestoreProject = vi.mocked(restoreProject);

function project(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id: 'prj-1',
    name: 'Alpha',
    description: 'First project',
    status: 'active',
    projectType: 'web',
    version: '1.0.0',
    revision: 1,
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T12:00:00.000Z',
    ...overrides,
  };
}

function renderProjects() {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('ProjectsPage', () => {
  it('renders the project list from the API', async () => {
    mockedListProjects.mockResolvedValue([
      project({ id: 'prj-1', name: 'Alpha' }),
      project({ id: 'prj-2', name: 'Beta', status: 'archived' }),
    ]);
    renderProjects();
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeDefined();
    // Status is communicated with text, not color alone.
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Archived').length).toBeGreaterThan(0);
  });

  it('filters by status', async () => {
    mockedListProjects.mockResolvedValue([
      project({ id: 'prj-1', name: 'Alpha' }),
      project({ id: 'prj-2', name: 'Beta', status: 'archived' }),
    ]);
    renderProjects();

    const group = await screen.findByRole('group', { name: /filter projects by status/i });
    expect(group).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Beta' })).toBeNull();
  });

  it('shows filter-specific empty states', async () => {
    mockedListProjects.mockResolvedValue([project()]);
    renderProjects();
    await screen.findByRole('button', { name: 'Archived' });
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('No archived projects')).toBeDefined();
  });

  it('opens a project via the Open action', async () => {
    mockedListProjects.mockResolvedValue([project({ id: 'prj-9' })]);
    renderProjects();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(window.location.hash).toBe('#/projects/prj-9');
  });

  it('restores an archived project after confirmation', async () => {
    mockedListProjects.mockResolvedValue([project({ status: 'archived' })]);
    mockedRestoreProject.mockResolvedValue(project());
    renderProjects();

    fireEvent.click(await screen.findByRole('button', { name: /more actions for alpha/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore project' }));

    await waitFor(() => expect(mockedRestoreProject).toHaveBeenCalledWith('prj-1'));
  });

  it('reloads after a successful archive', async () => {
    mockedListProjects.mockResolvedValue([project()]);
    mockedArchiveProject.mockResolvedValue(project({ status: 'archived' }));
    renderProjects();

    fireEvent.click(await screen.findByRole('button', { name: /more actions for alpha/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive project' }));

    await waitFor(() => expect(mockedArchiveProject).toHaveBeenCalledWith('prj-1'));
    await waitFor(() => expect(mockedListProjects.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('does not archive when the confirmation is cancelled', async () => {
    mockedListProjects.mockResolvedValue([project()]);
    renderProjects();

    fireEvent.click(await screen.findByRole('button', { name: /more actions for alpha/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Archive project' })).toBeNull(),
    );
    expect(mockedArchiveProject).not.toHaveBeenCalled();
  });

  it('shows a server error inside the confirmation dialog without retry loops', async () => {
    mockedListProjects.mockResolvedValue([project()]);
    mockedArchiveProject.mockRejectedValueOnce(
      new ApiError(409, 'PROJECT_INVALID_TRANSITION', 'already archived'),
    );
    renderProjects();

    fireEvent.click(await screen.findByRole('button', { name: /more actions for alpha/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive project' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(mockedArchiveProject).toHaveBeenCalledTimes(1);
    // The list was not reloaded - nothing changed.
    expect(mockedListProjects).toHaveBeenCalledTimes(1);
  });

  it('shows an error state with retry when listing fails', async () => {
    mockedListProjects.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'unexpected failure'));
    renderProjects();
    expect(await screen.findByRole('alert')).toBeDefined();

    mockedListProjects.mockResolvedValueOnce([project()]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeDefined();
  });

  it('shows the no-projects empty state', async () => {
    mockedListProjects.mockResolvedValue([]);
    renderProjects();
    expect(await screen.findByText('No projects yet')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Create a project' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
  });
});
