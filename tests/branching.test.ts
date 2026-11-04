import { describe, expect, it } from 'vitest';

import { VersionError } from '@veltravia/version-core';

import { makeHarness } from './support/branch-fixtures.js';

const P = 'proj-1';

/** A project with one workspace, one saved version and the default branch. */
async function started(files: Record<string, string> = { 'src/app.ts': 'v1', 'README.md': 'hi' }) {
  const h = makeHarness();
  const ws = h.workspaces.addWorkspace(P, files);
  await h.versions.captureRevision({ projectId: P, workspaceId: ws, source: 'manual' });
  const main = await h.branches.adoptWorkspace({ projectId: P, workspaceId: ws });
  return { ...h, ws, main };
}

async function failure(work: Promise<unknown>): Promise<VersionError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof VersionError) return error;
    throw error;
  }
  throw new Error('expected a VersionError');
}

describe('adopting the first branch', () => {
  it('turns the existing workspace into the default branch and keeps its history', async () => {
    const { main, ws, versions } = await started();
    expect(main.isDefault).toBe(true);
    expect(main.workspaceId).toBe(ws);
    expect(main.name).toBe('main');
    expect((await versions.listRevisions(P, ws)).total).toBe(1);
  });

  it('is idempotent for the same workspace', async () => {
    const { branches, ws, main } = await started();
    const again = await branches.adoptWorkspace({ projectId: P, workspaceId: ws });
    expect(again.id).toBe(main.id);
    expect(await branches.listBranches(P)).toHaveLength(1);
  });

  it('makes it the active branch', async () => {
    const { branches, main } = await started();
    expect((await branches.getActiveBranch(P))?.id).toBe(main.id);
  });
});

describe('creating a branch', () => {
  it('copies the source files into its own workspace', async () => {
    const { branches, workspaces, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    expect(feature.workspaceId).not.toBe(main.workspaceId);
    expect(workspaces.read(feature.workspaceId, 'src/app.ts')).toBe('v1');
    expect(workspaces.read(feature.workspaceId, 'README.md')).toBe('hi');
    expect(feature.parentBranchId).toBe(main.id);
    expect(feature.isDefault).toBe(false);
  });

  it('gives the new branch a history of its own, starting at creation', async () => {
    const { branches, versions, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    const page = await versions.listRevisions(P, feature.workspaceId);
    expect(page.total).toBe(1);
    expect(page.revisions[0]?.message).toContain('Branch "feature" created from "main"');
  });

  it('can start from an older revision rather than the latest', async () => {
    const { branches, workspaces, versions, ws, main } = await started();
    const first = (await versions.listRevisions(P, ws)).revisions[0]!;
    workspaces.write(ws, 'src/app.ts', 'v2');
    await versions.captureRevision({ projectId: P, workspaceId: ws, source: 'manual' });
    const old = await branches.createBranch({
      projectId: P,
      name: 'from-old',
      fromBranchId: main.id,
      fromRevisionId: first.id,
    });
    expect(workspaces.read(old.workspaceId, 'src/app.ts')).toBe('v1');
    expect(old.baseRevisionId).toBe(first.id);
  });

  it('refuses a duplicate name, ignoring case', async () => {
    const { branches, main } = await started();
    await branches.createBranch({ projectId: P, name: 'Feature', fromBranchId: main.id });
    const err = await failure(
      branches.createBranch({ projectId: P, name: 'feature', fromBranchId: main.id }),
    );
    expect(err.code).toBe('VERSION_BRANCH_NAME_TAKEN');
  });

  it.each(['', '   ', 'x'.repeat(65), 'bad\nname', 'tab\tname'])(
    'refuses the name %j',
    async (name) => {
      const { branches, main } = await started();
      const err = await failure(
        branches.createBranch({ projectId: P, name, fromBranchId: main.id }),
      );
      expect(err.code).toBe('VERSION_INVALID_REQUEST');
    },
  );

  it('refuses a name that looks like a secret', async () => {
    const { branches, main } = await started();
    const err = await failure(
      branches.createBranch({ projectId: P, name: 'ghp_' + 'a'.repeat(30), fromBranchId: main.id }),
    );
    expect(err.code).toBe('VERSION_SECRET_REJECTED');
  });

  it('stops at the branch limit', async () => {
    const { branches, main } = await started();
    for (let i = 0; i < 24; i += 1) {
      await branches.createBranch({ projectId: P, name: `b${i}`, fromBranchId: main.id });
    }
    const err = await failure(
      branches.createBranch({ projectId: P, name: 'one-too-many', fromBranchId: main.id }),
    );
    expect(err.code).toBe('VERSION_BRANCH_LIMIT');
  });

  it('cleans up the workspace it made when seeding fails, and records no branch', async () => {
    const { branches, workspaces, main } = await started();
    workspaces.failNextSeed = true;
    await expect(
      branches.createBranch({ projectId: P, name: 'doomed', fromBranchId: main.id }),
    ).rejects.toThrow();
    expect(workspaces.discarded).toHaveLength(1);
    expect(workspaces.has(workspaces.discarded[0]!)).toBe(false);
    expect((await branches.listBranches(P)).map((b) => b.name)).toEqual(['main']);
  });

  it('refuses to copy from a branch of another project', async () => {
    const { branches, workspaces, main } = await started();
    const otherWs = workspaces.addWorkspace('proj-2', { 'x.ts': 'x' });
    const other = await branches.adoptWorkspace({ projectId: 'proj-2', workspaceId: otherWs });
    const err = await failure(
      branches.createBranch({ projectId: P, name: 'steal', fromBranchId: other.id }),
    );
    expect(err.code).toBe('VERSION_BRANCH_NOT_FOUND');
    expect((await branches.listBranches(P)).map((b) => b.name)).toEqual(['main']);
    expect(main.projectId).toBe(P);
  });

  it('copies nothing when the source snapshot has been tampered with', async () => {
    const { branches, workspaces, versions, ws, main } = await started();
    const rev = (await versions.listRevisions(P, ws)).revisions[0]!;
    const snapshot = await (
      versions as unknown as {
        store: { getSnapshot(id: string): Promise<{ nodes: { content: string }[] } | null> };
      }
    ).store.getSnapshot(rev.id);
    snapshot!.nodes[0]!.content = 'tampered';
    const before = workspaces.paths(ws).length;
    const err = await failure(
      branches.createBranch({ projectId: P, name: 'bad', fromBranchId: main.id }),
    );
    expect(err.code).toBe('VERSION_CORRUPTED_SNAPSHOT');
    expect((await branches.listBranches(P)).map((b) => b.name)).toEqual(['main']);
    expect(workspaces.paths(ws)).toHaveLength(before);
  });
});

describe('branch isolation', () => {
  it('an edit on one branch does not appear on the other', async () => {
    const { branches, workspaces, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    workspaces.write(feature.workspaceId, 'src/app.ts', 'feature-only');
    expect(workspaces.read(main.workspaceId, 'src/app.ts')).toBe('v1');
    workspaces.write(main.workspaceId, 'src/app.ts', 'main-only');
    expect(workspaces.read(feature.workspaceId, 'src/app.ts')).toBe('feature-only');
  });

  it('a deletion on one branch leaves the other intact', async () => {
    const { branches, workspaces, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    workspaces.remove(feature.workspaceId, 'README.md');
    expect(workspaces.read(main.workspaceId, 'README.md')).toBe('hi');
  });

  it('keeps a separate revision history for each branch', async () => {
    const { branches, workspaces, versions, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    workspaces.write(feature.workspaceId, 'src/app.ts', 'f2');
    await versions.captureRevision({
      projectId: P,
      workspaceId: feature.workspaceId,
      source: 'manual',
    });
    expect((await versions.listRevisions(P, feature.workspaceId)).total).toBe(2);
    expect((await versions.listRevisions(P, main.workspaceId)).total).toBe(1);
  });

  it('refuses a revision from another branch when asked through this one', async () => {
    const { branches, versions, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    const mainRev = (await versions.listRevisions(P, main.workspaceId)).revisions[0]!;
    await expect(versions.getRevision(P, feature.workspaceId, mainRev.id)).rejects.toMatchObject({
      code: 'VERSION_REVISION_FOREIGN_WORKSPACE',
    });
  });
});

describe('switching', () => {
  it('moves only the pointer: no file on either branch changes', async () => {
    const { branches, workspaces, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    const before = [workspaces.paths(main.workspaceId), workspaces.paths(feature.workspaceId)];
    await branches.switchBranch(P, feature.id);
    expect((await branches.getActiveBranch(P))?.id).toBe(feature.id);
    expect([workspaces.paths(main.workspaceId), workspaces.paths(feature.workspaceId)]).toEqual(
      before,
    );
    expect(workspaces.read(main.workspaceId, 'src/app.ts')).toBe('v1');
  });

  it('switches back and forth', async () => {
    const { branches, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    await branches.switchBranch(P, feature.id);
    await branches.switchBranch(P, main.id);
    expect((await branches.getActiveBranch(P))?.id).toBe(main.id);
  });

  it('refuses an archived branch', async () => {
    const { branches, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    await branches.archiveBranch(P, feature.id);
    expect((await failure(branches.switchBranch(P, feature.id))).code).toBe(
      'VERSION_BRANCH_ARCHIVED',
    );
  });

  it('refuses a branch of another project', async () => {
    const { branches, workspaces } = await started();
    const otherWs = workspaces.addWorkspace('proj-2', { 'x.ts': 'x' });
    const other = await branches.adoptWorkspace({ projectId: 'proj-2', workspaceId: otherWs });
    expect((await failure(branches.switchBranch(P, other.id))).code).toBe(
      'VERSION_BRANCH_NOT_FOUND',
    );
  });
});

describe('rename, archive and delete', () => {
  it('renames, keeping the files and the history', async () => {
    const { branches, versions, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    const renamed = await branches.renameBranch(P, feature.id, 'login-work');
    expect(renamed.name).toBe('login-work');
    expect(renamed.workspaceId).toBe(feature.workspaceId);
    expect((await versions.listRevisions(P, feature.workspaceId)).total).toBe(1);
  });

  it('refuses to rename onto another branch name', async () => {
    const { branches, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    expect((await failure(branches.renameBranch(P, feature.id, 'MAIN'))).code).toBe(
      'VERSION_BRANCH_NAME_TAKEN',
    );
  });

  it('lets a branch keep its own name when renamed with different case', async () => {
    const { branches, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    expect((await branches.renameBranch(P, feature.id, 'Feature')).name).toBe('Feature');
  });

  it('archives without removing anything, and can bring it back', async () => {
    const { branches, workspaces, versions, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    await branches.archiveBranch(P, feature.id);
    expect((await branches.listBranches(P)).map((b) => b.name)).toEqual(['main']);
    expect(await branches.listBranches(P, { includeArchived: true })).toHaveLength(2);
    expect(workspaces.read(feature.workspaceId, 'src/app.ts')).toBe('v1');
    expect((await versions.listRevisions(P, feature.workspaceId)).total).toBe(1);
    expect((await branches.unarchiveBranch(P, feature.id)).state).toBe('active');
  });

  it('will not archive the default branch or the one in use', async () => {
    const { branches, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    expect((await failure(branches.archiveBranch(P, main.id))).code).toBe(
      'VERSION_BRANCH_NOT_DELETABLE',
    );
    await branches.switchBranch(P, feature.id);
    expect((await failure(branches.archiveBranch(P, feature.id))).code).toBe(
      'VERSION_BRANCH_NOT_DELETABLE',
    );
  });

  it('deletes only the name: the files and revisions are kept', async () => {
    const { branches, workspaces, versions, main } = await started();
    const feature = await branches.createBranch({
      projectId: P,
      name: 'feature',
      fromBranchId: main.id,
    });
    await branches.deleteBranch(P, feature.id);
    expect((await branches.listBranches(P, { includeArchived: true })).map((b) => b.name)).toEqual([
      'main',
    ]);
    expect(workspaces.read(feature.workspaceId, 'src/app.ts')).toBe('v1');
    expect((await versions.listRevisions(P, feature.workspaceId)).total).toBe(1);
  });

  it('refuses to delete the default branch, the active one, or a parent of another', async () => {
    const { branches, main } = await started();
    const a = await branches.createBranch({ projectId: P, name: 'a', fromBranchId: main.id });
    const child = await branches.createBranch({ projectId: P, name: 'child', fromBranchId: a.id });
    expect((await branches.deletability(P, main.id)).deletable).toBe(false);
    const parent = await branches.deletability(P, a.id);
    expect(parent.deletable).toBe(false);
    expect(parent.reason).toContain('child');
    expect((await failure(branches.deleteBranch(P, a.id))).code).toBe(
      'VERSION_BRANCH_NOT_DELETABLE',
    );
    await branches.switchBranch(P, child.id);
    expect((await branches.deletability(P, child.id)).deletable).toBe(false);
  });

  it('refuses every change to a branch of another project', async () => {
    const { branches, workspaces } = await started();
    const otherWs = workspaces.addWorkspace('proj-2', { 'x.ts': 'x' });
    const other = await branches.adoptWorkspace({ projectId: 'proj-2', workspaceId: otherWs });
    for (const work of [
      branches.renameBranch(P, other.id, 'mine'),
      branches.archiveBranch(P, other.id),
      branches.deleteBranch(P, other.id),
      branches.getBranch(P, other.id),
    ]) {
      expect((await failure(work)).code).toBe('VERSION_BRANCH_NOT_FOUND');
    }
    expect((await branches.getBranch('proj-2', other.id)).name).toBe('main');
  });
});

describe('concurrent changes', () => {
  it('lets only one of two simultaneous creations take the same name', async () => {
    const { branches, main } = await started();
    const results = await Promise.allSettled([
      branches.createBranch({ projectId: P, name: 'race', fromBranchId: main.id }),
      branches.createBranch({ projectId: P, name: 'race', fromBranchId: main.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await branches.listBranches(P)).filter((b) => b.name === 'race')).toHaveLength(1);
  });

  it('keeps the limit when many creations arrive at once', async () => {
    const { branches, main } = await started();
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        branches.createBranch({ projectId: P, name: `n${i}`, fromBranchId: main.id }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(24);
    expect(await branches.listBranches(P)).toHaveLength(25);
  });
});
