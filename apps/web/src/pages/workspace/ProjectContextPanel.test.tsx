import { afterEach, describe, expect, it } from 'vitest';

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectContextPanel } from './ProjectContextPanel';
import type { ProjectView } from '../../api/projects';
import type { WorkspaceView } from '../../api/workspaces';

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
  it('shows project identity, status, and workspace identity', () => {
    render(<ProjectContextPanel project={project()} workspaces={[workspace()]} />);
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Main').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Project' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Files' })).toBeDefined();
  });

  it('clearly marks the file tree as an illustration, not live files', () => {
    render(<ProjectContextPanel project={project()} workspaces={[workspace()]} />);
    expect(screen.getByText(/illustration only/i)).toBeDefined();
  });

  it('explains when the project has no workspace yet', () => {
    render(<ProjectContextPanel project={project()} workspaces={[]} />);
    expect(screen.getByText(/no workspace yet/i)).toBeDefined();
  });
});
