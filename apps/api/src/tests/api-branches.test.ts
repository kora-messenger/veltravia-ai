import { describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';

/**
 * Step 38: branches, history and selective restore over the HTTP surface, on
 * the real Project Engine. Offline and deterministic.
 */

type App = ReturnType<typeof buildApp>;

interface BranchView {
  id: string;
  name: string;
  state: 'active' | 'archived';
  isDefault: boolean;
  isActive: boolean;
  workspaceId: string;
  parentBranchId: string | null;
}

async function seed(app: App, name = 'Branch Fixture') {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, projectType: 'web', description: 'Branch tests.' },
  });
  const projectId = project.json().id as string;
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    payload: { name: 'main' },
  });
  const workspaceId = workspace.json().id as string;
  for (const [path, content] of Object.entries({ 'a.txt': 'one', 'b.txt': 'two' })) {
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path, content },
    });
  }
  // The first revision is what a branch is created from.
  const captured = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/revisions`,
    payload: { workspaceId, message: 'start' },
  });
  expect(captured.statusCode).toBeLessThan(300);
  return { projectId, workspaceId };
}

async function listBranches(app: App, projectId: string, includeArchived = false) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/branches${includeArchived ? '?includeArchived=true' : ''}`,
  });
  return res.json() as { branches: BranchView[]; activeBranchId: string | null };
}

async function createBranch(app: App, projectId: string, name: string, extra = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/branches`,
    payload: { name, ...extra },
  });
}

async function readFile(app: App, workspaceId: string, path: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/workspaces/${workspaceId}/files/${path}`,
  });
  return res.statusCode === 200 ? (res.json() as { content: string }).content : null;
}

async function edit(app: App, workspaceId: string, path: string, content: string) {
  const read = await app.inject({
    method: 'GET',
    url: `/api/workspaces/${workspaceId}/files/${path}`,
  });
  const revision = (read.json() as { node: { revision: number } }).node.revision;
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/workspaces/${workspaceId}/files/${path}`,
    payload: { content, expectedRevision: revision },
  });
  expect(res.statusCode).toBe(200);
}

describe('branch lifecycle', () => {
  it('adopts the existing workspace as the default branch on first read', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app);
    const { branches, activeBranchId } = await listBranches(app, projectId);
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ name: 'main', isDefault: true, isActive: true });
    expect(branches[0]?.workspaceId).toBe(workspaceId);
    expect(activeBranchId).toBe(branches[0]?.id);
  });

  it('creates a branch with its own workspace holding a copy of the files', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app);
    const res = await createBranch(app, projectId, 'feature', { description: 'try login' });
    expect(res.statusCode).toBe(201);
    const branch = (res.json() as { branch: BranchView }).branch;
    expect(branch.workspaceId).not.toBe(workspaceId);
    expect(branch.isDefault).toBe(false);
    expect(await readFile(app, branch.workspaceId, 'a.txt')).toBe('one');
    expect(await readFile(app, branch.workspaceId, 'b.txt')).toBe('two');
  });

  it('keeps the two branches isolated in both directions', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app);
    const feature = (
      (await createBranch(app, projectId, 'feature')).json() as { branch: BranchView }
    ).branch;

    await edit(app, feature.workspaceId, 'a.txt', 'changed on feature');
    expect(await readFile(app, workspaceId, 'a.txt')).toBe('one');

    await edit(app, workspaceId, 'b.txt', 'changed on main');
    expect(await readFile(app, feature.workspaceId, 'b.txt')).toBe('two');
  });

  it('switching moves the pointer and writes nothing', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app);
    const feature = (
      (await createBranch(app, projectId, 'feature')).json() as { branch: BranchView }
    ).branch;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/branches/${feature.id}/switch`,
    });
    expect(res.statusCode).toBe(200);
    const after = await listBranches(app, projectId);
    expect(after.activeBranchId).toBe(feature.id);
    expect(after.branches.find((b) => b.id === feature.id)?.isActive).toBe(true);
    expect(await readFile(app, workspaceId, 'a.txt')).toBe('one');
  });

  it('renames a branch and refuses a name that is taken, ignoring case', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const a = ((await createBranch(app, projectId, 'alpha')).json() as { branch: BranchView })
      .branch;
    await createBranch(app, projectId, 'beta');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/branches/${a.id}`,
      payload: { name: 'alpha-two' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { branch: BranchView }).branch.name).toBe('alpha-two');

    const clash = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/branches/${a.id}`,
      payload: { name: 'BETA' },
    });
    expect(clash.statusCode).toBe(409);
    expect((clash.json() as { error: { code: string } }).error.code).toBe(
      'VERSION_BRANCH_NAME_TAKEN',
    );
  });

  it('archives and restores a branch without losing its files', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const f = ((await createBranch(app, projectId, 'feature')).json() as { branch: BranchView })
      .branch;

    const archived = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/branches/${f.id}/archive`,
    });
    expect(archived.statusCode).toBe(200);
    expect((await listBranches(app, projectId)).branches.map((b) => b.name)).toEqual(['main']);
    expect((await listBranches(app, projectId, true)).branches).toHaveLength(2);
    expect(await readFile(app, f.workspaceId, 'a.txt')).toBe('one');

    const back = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/branches/${f.id}/unarchive`,
    });
    expect((back.json() as { branch: BranchView }).branch.state).toBe('active');
  });

  it('refuses to archive or delete the default branch and the one in use', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const { branches } = await listBranches(app, projectId);
    const main = branches[0]!;
    const f = ((await createBranch(app, projectId, 'feature')).json() as { branch: BranchView })
      .branch;

    for (const method of ['POST', 'DELETE'] as const) {
      const url =
        method === 'POST'
          ? `/api/projects/${projectId}/branches/${main.id}/archive`
          : `/api/projects/${projectId}/branches/${main.id}`;
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'VERSION_BRANCH_NOT_DELETABLE',
      );
    }

    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/branches/${f.id}/switch` });
    const inUse = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/branches/${f.id}`,
    });
    expect(inUse.statusCode).toBe(409);
  });

  it('deletes a branch name but leaves its workspace and files', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const f = ((await createBranch(app, projectId, 'feature')).json() as { branch: BranchView })
      .branch;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/branches/${f.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect((await listBranches(app, projectId, true)).branches.map((b) => b.name)).toEqual([
      'main',
    ]);
    expect(await readFile(app, f.workspaceId, 'a.txt')).toBe('one');
  });

  it('explains in the detail why a branch cannot be deleted', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const parent = ((await createBranch(app, projectId, 'parent')).json() as { branch: BranchView })
      .branch;
    await createBranch(app, projectId, 'child', { fromBranchId: parent.id });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/branches/${parent.id}`,
    });
    const body = res.json() as { deletable: boolean; deleteBlockedReason: string };
    expect(body.deletable).toBe(false);
    expect(body.deleteBlockedReason).toContain('child');
  });
});

describe('branch validation', () => {
  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(65)],
    ['newline', 'bad\nname'],
  ])('rejects a %s name', async (_label, name) => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const res = await createBranch(app, projectId, name);
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown fields', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const res = await createBranch(app, projectId, 'ok', { isDefault: true });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a duplicate name', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    await createBranch(app, projectId, 'feature');
    const res = await createBranch(app, projectId, 'Feature');
    expect(res.statusCode).toBe(409);
  });

  it('rejects a name that looks like a secret', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const res = await createBranch(app, projectId, 'sk-abcdefghijklmnopqrstuvwx1234567890');
    expect(res.statusCode).toBe(422);
  });
});

describe('ownership', () => {
  it('reports a branch of another project as not found', async () => {
    const app = buildApp();
    const mine = await seed(app, 'Mine');
    const theirs = await seed(app, 'Theirs');
    const theirBranch = (
      (await createBranch(app, theirs.projectId, 'secret-work')).json() as {
        branch: BranchView;
      }
    ).branch;

    for (const [method, suffix] of [
      ['GET', ''],
      ['POST', '/switch'],
      ['POST', '/archive'],
      ['GET', '/history'],
      ['DELETE', ''],
    ] as const) {
      const res = await app.inject({
        method,
        url: `/api/projects/${mine.projectId}/branches/${theirBranch.id}${suffix}`,
      });
      expect(res.statusCode, `${method} ${suffix}`).toBe(404);
    }
    // And the rename did nothing to it.
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${mine.projectId}/branches/${theirBranch.id}`,
      payload: { name: 'hijacked' },
    });
    expect(rename.statusCode).toBe(404);
    expect(
      (await listBranches(app, theirs.projectId)).branches.find((b) => b.id === theirBranch.id)
        ?.name,
    ).toBe('secret-work');
  });

  it('refuses to create a branch from another project\u2019s branch', async () => {
    const app = buildApp();
    const mine = await seed(app, 'Mine');
    const theirs = await seed(app, 'Theirs');
    const { branches } = await listBranches(app, theirs.projectId);
    const res = await createBranch(app, mine.projectId, 'steal', { fromBranchId: branches[0]!.id });
    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for a project that does not exist', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/nope/branches' });
    expect(res.statusCode).toBe(404);
  });
});

describe('history', () => {
  it('lists a branch\u2019s own revisions with author, change type and counts', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const f = ((await createBranch(app, projectId, 'feature')).json() as { branch: BranchView })
      .branch;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/branches/${f.id}/history`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      branch: { name: string };
      entries: { branchName: string; changeType: string; actor: string; description: string }[];
    };
    expect(body.branch.name).toBe('feature');
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      branchName: 'feature',
      changeType: 'branch',
      actor: 'user',
    });
    expect(body.entries[0]?.description).toContain('created from "main"');
  });

  it('keeps each branch\u2019s history separate', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app);
    const f = ((await createBranch(app, projectId, 'feature')).json() as { branch: BranchView })
      .branch;
    await edit(app, workspaceId, 'a.txt', 'main moved on');
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/revisions`,
      payload: { workspaceId, message: 'main change' },
    });
    const main = (await listBranches(app, projectId)).branches.find((b) => b.isDefault)!;
    const mainHistory = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/branches/${main.id}/history`,
      })
    ).json() as { total: number };
    const featureHistory = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/branches/${f.id}/history`,
      })
    ).json() as { total: number };
    expect(mainHistory.total).toBe(2);
    expect(featureHistory.total).toBe(1);
  });
});

describe('automatic checkpoint policy', () => {
  const evaluate = (app: App, projectId: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/checkpoint-policy/evaluate`,
      payload,
    });

  it('declines a small change and takes one for a large one', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    const small = (await evaluate(app, projectId, { filesAffected: 1 })).json() as {
      decision: { take: boolean };
    };
    const big = (await evaluate(app, projectId, { filesAffected: 6 })).json() as {
      decision: { take: boolean; trigger: string };
    };
    expect(small.decision.take).toBe(false);
    expect(big.decision).toMatchObject({ take: true, trigger: 'before_ai_change' });
  });

  it('validates its input', async () => {
    const app = buildApp();
    const { projectId } = await seed(app);
    expect((await evaluate(app, projectId, { filesAffected: -1 })).statusCode).toBe(400);
    expect((await evaluate(app, projectId, {})).statusCode).toBe(400);
  });
});

describe('selective restore through the confirmation gate', () => {
  async function setup() {
    const app = buildApp();
    const { projectId, workspaceId } = await seed(app);
    const firstRevision = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/revisions?workspaceId=${workspaceId}`,
      })
    ).json() as { revisions: { id: string }[] };
    const first = firstRevision.revisions[0]!.id;
    await edit(app, workspaceId, 'a.txt', 'a-edited');
    await edit(app, workspaceId, 'b.txt', 'b-edited');
    // A later revision, so the first one is a past state and not the latest.
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/revisions`,
      payload: { workspaceId, message: 'after edits' },
    });
    const ws = (
      await app.inject({ method: 'GET', url: `/api/projects/${projectId}/workspaces` })
    ).json() as {
      workspaces: { id: string; revision: number }[];
    };
    const current = ws.workspaces.find((w) => w.id === workspaceId)!.revision;
    return { app, projectId, workspaceId, first, current };
  }

  it('waits for approval, shows which files, then restores only those', async () => {
    const { app, projectId, workspaceId, first, current } = await setup();
    const open = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: first,
        expectedCurrentRevision: current,
        paths: ['a.txt'],
      },
    });
    expect(open.statusCode).toBe(202);
    const opened = open.json() as {
      operation: { id: string; request: { paths: string[] | null } };
      validation: { filesChanged: number };
    };
    expect(opened.operation.request.paths).toEqual(['a.txt']);
    expect(opened.validation.filesChanged).toBe(1);
    // Nothing has been restored yet.
    expect(await readFile(app, workspaceId, 'a.txt')).toBe('a-edited');

    const approve = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback/${opened.operation.id}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as { state: string }).state).toBe('completed');
    expect(await readFile(app, workspaceId, 'a.txt')).toBe('one');
    expect(await readFile(app, workspaceId, 'b.txt')).toBe('b-edited');
  });

  it('restores nothing when the person rejects', async () => {
    const { app, projectId, workspaceId, first, current } = await setup();
    const opened = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/rollback`,
        payload: {
          workspaceId,
          targetRevisionId: first,
          expectedCurrentRevision: current,
          paths: ['a.txt'],
        },
      })
    ).json() as { operation: { id: string } };
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback/${opened.operation.id}/confirmation`,
      payload: { decision: 'reject' },
    });
    expect(await readFile(app, workspaceId, 'a.txt')).toBe('a-edited');
  });

  it('refuses a stale expected revision before asking anyone', async () => {
    const { app, projectId, workspaceId, first, current } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: first,
        expectedCurrentRevision: current - 1,
        paths: ['a.txt'],
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it.each([['../etc/passwd'], ['a//b'], ['/'], ['x\\y']])('refuses the path %j', async (path) => {
    const { app, projectId, workspaceId, first, current } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: first,
        expectedCurrentRevision: current,
        paths: [path],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(await readFile(app, workspaceId, 'a.txt')).toBe('a-edited');
  });

  it('refuses an empty path list', async () => {
    const { app, projectId, workspaceId, first, current } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId,
        targetRevisionId: first,
        expectedCurrentRevision: current,
        paths: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('cannot be used against another project\u2019s workspace', async () => {
    const { app, projectId, first, current } = await setup();
    const other = await seed(app, 'Other');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      payload: {
        workspaceId: other.workspaceId,
        targetRevisionId: first,
        expectedCurrentRevision: current,
        paths: ['a.txt'],
      },
    });
    expect([403, 404]).toContain(res.statusCode);
    expect(await readFile(app, other.workspaceId, 'a.txt')).toBe('one');
  });
});
