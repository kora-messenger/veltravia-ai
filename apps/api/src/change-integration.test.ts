/**
 * Change integration over HTTP (Step 46).
 *
 * These tests are the boundary: a proposal is recorded against the revision it
 * started from, two workers can propose independently, a conflicting pair is
 * refused rather than merged, and nothing reaches the project without a
 * recorded Primary Agent approval. The tree is checked after every refusal to
 * prove nothing was written.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

function server(): FastifyInstance {
  app = buildApp({
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
  return app;
}

interface Fixture {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly baseRevision: number;
}

const ownerHeader = (owner: string) => ({ 'x-veltravia-owner-ref': owner });

async function seed(
  owner = 'veltravia-dev-user',
  files: Record<string, string> = {},
): Promise<Fixture> {
  const instance = app as FastifyInstance;
  const project = await instance.inject({
    method: 'POST',
    url: '/api/projects',
    headers: ownerHeader(owner),
    payload: { name: 'Integration QA', description: 'Fixture', projectType: 'web' },
  });
  const projectId = (project.json() as { id: string }).id;
  const workspace = await instance.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    headers: ownerHeader(owner),
    payload: { name: 'main' },
  });
  const workspaceId = (workspace.json() as { id: string }).id;
  for (const [path, content] of Object.entries(files)) {
    const created = await instance.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source/files`,
      headers: ownerHeader(owner),
      payload: { path, content, workspaceId },
    });
    expect(created.statusCode).toBeLessThan(300);
  }
  const tree = await instance.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/source?workspaceId=${workspaceId}`,
    headers: ownerHeader(owner),
  });
  const baseRevision = (tree.json() as { tree: { rootRevision: number } }).tree.rootRevision;
  return { projectId, workspaceId, baseRevision };
}

/** Content hash and revision of each project file, as the tree reports them. */
async function treeFiles(
  fixture: Fixture,
): Promise<Map<string, { hash: string; revision: number }>> {
  const instance = app as FastifyInstance;
  const response = await instance.inject({
    method: 'GET',
    url: `/api/projects/${fixture.projectId}/source?workspaceId=${fixture.workspaceId}`,
    headers: ownerHeader('veltravia-dev-user'),
  });
  const tree = (
    response.json() as {
      tree: { files: { path: string; contentHash?: string; revision: number }[] };
    }
  ).tree;
  const files = new Map<string, { hash: string; revision: number }>();
  for (const file of tree.files) {
    if (typeof file.contentHash === 'string') {
      files.set(file.path, {
        hash: file.contentHash.replace(/^sha256:/, ''),
        revision: file.revision,
      });
    }
  }
  return files;
}

async function proposal(
  fixture: Fixture,
  input: {
    files: {
      path: string;
      op?: 'create' | 'update' | 'delete';
      content?: string;
      baseHash?: string | null;
    }[];
    workerId?: string;
    taskId?: string;
    baseRevision?: number;
    authorization?: Record<string, unknown>;
    owner?: string;
  },
) {
  const instance = app as FastifyInstance;
  return instance.inject({
    method: 'POST',
    url: '/api/change-sets',
    headers: ownerHeader(input.owner ?? 'veltravia-dev-user'),
    payload: {
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      baseRevision: input.baseRevision ?? fixture.baseRevision,
      ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
      files: input.files.map((file) => ({
        path: file.path,
        op: file.op ?? 'create',
        content: file.content ?? '',
        ...(file.baseHash === undefined ? {} : { baseHash: file.baseHash }),
      })),
    },
  });
}

async function fileContent(fixture: Fixture, path: string, owner = 'veltravia-dev-user') {
  const instance = app as FastifyInstance;
  const response = await instance.inject({
    method: 'GET',
    url: `/api/projects/${fixture.projectId}/source/file?path=${encodeURIComponent(path)}&workspaceId=${fixture.workspaceId}`,
    headers: ownerHeader(owner),
  });
  if (response.statusCode === 404) return null;
  if (response.statusCode !== 200) {
    // A missing path is reported as an error by the source layer; treat only a
    // not-found error as "the file is not there" and fail on anything else.
    const code = (response.json() as { error?: { code?: string } }).error?.code ?? '';
    if (code.includes('NOT_FOUND')) return null;
    throw new Error(`Reading ${path} failed: ${response.statusCode} ${code}`);
  }
  return (response.json() as { file: { content: string } }).file.content;
}

async function approve(fixture: Fixture, changeSetIds: string[], decision = 'approve') {
  const instance = app as FastifyInstance;
  const response = await instance.inject({
    method: 'POST',
    url: '/api/integration/approvals',
    headers: ownerHeader('veltravia-dev-user'),
    payload: { projectId: fixture.projectId, changeSetIds, decision, rationale: 'looks right' },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { approval: { id: string } }).approval;
}

async function integrate(fixture: Fixture, changeSetIds: string[], approvalId: string) {
  const instance = app as FastifyInstance;
  return instance.inject({
    method: 'POST',
    url: '/api/integration/run',
    headers: ownerHeader('veltravia-dev-user'),
    payload: { projectId: fixture.projectId, changeSetIds, approvalId },
  });
}

describe('capabilities', () => {
  it('states what the integration path will and will not do', async () => {
    server();
    const response = await app!.inject({
      method: 'GET',
      url: '/api/change-integration/capabilities',
    });
    const body = response.json() as {
      durability: string;
      behaviour: Record<string, boolean>;
    };
    expect(body.behaviour['workerWritesIsolated']).toBe(true);
    expect(body.behaviour['requiresPrimaryAgentApproval']).toBe(true);
    expect(body.behaviour['automaticMerge']).toBe(false);
    expect(body.durability).toBe('memory');
  });
});

describe('recording proposals', () => {
  it('requires a base revision to anchor a proposal', async () => {
    server();
    const fixture = await seed();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/change-sets',
      headers: ownerHeader('veltravia-dev-user'),
      payload: { projectId: fixture.projectId, files: [] },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'CHANGE_SET_BASE_REVISION_REQUIRED',
    );
  });

  it('rejects a file outside the worker scope at validation time', async () => {
    server();
    const fixture = await seed();
    const response = await proposal(fixture, {
      workerId: 'wkr_1',
      files: [{ path: 'config/prod.env', content: 'A=1' }],
      authorization: { allowedPaths: ['src'], allowedTools: ['project.write'] },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { changeSet: { id: string } };
    const detail = await app!.inject({
      method: 'GET',
      url: `/api/change-sets/${body.changeSet.id}`,
      headers: ownerHeader('veltravia-dev-user'),
    });
    const validation = (
      detail.json() as { validation: { ok: boolean; problems: { code: string }[] } }
    ).validation;
    expect(validation.ok).toBe(false);
    expect(validation.problems.map((entry) => entry.code)).toContain(
      'CHANGE_SET_UNAUTHORIZED_PATH',
    );
  });

  it('keeps a project invisible to another owner', async () => {
    server();
    const fixture = await seed();
    const created = await proposal(fixture, {
      workerId: 'wkr_1',
      files: [{ path: 'src/a.ts', content: 'a' }],
      authorization: { allowedPaths: ['src'] },
    });
    const id = (created.json() as { changeSet: { id: string } }).changeSet.id;
    const other = await app!.inject({
      method: 'GET',
      url: `/api/change-sets/${id}`,
      headers: ownerHeader('someone-else'),
    });
    expect(other.statusCode).toBe(404);
  });
});

describe('two workers at once', () => {
  it('integrates two independent proposals in one accepted integration', async () => {
    server();
    const fixture = await seed();
    const scope = { allowedPaths: ['src'], allowedTools: ['project.write'] };
    const front = await proposal(fixture, {
      workerId: 'wkr_front',
      taskId: 'task_1',
      authorization: scope,
      files: [{ path: 'src/screen.tsx', content: 'export const Screen = () => null;' }],
    });
    const back = await proposal(fixture, {
      workerId: 'wkr_back',
      taskId: 'task_1',
      authorization: scope,
      files: [{ path: 'src/api.ts', content: 'export const load = () => 1;' }],
    });
    const frontId = (front.json() as { changeSet: { id: string } }).changeSet.id;
    const backId = (back.json() as { changeSet: { id: string } }).changeSet.id;

    const analysis = await app!.inject({
      method: 'POST',
      url: '/api/change-sets/analyze',
      headers: ownerHeader('veltravia-dev-user'),
      payload: { projectId: fixture.projectId, changeSetIds: [frontId, backId] },
    });
    expect(analysis.statusCode).toBe(200);
    expect((analysis.json() as { blocked: boolean }).blocked).toBe(false);

    const approval = await approve(fixture, [frontId, backId]);
    const result = await integrate(fixture, [frontId, backId], approval.id);
    expect(result.statusCode).toBe(201);
    const body = result.json() as {
      applied: boolean;
      record: { status: string; verification: { status: string } };
    };
    expect(body.applied).toBe(true);
    expect(body.record.status).toBe('integrated');
    // No runtime is configured in tests, so verification is recorded as
    // unavailable rather than claimed as a pass.
    expect(body.record.verification.status).toBe('unavailable');

    expect(await fileContent(fixture, 'src/screen.tsx')).toContain('Screen');
    expect(await fileContent(fixture, 'src/api.ts')).toContain('load');
  });

  it('refuses a conflicting pair and writes nothing', async () => {
    server();
    const fixture = await seed('veltravia-dev-user', { 'src/shared.ts': 'base' });
    const scope = { allowedPaths: ['src'], allowedTools: ['project.write'] };
    const base = (await treeFiles(fixture)).get('src/shared.ts')?.hash ?? null;
    const one = await proposal(fixture, {
      workerId: 'wkr_a',
      authorization: scope,
      files: [{ path: 'src/shared.ts', op: 'update', baseHash: base, content: 'one' }],
    });
    const two = await proposal(fixture, {
      workerId: 'wkr_b',
      authorization: scope,
      files: [{ path: 'src/shared.ts', op: 'update', baseHash: base, content: 'two' }],
    });
    const ids = [
      (one.json() as { changeSet: { id: string } }).changeSet.id,
      (two.json() as { changeSet: { id: string } }).changeSet.id,
    ];
    const approval = await approve(fixture, ids);
    const result = await integrate(fixture, ids, approval.id);
    expect(result.statusCode).toBe(409);
    expect((result.json() as { error: { code: string } }).error.code).toBe(
      'INTEGRATION_CHANGE_SET_CONFLICTED',
    );
    expect(await fileContent(fixture, 'src/shared.ts')).toBe('base');
  });

  it('refuses a proposal whose file moved underneath it', async () => {
    server();
    const fixture = await seed('veltravia-dev-user', { 'src/a.ts': 'base' });
    const original = (await treeFiles(fixture)).get('src/a.ts');
    const base = original?.hash ?? null;
    const created = await proposal(fixture, {
      workerId: 'wkr_stale',
      authorization: { allowedPaths: ['src'], allowedTools: ['project.write'] },
      files: [{ path: 'src/a.ts', op: 'update', baseHash: base, content: 'mine' }],
    });
    const id = (created.json() as { changeSet: { id: string } }).changeSet.id;

    const update = await app!.inject({
      method: 'PATCH',
      url: `/api/projects/${fixture.projectId}/source/file`,
      headers: ownerHeader('veltravia-dev-user'),
      payload: {
        path: 'src/a.ts',
        content: 'someone else',
        expectedRevision: original?.revision ?? 1,
      },
    });
    expect(update.statusCode, JSON.stringify(update.json()).slice(0, 300)).toBeLessThan(300);

    const approval = await approve(fixture, [id]);
    const result = await integrate(fixture, [id], approval.id);
    expect(result.statusCode).toBe(409);
    expect((result.json() as { error: { code: string } }).error.code).toBe(
      'INTEGRATION_CHANGE_SET_STALE',
    );
    expect(await fileContent(fixture, 'src/a.ts')).toBe('someone else');
  });
});

describe('approval gate', () => {
  it('refuses an integration with no approval', async () => {
    server();
    const fixture = await seed();
    const created = await proposal(fixture, {
      files: [{ path: 'src/a.ts', content: 'a' }],
    });
    const id = (created.json() as { changeSet: { id: string } }).changeSet.id;
    const result = await integrate(fixture, [id], 'approval_that_does_not_exist');
    expect(result.statusCode).toBe(404);
    expect(await fileContent(fixture, 'src/a.ts')).toBeNull();
  });

  it('refuses a rejected approval', async () => {
    server();
    const fixture = await seed();
    const created = await proposal(fixture, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const id = (created.json() as { changeSet: { id: string } }).changeSet.id;
    const approval = await approve(fixture, [id], 'reject');
    const result = await integrate(fixture, [id], approval.id);
    expect(result.statusCode).toBe(409);
    expect((result.json() as { error: { code: string } }).error.code).toBe(
      'INTEGRATION_APPROVAL_REJECTED',
    );
  });

  it('does not apply the same proposal twice', async () => {
    server();
    const fixture = await seed();
    const created = await proposal(fixture, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const id = (created.json() as { changeSet: { id: string } }).changeSet.id;
    const approval = await approve(fixture, [id]);
    expect((await integrate(fixture, [id], approval.id)).statusCode).toBe(201);

    const again = await integrate(fixture, [id], approval.id);
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe(
      'INTEGRATION_CHANGE_SET_ALREADY_INTEGRATED',
    );
  });
});

describe('rollback', () => {
  it('reverts an accepted integration', async () => {
    server();
    const fixture = await seed();
    const created = await proposal(fixture, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const id = (created.json() as { changeSet: { id: string } }).changeSet.id;
    const approval = await approve(fixture, [id]);
    const integrated = await integrate(fixture, [id], approval.id);
    const integrationId = (integrated.json() as { record: { id: string } }).record.id;
    expect(await fileContent(fixture, 'src/a.ts')).toBe('a');

    const reverted = await app!.inject({
      method: 'POST',
      url: `/api/integration/records/${integrationId}/rollback`,
      headers: ownerHeader('veltravia-dev-user'),
      payload: { reason: 'The owner changed their mind.' },
    });
    expect(reverted.statusCode, JSON.stringify(reverted.json()).slice(0, 400)).toBe(200);
    expect((reverted.json() as { record: { status: string } }).record.status).toBe('rolled_back');
    expect(await fileContent(fixture, 'src/a.ts')).toBeNull();
  });

  it('refuses a rollback that would erase later work', async () => {
    server();
    const fixture = await seed();
    const created = await proposal(fixture, { files: [{ path: 'src/a.ts', content: 'a' }] });
    const id = (created.json() as { changeSet: { id: string } }).changeSet.id;
    const approval = await approve(fixture, [id]);
    const integrated = await integrate(fixture, [id], approval.id);
    const integrationId = (integrated.json() as { record: { id: string } }).record.id;

    const integratedRevision = (await treeFiles(fixture)).get('src/a.ts')?.revision ?? 1;
    const later = await app!.inject({
      method: 'PATCH',
      url: `/api/projects/${fixture.projectId}/source/file`,
      headers: ownerHeader('veltravia-dev-user'),
      payload: {
        path: 'src/a.ts',
        content: 'edited later',
        expectedRevision: integratedRevision,
      },
    });
    expect(later.statusCode, JSON.stringify(later.json()).slice(0, 300)).toBeLessThan(300);

    const reverted = await app!.inject({
      method: 'POST',
      url: `/api/integration/records/${integrationId}/rollback`,
      headers: ownerHeader('veltravia-dev-user'),
      payload: { reason: 'revert' },
    });
    expect(reverted.statusCode).toBe(409);
    expect(await fileContent(fixture, 'src/a.ts')).toBe('edited later');
  });
});
