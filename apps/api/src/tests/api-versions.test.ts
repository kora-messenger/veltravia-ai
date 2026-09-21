import { describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';

/**
 * Step 18: version control over the API. The HTTP surface is
 * project-scoped; revisions are METADATA ONLY in list/detail responses;
 * diffs are bounded; checkpoints are named markers; and rollback executes
 * ONLY through the Tool System with a human confirmation bound to the
 * exact input, always creating a NEW revision.
 */

type App = ReturnType<typeof buildApp>;

interface RevisionView {
  id: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  source: string;
  status: string;
  change: { added: number; modified: number; deleted: number; total: number };
  fileCount: number;
  manifestHash: string;
  message: string | null;
  restoredFromRevisionId: string | null;
  checkpointRefs: { id: string; name: string }[];
}

async function seed(
  app: App,
  files: readonly { path: string; content: string }[],
): Promise<{ projectId: string; workspaceId: string }> {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Version Fixture',
      projectType: 'web',
      description: 'A demo project for version control tests.',
    },
  });
  const projectId = project.json().id as string;
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    payload: { name: 'main' },
  });
  const workspaceId = workspace.json().id as string;
  for (const file of files) {
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path: file.path, content: file.content },
    });
  }
  return { projectId, workspaceId };
}

async function write(app: App, workspaceId: string, path: string, content: string): Promise<void> {
  // Create first; fall back to an update using the CURRENT node revision
  // read from the engine (optimistic concurrency is the tree's rule).
  const create = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/files`,
    payload: { path, content },
  });
  if (create.statusCode === 201 || create.statusCode === 200) return;
  const read = await app.inject({
    method: 'GET',
    url: `/api/workspaces/${workspaceId}/files/${path}`,
  });
  if (read.statusCode !== 200) throw new Error(`read ${path} failed: ${read.body}`);
  const revision = (read.json() as { node: { revision: number } }).node.revision;
  const update = await app.inject({
    method: 'PATCH',
    url: `/api/workspaces/${workspaceId}/files/${path}`,
    payload: { content, expectedRevision: revision },
  });
  if (update.statusCode !== 200) throw new Error(`update ${path} failed: ${update.body}`);
}

async function capture(
  app: App,
  projectId: string,
  workspaceId: string,
  message?: string,
): Promise<RevisionView> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/revisions`,
    payload: { workspaceId, ...(message !== undefined ? { message } : {}) },
  });
  if (response.statusCode !== 201) throw new Error(`capture failed: ${response.body}`);
  return response.json() as RevisionView;
}

async function workspaceRevision(
  app: App,
  projectId: string,
  workspaceId: string,
): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/workspaces`,
  });
  const workspaces =
    (response.json() as { workspaces: { id: string; revision: number }[] }).workspaces ?? [];
  const match = workspaces.find((workspace) => workspace.id === workspaceId);
  if (match === undefined) throw new Error('workspace not listed');
  return match.revision;
}

describe('version API: revisions', () => {
  it('captures revisions with honest change counts and lineage', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app, [{ path: 'a.txt', content: 'alpha' }]);
    const first = await capture(app, projectId, workspaceId, 'v1');
    expect(first.change).toEqual({ added: 1, modified: 0, deleted: 0, total: 1 });
    await write(app, workspaceId, 'a.txt', 'alpha-two');
    const second = await capture(app, projectId, workspaceId, 'v2');
    expect(second.parentRevisionId).toBe(first.id);
    expect(second.change).toEqual({ added: 0, modified: 1, deleted: 0, total: 1 });

    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/revisions?workspaceId=${workspaceId}`,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { revisions: RevisionView[]; total: number; hasMore: boolean };
    expect(body.total).toBe(2);
    expect(body.revisions[0].id).toBe(second.id);
    // Metadata only: no file contents anywhere in the response.
    expect(JSON.stringify(body)).not.toContain('alpha-two');
  });

  it('rejects unknown projects, workspaces, and foreign access', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app, [{ path: 'a.txt', content: 'a' }]);
    const revision = await capture(app, projectId, workspaceId);
    await expect(
      app.inject({ method: 'GET', url: '/api/projects/missing/revisions?workspaceId=x' }),
    ).resolves.toMatchObject({ statusCode: 404 });
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/revisions/${revision.id}?workspaceId=other-ws`,
    });
    expect(foreign.statusCode).toBe(403);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/revisions/missing?workspaceId=${workspaceId}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('produces bounded diffs against the parent revision', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app, [
      { path: 'keep.txt', content: 'line1\n' },
      { path: 'del.txt', content: 'gone\n' },
    ]);
    await capture(app, projectId, workspaceId);
    await write(app, workspaceId, 'keep.txt', 'line1\nline2\n');
    await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/files/del.txt`,
    });
    const second = await capture(app, projectId, workspaceId);
    const diff = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/revisions/${second.id}/diff?workspaceId=${workspaceId}`,
    });
    expect(diff.statusCode).toBe(200);
    const comparison = diff.json() as {
      added: number;
      modified: number;
      deleted: number;
      files: { path: string; kind: string; lines: { kind: string; text: string }[] }[];
    };
    expect(comparison.modified).toBe(1);
    expect(comparison.deleted).toBe(1);
    const keep = comparison.files.find((file) => file.path === 'keep.txt');
    expect(keep?.lines.some((line) => line.kind === 'add' && line.text === 'line2')).toBe(true);
  });

  it('compares two revisions explicitly', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app, [{ path: 'a.txt', content: 'one' }]);
    const first = await capture(app, projectId, workspaceId);
    await write(app, workspaceId, 'a.txt', 'two');
    const second = await capture(app, projectId, workspaceId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/revisions/compare?workspaceId=${workspaceId}&from=${first.id}&to=${second.id}`,
    });
    expect(response.statusCode).toBe(200);
    const comparison = response.json() as { modified: number; unchanged: number };
    expect(comparison.modified).toBe(1);
    expect(comparison.unchanged).toBe(0);
  });
});

describe('version API: checkpoints', () => {
  it('creates, lists, and deletes named checkpoints', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app, [{ path: 'a.txt', content: 'a' }]);
    const revision = await capture(app, projectId, workspaceId);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/checkpoints`,
      payload: { workspaceId, name: 'Stable Release', revisionId: revision.id },
    });
    expect(create.statusCode).toBe(201);
    const checkpoint = create.json() as { id: string; revision: { id: string } };
    expect(checkpoint.revision.id).toBe(revision.id);

    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/checkpoints?workspaceId=${workspaceId}`,
    });
    expect((list.json() as { checkpoints: unknown[] }).checkpoints).toHaveLength(1);

    const after = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/revisions/${revision.id}?workspaceId=${workspaceId}`,
    });
    const view = after.json() as RevisionView;
    expect(view.checkpointRefs).toHaveLength(1);
    expect(view.checkpointRefs[0].name).toBe('Stable Release');

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/checkpoints/${checkpoint.id}?workspaceId=${workspaceId}`,
    });
    expect(remove.statusCode).toBe(204);
  });

  it('captures a fresh revision when none is pinned', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app, [{ path: 'a.txt', content: 'a' }]);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/checkpoints`,
      payload: { workspaceId, name: 'now' },
    });
    expect(create.statusCode).toBe(201);
    const checkpoint = create.json() as { revision: { id: string } };
    expect(typeof checkpoint.revision.id).toBe('string');
  });
});

describe('version API: rollback (Tool-System-gated)', () => {
  async function seeded(
    app: App,
  ): Promise<{ projectId: string; workspaceId: string; firstRevisionId: string }> {
    const { projectId, workspaceId } = await seed(app, [{ path: 'a.txt', content: 'one' }]);
    const first = await capture(app, projectId, workspaceId, 'v1');
    await write(app, workspaceId, 'a.txt', 'two');
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path: 'extra.txt', content: 'extra' },
    });
    await capture(app, projectId, workspaceId, 'v2');
    return { projectId, workspaceId, firstRevisionId: first.id };
  }

  it('pauses for human confirmation, then restores by creating a NEW revision', async () => {
    const app = buildApp();
    const { projectId, workspaceId, firstRevisionId } = await seeded(app);
    const current = await workspaceRevision(app, projectId, workspaceId);

    const open = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: firstRevisionId,
        expectedCurrentRevision: current,
        reason: 'undo experiment',
      },
    });
    expect(open.statusCode).toBe(202);
    const openBody = open.json() as {
      operation: { id: string; state: string };
      confirmationId: string;
      validation: { filesChanged: number };
    };
    expect(openBody.operation.state).toBe('pending_confirmation');
    expect(typeof openBody.confirmationId).toBe('string');
    expect(openBody.validation.filesChanged).toBeGreaterThan(0);

    // Nothing restored yet: 'extra.txt' still exists.
    const before = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/files/extra.txt`,
    });
    expect(before.statusCode).toBe(200);

    const approve = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback/${openBody.operation.id}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(approve.statusCode).toBe(200);
    const approved = approve.json() as {
      state: string;
      result: { newRevisionId: string; restoredFromRevisionId: string; filesChanged: number };
    };
    expect(approved.state).toBe('completed');
    expect(approved.result.restoredFromRevisionId).toBe(firstRevisionId);

    // The tree matches the first revision: extra.txt is gone, a.txt is 'one'.
    const file = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/files/a.txt`,
    });
    expect(file.statusCode).toBe(200);
    expect((file.json() as { content: string }).content).toBe('one');
    const extra = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/files/extra.txt`,
    });
    expect(extra.statusCode).toBe(404);

    // History intact: 2 captures + 1 rollback revision.
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/revisions?workspaceId=${workspaceId}`,
    });
    const body = list.json() as { revisions: RevisionView[]; total: number };
    expect(body.total).toBe(3);
    expect(body.revisions[0].source).toBe('rollback');
    expect(body.revisions[0].restoredFromRevisionId).toBe(firstRevisionId);
  });

  it('rejects the confirmation and restores nothing', async () => {
    const app = buildApp();
    const { projectId, workspaceId, firstRevisionId } = await seeded(app);
    const current = await workspaceRevision(app, projectId, workspaceId);
    const open = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: firstRevisionId,
        expectedCurrentRevision: current,
      },
    });
    const operationId = (open.json() as { operation: { id: string } }).operation.id;
    const reject = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback/${operationId}/confirmation`,
      payload: { decision: 'reject' },
    });
    expect(reject.statusCode).toBe(200);
    expect((reject.json() as { state: string }).state).toBe('rejected');
    const extra = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/files/extra.txt`,
    });
    expect(extra.statusCode).toBe(200);
  });

  it('refuses an unknown rollback target with a typed 404', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app, [{ path: 'a.txt', content: 'one' }]);
    await capture(app, projectId, workspaceId);
    const current = await workspaceRevision(app, projectId, workspaceId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: 'missing-revision',
        expectedCurrentRevision: current,
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a rollback with a stale expected revision (409)', async () => {
    const app = buildApp();
    const { projectId, workspaceId, firstRevisionId } = await seeded(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: firstRevisionId,
        expectedCurrentRevision: 1,
      },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('VERSION_REVISION_CONFLICT');
  });

  it('refuses deciding an already-resolved operation', async () => {
    const app = buildApp();
    const { projectId, workspaceId, firstRevisionId } = await seeded(app);
    const current = await workspaceRevision(app, projectId, workspaceId);
    const open = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: firstRevisionId,
        expectedCurrentRevision: current,
      },
    });
    const operationId = (open.json() as { operation: { id: string } }).operation.id;
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback/${operationId}/confirmation`,
      payload: { decision: 'reject' },
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback/${operationId}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(replay.statusCode).toBe(409);
  });
});
