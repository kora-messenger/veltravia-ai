import { describe, expect, it } from 'vitest';

import type { ProjectRevision, RevisionSnapshot } from '@veltravia/version-core';

import { InMemoryRevisionStore } from './index.js';

function revision(
  id: string,
  projectId: string,
  workspaceId: string,
  revisionNumber: number,
): ProjectRevision {
  return {
    id,
    projectId,
    workspaceId,
    revisionNumber,
    parentRevisionId: null,
    createdAt: `2026-01-0${(revisionNumber % 9) + 1}T00:00:00.000Z`,
    createdBy: 'test',
    source: 'manual',
    status: 'active',
    change: { added: 1, modified: 0, deleted: 0, total: 1 },
    fileCount: 1,
    totalBytes: 10,
    manifestHash: `hash-${id}`,
    message: null,
    restoredFromRevisionId: null,
  };
}

function snapshot(revisionId: string, projectId: string, workspaceId: string): RevisionSnapshot {
  return {
    revisionId,
    projectId,
    workspaceId,
    manifestHash: `hash-${revisionId}`,
    nodes: [
      {
        path: 'a.txt',
        type: 'file',
        size: 10,
        contentHash: `content-${revisionId}`,
        content: '0123456789',
      },
    ],
    capturedAt: '2026-01-01T00:00:00.000Z',
    totalBytes: 10,
  };
}

describe('InMemoryRevisionStore', () => {
  it('stores and returns revisions newest-first', async () => {
    const store = new InMemoryRevisionStore();
    await store.createRevision(revision('r1', 'p1', 'w1', 1), snapshot('r1', 'p1', 'w1'));
    await store.createRevision(revision('r2', 'p1', 'w1', 2), snapshot('r2', 'p1', 'w1'));
    const page = await store.listRevisions({
      projectId: 'p1',
      workspaceId: 'w1',
      limit: 10,
      skip: 0,
    });
    expect(page.total).toBe(2);
    expect(page.revisions.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect((await store.getLatestRevision('p1', 'w1'))?.id).toBe('r2');
  });

  it('isolates workspaces and projects', async () => {
    const store = new InMemoryRevisionStore();
    await store.createRevision(revision('r1', 'p1', 'w1', 1), snapshot('r1', 'p1', 'w1'));
    const other = await store.listRevisions({
      projectId: 'p1',
      workspaceId: 'w2',
      limit: 10,
      skip: 0,
    });
    expect(other.total).toBe(0);
    const foreign = await store.listRevisions({
      projectId: 'p2',
      workspaceId: 'w1',
      limit: 10,
      skip: 0,
    });
    expect(foreign.total).toBe(0);
  });

  it('deletes revisions and their snapshots together', async () => {
    const store = new InMemoryRevisionStore();
    await store.createRevision(revision('r1', 'p1', 'w1', 1), snapshot('r1', 'p1', 'w1'));
    await store.deleteRevision('r1');
    expect(await store.getRevision('r1')).toBeNull();
    expect(await store.getSnapshot('r1')).toBeNull();
  });

  it('paginates', async () => {
    const store = new InMemoryRevisionStore();
    for (let index = 1; index <= 5; index += 1) {
      await store.createRevision(
        revision(`r${index}`, 'p1', 'w1', index),
        snapshot(`r${index}`, 'p1', 'w1'),
      );
    }
    const page = await store.listRevisions({
      projectId: 'p1',
      workspaceId: 'w1',
      limit: 2,
      skip: 2,
    });
    expect(page.hasMore).toBe(true);
    expect(page.revisions.map((r) => r.id)).toEqual(['r3', 'r2']);
  });

  it('retention candidates come back oldest-first', async () => {
    const store = new InMemoryRevisionStore();
    for (let index = 1; index <= 3; index += 1) {
      await store.createRevision(
        revision(`r${index}`, 'p1', 'w1', index),
        snapshot(`r${index}`, 'p1', 'w1'),
      );
    }
    const candidates = await store.listRetentionCandidates('p1', 'w1');
    expect(candidates.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });
});
