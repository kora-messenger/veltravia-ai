import { describe, expect, it } from 'vitest';
import type { CodingDecision, CodingDecisionContext } from '@veltravia/coding-agent-core';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';

import { createCodingCheckpointPort, profileOfPlan } from '../coding-checkpoints.js';
import { createCodingManager } from '../coding.js';
import { buildApp } from '../server.js';
import { createVersionControlService } from '../version-service.js';

/**
 * Step 38: a coding run takes its checkpoint after approval, attributed to the
 * agent, and tells the person. Runs through the real server and Project Engine.
 */

const NOW = () => new Date('2026-11-04T10:00:00.000Z');

const PLAN = (over: Partial<Record<string, string[]>> = {}): CodingDecision => ({
  type: 'plan',
  plan: {
    goal: 'Add feature modules.',
    steps: [{ summary: 'Create the modules' }],
    filesToInspect: [],
    filesToModify: [],
    filesToCreate: [],
    filesToDelete: [],
    validations: [],
    acceptanceCriteria: ['modules exist'],
    ...over,
  } as never,
});

async function setup(decisions: CodingDecision[]) {
  const projectEngine = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const project = await projectEngine.projects.createProject({
    name: 'p',
    description: 'd',
    projectType: 'other',
    ownerRef: 'owner',
  });
  const workspace = await projectEngine.workspaces.createWorkspace(project.id, { name: 'main' });
  await projectEngine.files.createFile(workspace.id, { path: 'old.ts', content: 'old' });

  // One version manager, shared by the coding port and the history routes.
  const service = createVersionControlService({ projectEngine, now: NOW });

  let index = 0;
  const coding = createCodingManager({
    projectEngine,
    now: NOW,
    decisionSource: {
      nextDecision: async (_c: CodingDecisionContext): Promise<CodingDecision> =>
        decisions[index++] ?? { type: 'fail', reason: 'script exhausted' },
    },
    requirePlanApproval: true,
    checkpoints: createCodingCheckpointPort({ projectEngine, version: service.manager }),
  });
  const app = buildApp({ projectEngine, coding, versionManager: service.manager });
  return { app, projectId: project.id, workspaceId: workspace.id, service };
}

const write = (path: string): CodingDecision => ({
  type: 'action',
  action: { type: 'create_file', path, content: `// ${path}` },
});

describe('profileOfPlan', () => {
  it('counts every file a plan touches once', () => {
    const p = profileOfPlan({
      filesToModify: ['a.ts', 'b.ts'],
      filesToCreate: ['b.ts', 'c.ts'],
      filesToDelete: [],
    });
    expect(p.filesAffected).toBe(3);
  });

  it('treats a listed deletion as an approved destructive operation', () => {
    const p = profileOfPlan({ filesToModify: [], filesToDelete: ['gone.ts'] });
    expect(p.filesDeleted).toBe(1);
    expect(p.destructiveApproved).toBe(true);
  });

  it('calls a rewrite of several existing files with nothing new a refactor', () => {
    expect(profileOfPlan({ filesToModify: ['a', 'b', 'c'] }).isRefactor).toBe(true);
    expect(profileOfPlan({ filesToModify: ['a', 'b', 'c'], filesToCreate: ['d'] }).isRefactor).toBe(
      false,
    );
    expect(profileOfPlan({ filesToModify: ['a', 'b'] }).isRefactor).toBe(false);
  });

  it('copes with a plan that does not list creates or deletes', () => {
    expect(profileOfPlan({ filesToModify: ['a'] }).filesAffected).toBe(1);
  });
});

describe('a coding run and its checkpoint', () => {
  it('takes one for a multi-file change, after approval, and reports it', async () => {
    const { app, projectId, workspaceId } = await setup([
      PLAN({ filesToCreate: ['a.ts', 'b.ts', 'c.ts'] }),
      write('a.ts'),
      write('b.ts'),
      write('c.ts'),
      { type: 'complete', summary: 'Done.' },
    ]);
    const started = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId, workspaceId, userRequirement: 'Add modules' },
    });
    const run = started.json() as { runId: string; state: string; checkpoint: unknown };
    expect(run.state).toBe('awaiting_approval');
    // Nothing is taken while the plan waits.
    expect(run.checkpoint).toBeNull();

    const approved = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${run.runId}/confirmation`,
      payload: { decision: 'approve' },
    });
    const done = approved.json() as {
      state: string;
      checkpoint: { taken: boolean; checkpointName: string; reason: string };
    };
    expect(done.state).toBe('completed');
    expect(done.checkpoint.taken).toBe(true);
    expect(done.checkpoint.checkpointName).toContain('Before coding run');
    expect(done.checkpoint.reason).toBe('Changes 3 files at once.');
  });

  it('puts the checkpoint in the history as the agent’s, holding the files as they were', async () => {
    const { app, projectId, workspaceId, service } = await setup([
      PLAN({ filesToCreate: ['a.ts', 'b.ts', 'c.ts'] }),
      write('a.ts'),
      write('b.ts'),
      write('c.ts'),
      { type: 'complete', summary: 'Done.' },
    ]);
    const started = (
      await app.inject({
        method: 'POST',
        url: '/api/coding/runs',
        payload: { projectId, workspaceId, userRequirement: 'Add modules' },
      })
    ).json() as { runId: string };
    await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${started.runId}/confirmation`,
      payload: { decision: 'approve' },
    });

    const checkpoints = await service.manager.listCheckpoints(projectId, workspaceId);
    const taken = checkpoints.find((c) => c.name.startsWith('Before coding run'));
    expect(taken).toBeDefined();
    expect(taken?.createdBy).toBe('ai-agent');

    const revision = await service.manager.getRevision(projectId, workspaceId, taken!.revisionId);
    expect(revision.source).toBe('coding_before');
    // It holds the tree from BEFORE the run: old.ts only, none of the new files.
    const snapshot = await service.manager.getIntactSnapshot(
      projectId,
      workspaceId,
      taken!.revisionId,
    );
    expect(snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.path)).toEqual(['old.ts']);
  });

  it('takes none for a small change and says why', async () => {
    const { app, projectId, workspaceId, service } = await setup([
      PLAN({ filesToCreate: ['only.ts'] }),
      write('only.ts'),
      { type: 'complete', summary: 'Done.' },
    ]);
    const started = (
      await app.inject({
        method: 'POST',
        url: '/api/coding/runs',
        payload: { projectId, workspaceId, userRequirement: 'Add one file' },
      })
    ).json() as { runId: string };
    const done = (
      await app.inject({
        method: 'POST',
        url: `/api/coding/runs/${started.runId}/confirmation`,
        payload: { decision: 'approve' },
      })
    ).json() as { state: string; checkpoint: { taken: boolean; reason: string } };

    expect(done.state).toBe('completed');
    expect(done.checkpoint.taken).toBe(false);
    expect(done.checkpoint.reason).toContain('no checkpoint needed');
    const checkpoints = await service.manager.listCheckpoints(projectId, workspaceId);
    expect(checkpoints.filter((c) => c.name.startsWith('Before coding run'))).toHaveLength(0);
  });

  it('takes one before a plan that deletes a file', async () => {
    const { app, projectId, workspaceId } = await setup([
      PLAN({ filesToDelete: ['old.ts'] }),
      { type: 'action', action: { type: 'delete_file', path: 'old.ts' } },
      { type: 'complete', summary: 'Done.' },
    ]);
    const started = (
      await app.inject({
        method: 'POST',
        url: '/api/coding/runs',
        payload: { projectId, workspaceId, userRequirement: 'Remove old' },
      })
    ).json() as { runId: string };
    const done = (
      await app.inject({
        method: 'POST',
        url: `/api/coding/runs/${started.runId}/confirmation`,
        payload: { decision: 'approve' },
      })
    ).json() as { checkpoint: { taken: boolean; reason: string } };
    expect(done.checkpoint.taken).toBe(true);
    expect(done.checkpoint.reason).toBe('Removes 1 file.');
  });

  it('takes none when the plan is rejected', async () => {
    const { app, projectId, workspaceId, service } = await setup([
      PLAN({ filesToCreate: ['a.ts', 'b.ts', 'c.ts'] }),
    ]);
    const started = (
      await app.inject({
        method: 'POST',
        url: '/api/coding/runs',
        payload: { projectId, workspaceId, userRequirement: 'Add modules' },
      })
    ).json() as { runId: string };
    await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${started.runId}/confirmation`,
      payload: { decision: 'reject' },
    });
    const checkpoints = await service.manager.listCheckpoints(projectId, workspaceId);
    expect(checkpoints.filter((c) => c.name.startsWith('Before coding run'))).toHaveLength(0);
  });
});
