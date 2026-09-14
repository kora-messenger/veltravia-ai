import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '../theme/ThemeProvider';
import { ToastProvider } from '../components/ui';
import { DashboardPage } from './DashboardPage';
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

function renderDashboard() {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <DashboardPage />
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

describe('DashboardPage', () => {
  it('shows a loading state while projects load', async () => {
    mockedListProjects.mockReturnValue(new Promise(() => undefined));
    renderDashboard();
    // Spinner + its inner svg both announce as status; at least one is present.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('renders stats and recent projects from the API', async () => {
    mockedListProjects.mockResolvedValue([
      project({ id: 'prj-1', name: 'Alpha', updatedAt: '2026-09-13T12:00:00.000Z' }),
      project({ id: 'prj-2', name: 'Beta', updatedAt: '2026-09-13T11:30:00.000Z' }),
      project({
        id: 'prj-3',
        name: 'Gamma',
        status: 'archived',
        updatedAt: '2026-09-13T11:00:00.000Z',
      }),
    ]);
    renderDashboard();

    const overview = await screen.findByRole('region', { name: 'Project overview' });
    expect(within(overview).getByText('Total projects')).toBeDefined();
    expect(within(overview).getByText('3')).toBeDefined();
    expect(within(overview).getByText('Active')).toBeDefined();
    expect(within(overview).getByText('2')).toBeDefined();
    expect(within(overview).getByText('Archived')).toBeDefined();

    const recent = screen.getByRole('region', { name: 'Recently updated projects' });
    expect(recent).toBeDefined();
    // Most recently updated first (the section heading is filtered out).
    const names = within(recent)
      .getAllByRole('heading', { level: 3 })
      .map((node) => node.textContent)
      .filter((name) => name !== 'Recently updated');
    expect(names[0]).toBe('Alpha');
    expect(names[1]).toBe('Beta');
  });

  it('navigates to a project when Open is used', async () => {
    mockedListProjects.mockResolvedValue([project()]);
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(window.location.hash).toBe('#/projects/prj-1');
  });

  it('shows an empty state with a create affordance', async () => {
    mockedListProjects.mockResolvedValue([]);
    renderDashboard();
    expect(await screen.findByText('No projects yet')).toBeDefined();
    expect(
      screen.getByText('Create your first Veltravia project and start building.'),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Create a project' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
  });

  it('shows a friendly error state with retry', async () => {
    mockedListProjects.mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'unreachable'));
    renderDashboard();
    expect(await screen.findByRole('alert'));
    // The API message is surfaced as-is; no stack trace or internals.
    expect(screen.getByText('unreachable')).toBeDefined();

    mockedListProjects.mockResolvedValueOnce([project()]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Alpha')).toBeDefined();
  });

  it('archives a project through the confirmation dialog', async () => {
    mockedListProjects.mockResolvedValue([project()]);
    mockedArchiveProject.mockResolvedValue(project({ status: 'archived' }));
    renderDashboard();

    fireEvent.click(await screen.findByRole('button', { name: /more actions for alpha/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive project' }));

    await waitFor(() => expect(mockedArchiveProject).toHaveBeenCalledWith('prj-1'));
    // The list reloads after the change.
    await waitFor(() => expect(mockedListProjects.mock.calls.length).toBeGreaterThan(1));
  });

  it('offers restore for archived projects', async () => {
    mockedListProjects.mockResolvedValue([project({ status: 'archived' })]);
    mockedRestoreProject.mockResolvedValue(project());
    renderDashboard();

    fireEvent.click(await screen.findByRole('button', { name: /more actions for alpha/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore project' }));

    await waitFor(() => expect(mockedRestoreProject).toHaveBeenCalledWith('prj-1'));
  });

  it('opens the create dialog from the header action', async () => {
    mockedListProjects.mockResolvedValue([]);
    renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
  });
});
