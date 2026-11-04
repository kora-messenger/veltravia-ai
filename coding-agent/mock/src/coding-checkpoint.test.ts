import { beforeEach, describe, expect, it } from 'vitest';

import {
  CodingAgentManager,
  type CodingCheckpointPort,
  type CodingCheckpointReport,
  type CodingDecision,
  type CodingRunView,
} from '@veltravia/coding-agent-core';
import {
  createCodingFixtureEnvironment,
  createScriptedCodingDecisionSource,
  type CodingFixtureEnvironment,
} from './index.js';

/**
 * Step 38: the checkpoint step of a coding run.
 *
 * The guarantees under test are about ORDER and about failing closed:
 *  - nothing happens before the plan is approved, so no checkpoint either,
 *  - the checkpoint is taken after approval and before the first change,
 *  - it is taken once, however many actions follow,
 *  - when it cannot be taken the run stops with no file changed,
 *  - the person is told what was (or was not) taken.
 */

const NOW = () => new Date('2026-11-04T10:00:00.000Z');

const PLAN: CodingDecision = {
  type: 'plan',
  plan: {
    goal: 'Create a README in the workspace.',
    steps: [{ summary: 'Create README.md' }],
    filesToInspect: [],
    filesToModify: ['README.md'],
    validations: ['npm test'],
    acceptanceCriteria: ['README.md exists'],
  },
};

const TAKEN: CodingCheckpointReport = {
  taken: true,
  checkpointId: 'cp-1',
  checkpointName: 'Before coding run',
  revisionNumber: 4,
  reason: 'Changes 5 files at once.',
};

const NOT_NEEDED: CodingCheckpointReport = {
  taken: false,
  checkpointId: null,
  checkpointName: null,
  revisionNumber: 4,
  reason: 'A small change (1 file); no checkpoint needed.',
};

describe('the checkpoint step of a coding run', () => {
  let env: CodingFixtureEnvironment;
  /** What the port saw, in order, with the tree's file list at each call. */
  let calls: { runId: string; plan: string; filesAtCall: string[] }[];

  beforeEach(async () => {
    env = await createCodingFixtureEnvironment({ now: NOW });
    calls = [];
  });

  async function filesNow(): Promise<string[]> {
    const nodes = await env.projectEngine.files.listAll(env.workspaceId);
    return nodes.filter((n) => n.type === 'file').map((n) => n.path);
  }

  function port(
    behaviour: (call: number) => Promise<CodingCheckpointReport> | CodingCheckpointReport,
  ): CodingCheckpointPort {
    return {
      async beforeApprovedChanges(input) {
        calls.push({ runId: input.runId, plan: input.plan.goal, filesAtCall: await filesNow() });
        return behaviour(calls.length);
      },
    };
  }

  function build(
    script: readonly CodingDecision[],
    checkpoints: CodingCheckpointPort | undefined,
    requirePlanApproval = true,
  ): CodingAgentManager {
    return new CodingAgentManager({
      tools: env.tools,
      decisionSource: createScriptedCodingDecisionSource(script),
      now: NOW,
      requirePlanApproval,
      ...(checkpoints !== undefined ? { checkpoints } : {}),
    });
  }

  const start = (manager: CodingAgentManager): Promise<CodingRunView> =>
    manager.startRun({
      projectId: env.projectId,
      workspaceId: env.workspaceId,
      userRequirement: 'Add a README',
    });

  const WRITE: CodingDecision[] = [
    PLAN,
    { type: 'action', action: { type: 'create_file', path: 'README.md', content: '# Hi' } },
    { type: 'action', action: { type: 'create_file', path: 'NOTES.md', content: 'notes' } },
    { type: 'complete', summary: 'Done.' },
  ];

  it('takes nothing while the plan is still waiting for approval', async () => {
    const manager = build(
      WRITE,
      port(() => TAKEN),
    );
    const waiting = await start(manager);
    expect(waiting.state).toBe('awaiting_approval');
    expect(calls).toHaveLength(0);
    expect(waiting.checkpoint).toBeNull();
  });

  it('takes it after approval and BEFORE the first file is written', async () => {
    const before = await filesNow();
    const manager = build(
      WRITE,
      port(() => TAKEN),
    );
    const waiting = await start(manager);
    const done = await manager.submitApproval(waiting.runId, 'approve');

    expect(calls).toHaveLength(1);
    // At the moment of the call the tree was exactly as it started.
    expect(calls[0]?.filesAtCall).toEqual(before);
    expect(calls[0]?.plan).toBe('Create a README in the workspace.');
    // And the files were written afterwards.
    expect(await filesNow()).toEqual(expect.arrayContaining(['README.md', 'NOTES.md']));
    expect(done.state).toBe('completed');
  });

  it('takes it once, however many actions follow', async () => {
    const manager = build(
      WRITE,
      port(() => TAKEN),
    );
    const waiting = await start(manager);
    await manager.submitApproval(waiting.runId, 'approve');
    expect(calls).toHaveLength(1);
  });

  it('reports the checkpoint it took on the run', async () => {
    const manager = build(
      WRITE,
      port(() => TAKEN),
    );
    const waiting = await start(manager);
    const done = await manager.submitApproval(waiting.runId, 'approve');
    expect(done.checkpoint).toEqual(TAKEN);
  });

  it('says so when no checkpoint was needed, rather than staying silent', async () => {
    const manager = build(
      WRITE,
      port(() => NOT_NEEDED),
    );
    const waiting = await start(manager);
    const done = await manager.submitApproval(waiting.runId, 'approve');
    expect(done.checkpoint?.taken).toBe(false);
    expect(done.checkpoint?.reason).toContain('no checkpoint needed');
    expect(done.state).toBe('completed');
  });

  it('also takes it when plan approval is switched off', async () => {
    const before = await filesNow();
    const manager = build(
      WRITE,
      port(() => TAKEN),
      false,
    );
    const done = await start(manager);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.filesAtCall).toEqual(before);
    expect(done.checkpoint?.taken).toBe(true);
  });

  it('never takes one for a plan the person rejects', async () => {
    const manager = build(
      WRITE,
      port(() => TAKEN),
    );
    const waiting = await start(manager);
    const rejected = await manager.submitApproval(waiting.runId, 'reject');
    expect(calls).toHaveLength(0);
    expect(rejected.state).toBe('failed');
    expect(rejected.checkpoint).toBeNull();
  });

  it('stops the run, with no file changed, when the checkpoint cannot be taken', async () => {
    const before = await filesNow();
    const manager = build(
      WRITE,
      port(() => {
        throw new Error('disk full');
      }),
    );
    const waiting = await start(manager);
    const failed = await manager.submitApproval(waiting.runId, 'approve');

    expect(failed.state).toBe('failed');
    expect(failed.failure?.code).toBe('CODING_CHECKPOINT_FAILED');
    expect(failed.failure?.message).toContain('nothing was changed');
    // The point of failing closed: not one file was touched.
    expect(await filesNow()).toEqual(before);
    expect(failed.changedFiles).toEqual([]);
  });

  it('does not put the underlying error text in the failure', async () => {
    const manager = build(
      WRITE,
      port(() => {
        throw new Error('secret connection string postgres://user:pw@host');
      }),
    );
    const waiting = await start(manager);
    const failed = await manager.submitApproval(waiting.runId, 'approve');
    expect(JSON.stringify(failed)).not.toContain('postgres://');
  });

  it('runs as before when no checkpoint port is configured', async () => {
    const manager = build(WRITE, undefined);
    const waiting = await start(manager);
    const done = await manager.submitApproval(waiting.runId, 'approve');
    expect(done.state).toBe('completed');
    expect(done.checkpoint).toBeNull();
  });
});
