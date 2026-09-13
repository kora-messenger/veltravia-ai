import { describe, expect, it } from 'vitest';
import { buildTestEngine } from './project-manager.test.js';

const VALID_INPUT = {
  name: 'MarketScope Mobile',
  description: 'AI trading companion app',
  projectType: 'mobile' as const,
  ownerRef: 'user-1',
};

async function buildWorkspace() {
  const engine = buildTestEngine();
  const project = await engine.projects.createProject(VALID_INPUT);
  const workspace = await engine.workspaces.createWorkspace(project.id, { name: 'main' });
  return { engine, project, workspace };
}

describe('Optimistic revision protection', () => {
  it('rejects a project update based on an outdated revision', async () => {
    const { engine, project } = await buildWorkspace();
    // Writer A moves the project to revision 2
    const first = await engine.projects.updateProject(project.id, { name: 'A-edited' }, 1);
    expect(first.revision).toBe(2);
    // Writer B still holds revision 1 and is REJECTED, not silently applied
    await expect(
      engine.projects.updateProject(project.id, { name: 'B-edited' }, 1),
    ).rejects.toThrow(/Revision conflict on project/);
    // The newer change is intact
    expect((await engine.projects.getProject(project.id)).name).toBe('A-edited');
  });

  it('accepts a successful revision-matched update', async () => {
    const { engine, project } = await buildWorkspace();
    const updated = await engine.projects.updateProject(project.id, { name: 'New Name' }, 1);
    expect(updated.revision).toBe(2);
  });

  it('rejects conflicting concurrent workspace updates', async () => {
    const { engine, workspace } = await buildWorkspace();
    await engine.workspaces.updateWorkspace(workspace.id, { name: 'first-write' }, 1);
    await expect(
      engine.workspaces.updateWorkspace(workspace.id, { name: 'second-write' }, 1),
    ).rejects.toThrow(/Revision conflict on workspace/);
    expect((await engine.workspaces.getWorkspace(workspace.id)).name).toBe('first-write');
  });

  it('rejects a file update based on an outdated node revision', async () => {
    const { engine, workspace } = await buildWorkspace();
    const file = await engine.files.createFile(workspace.id, { path: 'README.md', content: 'v1' });
    const first = await engine.files.updateFile(workspace.id, 'README.md', {
      content: 'v2',
      expectedRevision: file.revision,
    });
    expect(first.revision).toBe(2);
    await expect(
      engine.files.updateFile(workspace.id, 'README.md', { content: 'v3', expectedRevision: 1 }),
    ).rejects.toThrow(/Revision conflict on file/);
    expect((await engine.files.readFile(workspace.id, 'README.md')).content).toBe('v2');
  });

  it('rejects context and config updates with stale revisions', async () => {
    const { engine, project } = await buildWorkspace();
    const config = await engine.projects.getProjectConfig(project.id);
    await engine.projects.updateProjectConfig(
      project.id,
      { language: 'typescript' },
      config.revision,
    );
    await expect(
      engine.projects.updateProjectConfig(project.id, { language: 'go' }, config.revision),
    ).rejects.toThrow(/Revision conflict on project configuration/);

    const context = await engine.projects.getProjectContext(project.id);
    await engine.projects.updateProjectContext(project.id, { goals: ['one'] }, context.revision);
    await expect(
      engine.projects.updateProjectContext(project.id, { goals: ['two'] }, context.revision),
    ).rejects.toThrow(/Revision conflict on project context/);
  });

  it('rejects malformed revision inputs', async () => {
    const { engine, project } = await buildWorkspace();
    await expect(engine.projects.updateProject(project.id, { name: 'X' }, 0)).rejects.toThrow(
      /Revision conflict/,
    );
    await expect(engine.projects.updateProject(project.id, { name: 'X' }, 1.5)).rejects.toThrow(
      /Revision conflict/,
    );
  });
});
