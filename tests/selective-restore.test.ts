import { describe, expect, it } from 'vitest';

import { VersionError } from '@veltravia/version-core';

import { makeHarness } from './support/branch-fixtures.js';

const P = 'proj-1';

/** A workspace with three files, saved; then two of them edited and one added. */
async function seeded() {
  const h = makeHarness();
  const ws = h.workspaces.addWorkspace(P, {
    'a.ts': 'a-v1',
    'b.ts': 'b-v1',
    'keep.ts': 'keep-v1',
  });
  const first = await h.versions.captureRevision({
    projectId: P,
    workspaceId: ws,
    source: 'manual',
    message: 'first',
  });
  h.workspaces.write(ws, 'a.ts', 'a-v2');
  h.workspaces.write(ws, 'b.ts', 'b-v2');
  h.workspaces.write(ws, 'keep.ts', 'keep-v2');
  h.workspaces.write(ws, 'new.ts', 'brand new');
  await h.versions.captureRevision({ projectId: P, workspaceId: ws, source: 'manual' });
  return { h, ws, first };
}

const request = (
  ws: string,
  targetRevisionId: string,
  expectedCurrentRevision: number,
  paths: string[],
) => ({
  projectId: P,
  workspaceId: ws,
  targetRevisionId,
  expectedCurrentRevision,
  reason: null,
  paths,
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VersionError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('restoring selected files', () => {
  it('puts back the chosen file and leaves every other file as it is', async () => {
    const { h, ws, first } = await seeded();
    const live =
      (await h.versions.getRevision(P, ws, first.id)) && (await h.workspaces.getWorkspace(ws));

    const result = await h.versions.executeSelectiveRollback(
      request(ws, first.id, live.revision, ['a.ts']),
    );

    expect(h.workspaces.read(ws, 'a.ts')).toBe('a-v1');
    // Not named, so not touched, even though the first revision had older versions.
    expect(h.workspaces.read(ws, 'b.ts')).toBe('b-v2');
    expect(h.workspaces.read(ws, 'keep.ts')).toBe('keep-v2');
    expect(h.workspaces.read(ws, 'new.ts')).toBe('brand new');
    expect(result.filesChanged).toBe(1);
  });

  it('restores several named files in one go', async () => {
    const { h, ws, first } = await seeded();
    const live = await h.workspaces.getWorkspace(ws);
    await h.versions.executeSelectiveRollback(
      request(ws, first.id, live.revision, ['a.ts', 'b.ts']),
    );
    expect(h.workspaces.read(ws, 'a.ts')).toBe('a-v1');
    expect(h.workspaces.read(ws, 'b.ts')).toBe('b-v1');
    expect(h.workspaces.read(ws, 'keep.ts')).toBe('keep-v2');
  });

  it('removes a named file that did not exist back then, and only that one', async () => {
    const { h, ws, first } = await seeded();
    const live = await h.workspaces.getWorkspace(ws);
    await h.versions.executeSelectiveRollback(request(ws, first.id, live.revision, ['new.ts']));
    expect(h.workspaces.read(ws, 'new.ts')).toBeNull();
    expect(h.workspaces.read(ws, 'a.ts')).toBe('a-v2');
  });

  it('brings back a file that was deleted', async () => {
    const { h, ws, first } = await seeded();
    h.workspaces.remove(ws, 'b.ts');
    const live = await h.workspaces.getWorkspace(ws);
    await h.versions.executeSelectiveRollback(request(ws, first.id, live.revision, ['b.ts']));
    expect(h.workspaces.read(ws, 'b.ts')).toBe('b-v1');
  });

  it('adds a new revision and keeps the old history', async () => {
    const { h, ws, first } = await seeded();
    const before = (await h.versions.listRevisions(P, ws, 50, 0)).total;
    const live = await h.workspaces.getWorkspace(ws);
    const result = await h.versions.executeSelectiveRollback(
      request(ws, first.id, live.revision, ['a.ts']),
    );
    const after = await h.versions.listRevisions(P, ws, 50, 0);
    // One recovery point and one restore.
    expect(after.total).toBe(before + 2);
    expect(after.revisions[0]?.id).toBe(result.newRevisionId);
    expect(after.revisions[0]?.source).toBe('rollback');
    expect(after.revisions[0]?.message).toContain('Restored 1 path');
  });

  it('takes a recovery checkpoint that still holds the files as they were', async () => {
    const { h, ws, first } = await seeded();
    const live = await h.workspaces.getWorkspace(ws);
    const result = await h.versions.executeSelectiveRollback(
      request(ws, first.id, live.revision, ['a.ts']),
    );
    const checkpoint = await h.versions.getCheckpoint(P, ws, result.recoveryCheckpointId!);
    expect(checkpoint.name).toContain('some files');
    const snap = await h.versions.getIntactSnapshot(P, ws, checkpoint.revisionId);
    expect(snap.nodes.find((n) => n.path === 'a.ts')?.content).toBe('a-v2');
  });
});

describe('refusals', () => {
  it('rejects a stale expected revision and changes nothing', async () => {
    const { h, ws, first } = await seeded();
    const live = await h.workspaces.getWorkspace(ws);
    expect(
      await code(
        h.versions.executeSelectiveRollback(request(ws, first.id, live.revision - 1, ['a.ts'])),
      ),
    ).toBe('VERSION_REVISION_CONFLICT');
    expect(h.workspaces.read(ws, 'a.ts')).toBe('a-v2');
  });

  it('takes no recovery checkpoint when it refuses', async () => {
    const { h, ws, first } = await seeded();
    const live = await h.workspaces.getWorkspace(ws);
    await code(
      h.versions.executeSelectiveRollback(request(ws, first.id, live.revision - 1, ['a.ts'])),
    );
    const cps = await h.versions.listCheckpoints(P, ws);
    expect(cps.some((c) => c.name.startsWith('Recovery'))).toBe(false);
  });

  it('refuses when the chosen files already match, without a checkpoint', async () => {
    const { h, ws, first } = await seeded();
    h.workspaces.write(ws, 'a.ts', 'a-v1');
    const live = await h.workspaces.getWorkspace(ws);
    expect(
      await code(
        h.versions.executeSelectiveRollback(request(ws, first.id, live.revision, ['a.ts'])),
      ),
    ).toBe('VERSION_INVALID_ROLLBACK_TARGET');
    const cps = await h.versions.listCheckpoints(P, ws);
    expect(cps).toHaveLength(0);
  });

  it.each([[[]], [['../secret']], [['a//b']], [['']]])('refuses the paths %j', async (paths) => {
    const { h, ws, first } = await seeded();
    const live = await h.workspaces.getWorkspace(ws);
    expect(
      await code(h.versions.executeSelectiveRollback(request(ws, first.id, live.revision, paths))),
    ).toBe('VERSION_RESTORE_PATHS_INVALID');
    expect(h.workspaces.read(ws, 'a.ts')).toBe('a-v2');
  });

  it('refuses a revision that belongs to another workspace of the project', async () => {
    const { h, ws } = await seeded();
    const other = h.workspaces.addWorkspace(P, { 'z.ts': 'z' });
    const foreign = await h.versions.captureRevision({
      projectId: P,
      workspaceId: other,
      source: 'manual',
    });
    const live = await h.workspaces.getWorkspace(ws);
    expect(
      await code(
        h.versions.executeSelectiveRollback(request(ws, foreign.id, live.revision, ['a.ts'])),
      ),
    ).toBe('VERSION_REVISION_FOREIGN_WORKSPACE');
  });

  it('refuses a workspace that belongs to a different project', async () => {
    const { h, first, ws } = await seeded();
    const live = await h.workspaces.getWorkspace(ws);
    const wrong = { ...request(ws, first.id, live.revision, ['a.ts']), projectId: 'someone-elses' };
    expect(await code(h.versions.executeSelectiveRollback(wrong))).toBe(
      'VERSION_REVISION_FOREIGN_PROJECT',
    );
    expect(h.workspaces.read(ws, 'a.ts')).toBe('a-v2');
  });

  it('refuses a snapshot that has been tampered with, and writes nothing', async () => {
    const { h, ws, first } = await seeded();
    const snapshot = await (
      h.versions as unknown as {
        store: { getSnapshot(id: string): Promise<{ nodes: { content: string }[] } | null> };
      }
    ).store.getSnapshot(first.id);
    for (const node of snapshot!.nodes) node.content = 'tampered';

    const live = await h.workspaces.getWorkspace(ws);
    expect(
      await code(
        h.versions.executeSelectiveRollback(request(ws, first.id, live.revision, ['a.ts'])),
      ),
    ).toBe('VERSION_CORRUPTED_SNAPSHOT');
    // Nothing was written, and no recovery checkpoint was left behind.
    expect(h.workspaces.read(ws, 'a.ts')).toBe('a-v2');
    expect(
      (await h.versions.listCheckpoints(P, ws)).some((c) => c.name.startsWith('Recovery')),
    ).toBe(false);
  });
});
