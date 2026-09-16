import { afterEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ProjectContextPanel } from './ProjectContextPanel';
import { getWorkspaceTree } from '../../api/workspaces';
import type { ProjectView } from '../../api/projects';
import type { WorkspaceView } from '../../api/workspaces';

vi.mock('../../api/workspaces', () => ({
  getWorkspaceTree: vi.fn(),
}));

afterEach(() => cleanup());

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

describe('ProjectContextPanel', () => {
  it('shows project identity, status, and workspace identity', async () => {
    vi.mocked(getWorkspaceTree).mockResolvedValue([]);
    render(
      <ProjectContextPanel
        project={project()}
        workspaces={[workspace()]}
        selectedWorkspaceId="ws-1"
        onSelectWorkspace={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/No files yet/i)).toBeDefined());
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Main').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Project' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Files' })).toBeDefined();
  });

  it('renders the real file tree from the workspace API', async () => {
    vi.mocked(getWorkspaceTree).mockResolvedValue([
      { path: 'README.md', name: 'README.md', type: 'file' },
      { path: 'src', name: 'src', type: 'directory' },
      { path: 'src/index.ts', name: 'index.ts', type: 'file' },
    ]);
    render(
      <ProjectContextPanel
        project={project()}
        workspaces={[workspace()]}
        selectedWorkspaceId="ws-1"
        onSelectWorkspace={() => {}}
      />,
    );
    expect(await screen.findByText('README.md')).toBeDefined();
    expect(screen.getByText('src/')).toBeDefined();
    expect(screen.getByText('index.ts')).toBeDefined();
  });

  it('shows an honest tree error state with retry', async () => {
    vi.mocked(getWorkspaceTree).mockRejectedValue(new Error('offline'));
    render(
      <ProjectContextPanel
        project={project()}
        workspaces={[workspace()]}
        selectedWorkspaceId="ws-1"
        onSelectWorkspace={() => {}}
      />,
    );
    expect(await screen.findByText(/Files unavailable/i)).toBeDefined();
  });

  it('offers a workspace picker when the project has several workspaces', () => {
    vi.mocked(getWorkspaceTree).mockResolvedValue([]);
    render(
      <ProjectContextPanel
        project={project()}
        workspaces={[workspace(), workspace({ id: 'ws-2', name: 'Second' })]}
        selectedWorkspaceId="ws-1"
        onSelectWorkspace={() => {}}
      />,
    );
    expect(screen.getByRole('combobox', { name: /workspace/i })).toBeDefined();
  });

  it('explains when the project has no workspace yet', () => {
    render(<ProjectContextPanel project={project()} workspaces={[]} />);
    expect(screen.getByText(/no workspace yet/i)).toBeDefined();
  });
});
