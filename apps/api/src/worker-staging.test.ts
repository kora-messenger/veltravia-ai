/**
 * Isolated worker staging (Step 46).
 *
 * The property under test is the one that makes parallel workers safe: a worker
 * writes into its own tree, the project keeps its base content, and the write
 * becomes a change set rather than a fait accompli.
 */

import { describe, expect, it } from 'vitest';

import { createProjectEngine } from '@veltravia/project-mock';
import { createSourceService } from './source-service.js';
import { WorkerStagingRegistry, firstWorkspaceId } from './worker-staging.js';
import { createChangeIntegrationService } from './change-integration-service.js';

async function fixture() {
  const engine = createProjectEngine();
  const project = await engine.projects.createProject({
    name: 'Staging QA',
    description: 'Fixture',
    projectType: 'web',
    ownerRef: 'veltravia-dev-user',
  });
  const workspace = await engine.workspaces.createWorkspace(project.id, { name: 'main' });
  await engine.files.createDirectory(workspace.id, 'src');
  await engine.files.createFile(workspace.id, {
    path: 'src/base.ts',
    content: 'export const x = 1;',
  });
  const source = createSourceService({ projectEngine: engine });
  const staging = new WorkerStagingRegistry(engine);
  return { engine, project, workspace, source, staging };
}

describe('worker staging', () => {
  it('keeps worker writes out of the project and records a change set', async () => {
    const { engine, project, workspace, source, staging } = await fixture();
    const area = await staging.open({
      workerId: 'wkr_1',
      projectId: project.id,
      mainWorkspaceId: workspace.id,
      taskId: 'task_1',
      allowedPaths: ['src'],
      excludedPaths: ['src/secrets.ts'],
      allowedTools: ['project.write'],
    });
    await staging.write(area, 'src/feature.ts', 'export const feature = true;');

    // The project is untouched: the worker's copy is elsewhere.
    const main = await source.tree('veltravia-dev-user', {
      projectId: project.id,
      workspaceId: workspace.id,
    });
    expect(main.files.map((file) => file.path)).toContain('src/base.ts');
    expect(main.files.map((file) => file.path)).not.toContain('src/feature.ts');

    // The staging tree does hold it, and the base hash is the project's state.
    const staged = await source.tree('veltravia-dev-user', {
      projectId: project.id,
      workspaceId: area.stagingWorkspaceId,
    });
    expect(staged.files.map((file) => file.path)).toContain('src/feature.ts');
    expect(area.files.get('src/feature.ts')?.baseHash).toBeNull();
    expect(area.baseRevision).toBeGreaterThanOrEqual(1);
    expect(await firstWorkspaceId(engine, project.id)).toBe(workspace.id);
  });

  it('records an update against the hash the worker started from', async () => {
    const { engine, project, workspace, source, staging } = await fixture();
    const area = await staging.open({
      workerId: 'wkr_2',
      projectId: project.id,
      mainWorkspaceId: workspace.id,
      allowedPaths: ['src'],
      excludedPaths: [],
      allowedTools: ['project.write'],
    });
    const file = await staging.write(area, 'src/base.ts', 'export const x = 2;');
    const base = await source.readFile('veltravia-dev-user', {
      projectId: project.id,
      workspaceId: workspace.id,
      path: 'src/base.ts',
    });
    expect(file.op).toBe('update');
    expect(file.baseHash).toBe(base.contentHash.replace(/^sha256:/, ''));

    // Two workers editing the same base produce two independent proposals.
    const other = await staging.open({
      workerId: 'wkr_3',
      projectId: project.id,
      mainWorkspaceId: workspace.id,
      allowedPaths: ['src'],
      excludedPaths: [],
      allowedTools: ['project.write'],
    });
    const second = await staging.write(other, 'src/base.ts', 'export const x = 3;');
    expect(second.baseHash).toBe(file.baseHash);
    expect(other.stagingWorkspaceId).not.toBe(area.stagingWorkspaceId);

    const integration = createChangeIntegrationService({ projects: engine, source });
    const draft = (areaId: string, content: string) =>
      integration.manager.createChangeSet('veltravia-dev-user', {
        projectId: project.id,
        workspaceId: workspace.id,
        baseRevision: area.baseRevision,
        workerId: areaId,
        files: [{ path: 'src/base.ts', op: 'update', baseHash: file.baseHash, content }],
        authorization: { allowedPaths: ['src'], allowedTools: ['project.write'] },
      });
    const first = await draft('wkr_2', 'export const x = 2;');
    const third = await draft('wkr_3', 'export const x = 3;');
    const analysis = await integration.manager.analyze({
      ownerRef: 'veltravia-dev-user',
      projectId: project.id,
      changeSetIds: [first.id, third.id],
    });
    expect(analysis.blocked).toBe(true);
    expect(analysis.conflicts.length).toBeGreaterThan(0);
  });
});
