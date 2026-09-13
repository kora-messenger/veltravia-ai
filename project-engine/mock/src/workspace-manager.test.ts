import { describe, expect, it } from 'vitest';
import { buildTestEngine } from './project-manager.test.js';

const VALID_INPUT = {
  name: 'MarketScope Mobile',
  description: 'AI trading companion app',
  projectType: 'mobile' as const,
  ownerRef: 'user-1',
};

describe('WorkspaceManager', () => {
  it('creates a workspace under a valid active project', async () => {
    const engine = buildTestEngine();
    const project = await engine.projects.createProject(VALID_INPUT);
    const workspace = await engine.workspaces.createWorkspace(project.id, { name: 'main' });
    expect(workspace.id).toBe('ws-1');
    expect(workspace.projectId).toBe(project.id);
    expect(workspace.status).toBe('active');
    expect(workspace.root).toBe(`workspace://ws-1/`); // logical root, never a host path
  });

  it('retrieves and lists workspaces of a project', async () => {
    const engine = buildTestEngine();
    const project = await engine.projects.createProject(VALID_INPUT);
    await engine.workspaces.createWorkspace(project.id, { name: 'main' });
    await engine.workspaces.createWorkspace(project.id, { name: 'experiments' });
    const workspaces = await engine.workspaces.listWorkspaces(project.id);
    expect(workspaces).toHaveLength(2);
    const found = await engine.workspaces.getWorkspace('ws-1');
    expect(found.name).toBe('main');
  });

  it('rejects unknown project ids', async () => {
    const engine = buildTestEngine();
    await expect(engine.workspaces.createWorkspace('prj-404', { name: 'main' })).rejects.toThrow(
      /No project found/,
    );
  });

  it('rejects workspaces for archived and deleted projects', async () => {
    const engine = buildTestEngine();
    const project = await engine.projects.createProject(VALID_INPUT);
    await engine.projects.archiveProject(project.id);
    await expect(engine.workspaces.createWorkspace(project.id, { name: 'x' })).rejects.toThrow(
      /archived/,
    );
    await engine.projects.restoreProject(project.id);
    await engine.projects.deleteProject(project.id);
    await expect(engine.workspaces.createWorkspace(project.id, { name: 'x' })).rejects.toThrow(
      /deleted/,
    );
  });

  it('updates a workspace with revision checks', async () => {
    const engine = buildTestEngine();
    const project = await engine.projects.createProject(VALID_INPUT);
    const workspace = await engine.workspaces.createWorkspace(project.id, { name: 'main' });
    const updated = await engine.workspaces.updateWorkspace(
      workspace.id,
      { name: 'primary' },
      workspace.revision,
    );
    expect(updated.name).toBe('primary');
    expect(updated.revision).toBe(2);
  });

  it('locks, unlocks, archives, and restores workspaces', async () => {
    const engine = buildTestEngine();
    const project = await engine.projects.createProject(VALID_INPUT);
    const workspace = await engine.workspaces.createWorkspace(project.id, { name: 'main' });
    expect((await engine.workspaces.lockWorkspace(workspace.id)).status).toBe('locked');
    expect((await engine.workspaces.unlockWorkspace(workspace.id)).status).toBe('active');
    expect((await engine.workspaces.archiveWorkspace(workspace.id)).status).toBe('archived');
    expect((await engine.workspaces.restoreWorkspace(workspace.id)).status).toBe('active');
  });

  it('rejects updates against archived workspaces and invalid states', async () => {
    const engine = buildTestEngine();
    const project = await engine.projects.createProject(VALID_INPUT);
    const workspace = await engine.workspaces.createWorkspace(project.id, { name: 'main' });
    await engine.workspaces.archiveWorkspace(workspace.id);
    await expect(engine.workspaces.updateWorkspace(workspace.id, { name: 'x' }, 1)).rejects.toThrow(
      /archived/,
    );
    // archived -> locked is not a legal transition
    await expect(engine.workspaces.lockWorkspace(workspace.id)).rejects.toThrow(
      /Invalid project transition/,
    );
  });

  it('rejects unknown workspace ids and invalid names', async () => {
    const engine = buildTestEngine();
    const project = await engine.projects.createProject(VALID_INPUT);
    await expect(engine.workspaces.getWorkspace('ws-404')).rejects.toThrow(/No workspace found/);
    await expect(engine.workspaces.createWorkspace(project.id, { name: '   ' })).rejects.toThrow(
      /workspace name/,
    );
  });
});
