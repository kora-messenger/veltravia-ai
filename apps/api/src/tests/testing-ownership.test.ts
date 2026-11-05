import { describe, expect, it } from 'vitest';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { TestingAccessError, TestingRunLedger } from '../testing-ownership.js';

async function setup() {
  const projects = createProjectEngine({
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const mine = await projects.projects.createProject({
    name: 'mine',
    description: '',
    projectType: 'web',
    ownerRef: 'owner-a',
  });
  const myWorkspace = await projects.workspaces.createWorkspace(mine.id, { name: 'main' });
  const theirs = await projects.projects.createProject({
    name: 'theirs',
    description: '',
    projectType: 'web',
    ownerRef: 'owner-b',
  });
  const theirWorkspace = await projects.workspaces.createWorkspace(theirs.id, { name: 'main' });
  return { ledger: new TestingRunLedger(projects), mine, myWorkspace, theirs, theirWorkspace };
}

describe('who may start a testing run', () => {
  it('lets an owner start a run on their own project and workspace', async () => {
    const { ledger, mine, myWorkspace } = await setup();
    await expect(
      ledger.assertCanStart('owner-a', mine.id, myWorkspace.id),
    ).resolves.toBeUndefined();
  });

  it('refuses a project that belongs to someone else', async () => {
    const { ledger, theirs, theirWorkspace } = await setup();
    await expect(
      ledger.assertCanStart('owner-a', theirs.id, theirWorkspace.id),
    ).rejects.toBeInstanceOf(TestingAccessError);
  });

  it('refuses a project that does not exist, with the same error', async () => {
    const { ledger, myWorkspace } = await setup();
    const missing = await ledger
      .assertCanStart('owner-a', 'prj-nope', myWorkspace.id)
      .catch((error: Error) => error);
    const foreign = await setup().then(({ ledger: l, theirs, theirWorkspace }) =>
      l.assertCanStart('owner-a', theirs.id, theirWorkspace.id).catch((error: Error) => error),
    );
    expect(missing).toBeInstanceOf(TestingAccessError);
    expect((missing as Error).message).toBe((foreign as Error).message);
  });

  it('refuses a workspace that belongs to a different project', async () => {
    const { ledger, mine, theirWorkspace } = await setup();
    await expect(
      ledger.assertCanStart('owner-a', mine.id, theirWorkspace.id),
    ).rejects.toBeInstanceOf(TestingAccessError);
  });

  it('refuses a workspace id that does not exist', async () => {
    const { ledger, mine } = await setup();
    await expect(ledger.assertCanStart('owner-a', mine.id, 'ws-nope')).rejects.toBeInstanceOf(
      TestingAccessError,
    );
  });
});

describe('who may see a testing run', () => {
  it('shows a run to its owner', async () => {
    const { ledger, mine, myWorkspace } = await setup();
    ledger.record('run-1', {
      ownerRef: 'owner-a',
      projectId: mine.id,
      workspaceId: myWorkspace.id,
    });
    expect(ledger.require('owner-a', 'run-1').projectId).toBe(mine.id);
  });

  it('hides a run from anyone else, exactly as if it did not exist', async () => {
    const { ledger, mine, myWorkspace } = await setup();
    ledger.record('run-1', {
      ownerRef: 'owner-a',
      projectId: mine.id,
      workspaceId: myWorkspace.id,
    });
    const other = (() => {
      try {
        ledger.require('owner-b', 'run-1');
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    const missing = (() => {
      try {
        ledger.require('owner-b', 'run-unknown');
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(other).toBeInstanceOf(TestingAccessError);
    expect(missing).toBeInstanceOf(TestingAccessError);
    expect(other?.message).toBe(missing?.message);
  });

  it('does not let a second record overwrite the first owner', async () => {
    const { ledger, mine, myWorkspace } = await setup();
    ledger.record('run-1', {
      ownerRef: 'owner-a',
      projectId: mine.id,
      workspaceId: myWorkspace.id,
    });
    ledger.record('run-1', { ownerRef: 'owner-b', projectId: 'x', workspaceId: 'y' });
    expect(() => ledger.require('owner-b', 'run-1')).toThrow(TestingAccessError);
    expect(ledger.require('owner-a', 'run-1').projectId).toBe(mine.id);
  });

  it('lists only the caller’s runs', async () => {
    const { ledger, mine, myWorkspace, theirs, theirWorkspace } = await setup();
    ledger.record('run-a', {
      ownerRef: 'owner-a',
      projectId: mine.id,
      workspaceId: myWorkspace.id,
    });
    ledger.record('run-b', {
      ownerRef: 'owner-b',
      projectId: theirs.id,
      workspaceId: theirWorkspace.id,
    });
    expect(ledger.list('owner-a').map((entry) => entry.runId)).toEqual(['run-a']);
    expect(ledger.list('owner-b').map((entry) => entry.runId)).toEqual(['run-b']);
    expect(ledger.list('owner-c')).toEqual([]);
  });
});
