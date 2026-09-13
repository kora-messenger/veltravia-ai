import { describe, expect, it } from 'vitest';
import { createProjectEngine, createSequentialIdGenerator } from './index.js';

const NOW = () => new Date('2026-09-13T15:30:00.000Z');

export function buildTestEngine() {
  return createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
}

const VALID_INPUT = {
  name: 'MarketScope Mobile',
  description: 'AI trading companion app',
  projectType: 'mobile' as const,
  ownerRef: 'user-1',
};

describe('ProjectManager', () => {
  it('creates a project in the active state with revision 1', async () => {
    const engine = buildTestEngine();
    const project = await engine.projects.createProject(VALID_INPUT);
    expect(project.id).toBe('prj-1');
    expect(project.status).toBe('active');
    expect(project.revision).toBe(1);
    expect(project.version).toBe('0.1.0');
    expect(project.workspaceId).toBeNull();
  });

  it('retrieves the project', async () => {
    const engine = buildTestEngine();
    const created = await engine.projects.createProject(VALID_INPUT);
    const found = await engine.projects.getProject(created.id);
    expect(found.id).toBe(created.id);
  });

  it('lists projects and excludes soft-deleted ones by default', async () => {
    const engine = buildTestEngine();
    const first = await engine.projects.createProject(VALID_INPUT);
    const second = await engine.projects.createProject({ ...VALID_INPUT, name: 'Kora Web' });
    await engine.projects.deleteProject(second.id);
    const visible = await engine.projects.listProjects();
    expect(visible.map((p) => p.id)).toEqual([first.id]);
    const all = await engine.projects.listProjects({ includeDeleted: true });
    expect(all).toHaveLength(2);
  });

  it('updates with the correct revision and bumps it', async () => {
    const engine = buildTestEngine();
    const created = await engine.projects.createProject(VALID_INPUT);
    const updated = await engine.projects.updateProject(
      created.id,
      { description: 'AI trading companion app v2' },
      created.revision,
    );
    expect(updated.revision).toBe(2);
    expect(updated.description).toBe('AI trading companion app v2');
  });

  it('archives and restores a project', async () => {
    const engine = buildTestEngine();
    const created = await engine.projects.createProject(VALID_INPUT);
    const archived = await engine.projects.archiveProject(created.id);
    expect(archived.status).toBe('archived');
    const restored = await engine.projects.restoreProject(created.id);
    expect(restored.status).toBe('active');
  });

  it('soft-deletes and rejects deleted -> active (terminal)', async () => {
    const engine = buildTestEngine();
    const created = await engine.projects.createProject(VALID_INPUT);
    const deleted = await engine.projects.deleteProject(created.id);
    expect(deleted.status).toBe('deleted');
    // The row still exists (soft delete)...
    const found = await engine.projects.getProject(created.id);
    expect(found.status).toBe('deleted');
    // ...but every mutation is rejected.
    await expect(engine.projects.restoreProject(created.id)).rejects.toThrow(/deleted/);
    await expect(
      engine.projects.updateProject(created.id, { name: 'X' }, found.revision),
    ).rejects.toThrow(/deleted/);
    await expect(engine.projects.archiveProject(created.id)).rejects.toThrow(
      /Invalid project transition/,
    );
    await expect(engine.projects.deleteProject(created.id)).rejects.toThrow(/deleted/);
  });

  it('rejects invalid input', async () => {
    const engine = buildTestEngine();
    await expect(engine.projects.createProject({ ...VALID_INPUT, name: '' })).rejects.toThrow(
      /name must be a non-empty string/,
    );
    await expect(
      engine.projects.createProject({ ...VALID_INPUT, projectType: 'quantum' as never }),
    ).rejects.toThrow(/projectType/);
    await expect(engine.projects.createProject({ ...VALID_INPUT, ownerRef: '' })).rejects.toThrow(
      /ownerRef/,
    );
  });

  it('rejects unknown project ids', async () => {
    const engine = buildTestEngine();
    await expect(engine.projects.getProject('prj-404')).rejects.toThrow(/No project found/);
  });
});
