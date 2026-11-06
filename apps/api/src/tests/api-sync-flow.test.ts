import { describe, expect, it } from 'vitest';
import {
  FakeGitDataTransport,
  createGitHubConnectorRuntime,
  type GitHubTransportRequest,
} from '@veltravia/connector-github';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import type { GitHubApiConnector } from '../github.js';
import { buildApp } from '../server.js';

/**
 * GitHub sync, end to end over HTTP: subsequent syncs, remote changes pulled
 * in, conflicts and their resolutions, and the history that records it all.
 *
 * The remote end is the connector's offline fake, which keeps a real commit
 * graph per branch, so "the branch moved" and "someone deleted a file" are
 * genuine states rather than scripted answers.
 */

const ALICE = { 'x-veltravia-owner-ref': 'owner-alice' };
const BOB = { 'x-veltravia-owner-ref': 'owner-bob' };
const FAKE_KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3';

interface Harness {
  readonly app: ReturnType<typeof buildApp>;
  readonly transport: FakeGitDataTransport;
  readonly project: string;
  readonly workspace: string;
}

async function setup(options?: { files?: Record<string, string> }): Promise<Harness> {
  const projectEngine = createProjectEngine({
    now: () => new Date(),
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('n'),
  });
  const transport = new FakeGitDataTransport({
    repositories: [{ owner: 'acme', name: 'notes', files: options?.files }],
  });
  const runtime = createGitHubConnectorRuntime({
    connectorId: 'github-demo',
    connectionId: 'conn-sync-flow',
    scope: { repositories: [{ owner: 'acme', repository: 'notes', defaultBranch: 'main' }] },
    transport,
  });
  const github: GitHubApiConnector = {
    runtime,
    isDemo: true,
    registerTools: () => [],
    registerAndConnect: async (connectors) => {
      connectors.register(runtime.connector);
      for (const permission of runtime.connector.permissions) {
        connectors.grantPermission(runtime.connector.metadata.id, permission.id);
      }
      await connectors.connect(runtime.connector.metadata.id);
    },
  };

  const app = buildApp({
    projectEngine,
    githubConnector: github,
  } as Parameters<typeof buildApp>[0]);

  const project = (
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: ALICE,
      payload: { name: 'Notes API', description: '', projectType: 'web' },
    })
  ).json() as { id: string };
  const workspace = (
    await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/workspaces`,
      headers: ALICE,
      payload: { name: 'main' },
    })
  ).json() as { id: string };

  return { app, transport, project: project.id, workspace: workspace.id };
}

async function writeFile(h: Harness, path: string, content: string): Promise<void> {
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${h.workspace}/directories`,
      headers: ALICE,
      payload: { path: segments.slice(0, i).join('/') },
    });
  }
  const created = await h.app.inject({
    method: 'POST',
    url: `/api/workspaces/${h.workspace}/files`,
    headers: ALICE,
    payload: { path, content },
  });
  if (created.statusCode === 201) return;
  // Already there: update it in place, with the revision the engine expects.
  const node = (
    await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${h.workspace}/files/${path}`,
      headers: ALICE,
    })
  ).json() as { node: { revision: number } };
  const updated = await h.app.inject({
    method: 'PATCH',
    url: `/api/workspaces/${h.workspace}/files/${path}`,
    headers: ALICE,
    payload: { content, expectedRevision: node.node.revision },
  });
  expect(updated.statusCode).toBe(200);
}

async function readFile(h: Harness, path: string): Promise<string> {
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/workspaces/${h.workspace}/files/${path}`,
    headers: ALICE,
  });
  return response.statusCode === 200 ? (response.json() as { content: string }).content : '';
}

async function connect(h: Harness): Promise<void> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${h.project}/sync/connect`,
    headers: ALICE,
    payload: { owner: 'acme', repository: 'notes', branch: 'main' },
  });
  expect(response.statusCode).toBe(201);
}

async function plan(h: Harness): Promise<Record<string, unknown>> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${h.project}/sync/plans`,
    headers: ALICE,
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { plan: Record<string, unknown> }).plan;
}

async function approveAndApply(
  h: Harness,
  planId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  await h.app.inject({
    method: 'POST',
    url: `/api/sync/plans/${planId}/approval`,
    headers: ALICE,
  });
  const applied = await h.app.inject({
    method: 'POST',
    url: `/api/sync/plans/${planId}/apply`,
    headers: ALICE,
  });
  return { status: applied.statusCode, body: applied.json() as Record<string, unknown> };
}

function commits(h: Harness): GitHubTransportRequest[] {
  return h.transport.requests.filter((r) => /\/git\/commits$/.test(r.path) && r.method === 'POST');
}

describe('GitHub sync: subsequent synchronisations', () => {
  it('publishes an add, a modification and a deletion as one commit', async () => {
    const h = await setup({ files: { 'keep.ts': 'keep\n', 'gone.ts': 'bye\n' } });
    await connect(h);

    // First sync brings the remote files in, so both sides agree.
    const first = await plan(h);
    const appliedFirst = await approveAndApply(h, String(first['planId']));
    expect(appliedFirst.status).toBe(200);
    expect(await readFile(h, 'keep.ts')).toBe('keep\n');
    expect(await readFile(h, 'gone.ts')).toBe('bye\n');

    const before = commits(h).length;
    await writeFile(h, 'keep.ts', 'keep changed\n');
    await writeFile(h, 'fresh.ts', 'fresh\n');

    const second = await plan(h);
    const push = second['push'] as { path: string; kind: string }[];
    expect(push.map((c) => `${c.kind}:${c.path}`).sort()).toEqual([
      'add:fresh.ts',
      'modify:keep.ts',
    ]);
    // A deletion on the remote is destructive, so this plan waits for a person.
    expect(second['status']).toBe('needs-approval');

    const applied = await approveAndApply(h, String(second['planId']));
    expect(applied.status).toBe(200);
    // Exactly ONE new commit for both files.
    expect(commits(h).length).toBe(before + 1);

    const remote = h.transport.files('acme', 'notes', 'main');
    expect(remote.get('keep.ts')).toBe('keep changed\n');
    expect(remote.get('fresh.ts')).toBe('fresh\n');
  });

  it('deletes a remote file only when the person asked for it', async () => {
    const h = await setup({ files: { 'gone.ts': 'bye\n', 'stay.ts': 'stay\n' } });
    await connect(h);
    const first = await plan(h);
    await approveAndApply(h, String(first['planId']));

    await h.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${h.workspace}/files/gone.ts`,
      headers: ALICE,
    });

    const second = await plan(h);
    expect(second['push']).toEqual([expect.objectContaining({ path: 'gone.ts', kind: 'delete' })]);
    // A deletion is destructive, so it is never applied without a decision.
    expect(second['approvalReasons']).toContain('deletes-remote-files');

    const applied = await approveAndApply(h, String(second['planId']));
    expect(applied.status).toBe(200);
    const remote = h.transport.files('acme', 'notes', 'main');
    expect(remote.has('gone.ts')).toBe(false);
    expect(remote.get('stay.ts')).toBe('stay\n');
  });

  it('pulls a file someone else added, and reports it as pulled', async () => {
    const h = await setup({ files: { 'base.ts': 'base\n' } });
    await connect(h);
    const first = await plan(h);
    await approveAndApply(h, String(first['planId']));

    h.transport.pushDirect('acme', 'notes', 'main', { 'theirs.ts': 'from a colleague\n' });

    const second = await plan(h);
    expect(second['pull']).toEqual([expect.objectContaining({ path: 'theirs.ts', kind: 'add' })]);
    // Bringing a file IN changes nothing remote, so it needs no approval.
    expect(second['status']).toBe('ready');

    const applied = await approveAndApply(h, String(second['planId']));
    expect(applied.status).toBe(200);
    expect((applied.body['summary'] as { pulled: number }).pulled).toBe(1);
    expect(await readFile(h, 'theirs.ts')).toBe('from a colleague\n');
  });
});

describe('GitHub sync: conflicts', () => {
  async function withConflict(): Promise<{ h: Harness; planId: string; conflictId: string }> {
    const h = await setup({ files: { 'shared.ts': 'original\n' } });
    await connect(h);
    const first = await plan(h);
    await approveAndApply(h, String(first['planId']));

    // Both sides change the same file.
    await writeFile(h, 'shared.ts', 'mine\n');
    h.transport.pushDirect('acme', 'notes', 'main', { 'shared.ts': 'theirs\n' });

    const conflictPlan = await plan(h);
    expect(conflictPlan['status']).toBe('conflicts');
    const conflicts = conflictPlan['conflicts'] as { id: string; kind: string; path: string }[];
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('both-modified');
    return { h, planId: String(conflictPlan['planId']), conflictId: String(conflicts[0]?.id) };
  }

  it('keeps both versions and refuses to apply until a person decides', async () => {
    const { h, planId } = await withConflict();
    const applied = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${planId}/apply`,
      headers: ALICE,
    });
    expect(applied.statusCode).toBe(409);
    expect((applied.json() as { error: { code: string } }).error.code).toBe(
      'SYNC_CONFLICTS_UNRESOLVED',
    );
    // Nothing was written to the remote while the conflict stood.
    expect(h.transport.files('acme', 'notes', 'main').get('shared.ts')).toBe('theirs\n');
  });

  it('shows both versions side by side', async () => {
    const { h, planId, conflictId } = await withConflict();
    const view = await h.app.inject({
      method: 'GET',
      url: `/api/sync/plans/${planId}/conflicts/${conflictId}`,
      headers: ALICE,
    });
    expect(view.statusCode).toBe(200);
    const body = view.json() as {
      conflict: { path: string };
      local: string | null;
      remote: string | null;
    };
    expect(body.conflict.path).toBe('shared.ts');
    expect(body.local).toBe('mine\n');
    expect(body.remote).toBe('theirs\n');
  });

  it('resolves by keeping the local version', async () => {
    const { h, planId, conflictId } = await withConflict();
    const resolved = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${planId}/conflicts/${conflictId}`,
      headers: ALICE,
      payload: { resolution: 'keep-local' },
    });
    expect(resolved.statusCode).toBe(200);

    const applied = await approveAndApply(h, planId);
    expect(applied.status).toBe(200);
    expect(h.transport.files('acme', 'notes', 'main').get('shared.ts')).toBe('mine\n');
  });

  it('resolves by keeping the remote version', async () => {
    const { h, planId, conflictId } = await withConflict();
    await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${planId}/conflicts/${conflictId}`,
      headers: ALICE,
      payload: { resolution: 'keep-remote' },
    });
    const applied = await approveAndApply(h, planId);
    expect(applied.status).toBe(200);
    expect(h.transport.files('acme', 'notes', 'main').get('shared.ts')).toBe('theirs\n');
    expect(await readFile(h, 'shared.ts')).toBe('theirs\n');
  });

  it('resolves by hand, and refuses a hand-written secret', async () => {
    const { h, planId, conflictId } = await withConflict();
    const secret = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${planId}/conflicts/${conflictId}`,
      headers: ALICE,
      payload: { resolution: 'manual', manualContent: `token = "${FAKE_KEY}"\n` },
    });
    expect(secret.statusCode).toBe(422);

    const manual = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${planId}/conflicts/${conflictId}`,
      headers: ALICE,
      payload: { resolution: 'manual', manualContent: 'merged by hand\n' },
    });
    expect(manual.statusCode).toBe(200);
    const applied = await approveAndApply(h, planId);
    expect(applied.status).toBe(200);
    expect(h.transport.files('acme', 'notes', 'main').get('shared.ts')).toBe('merged by hand\n');
  });

  it('does not let a second owner resolve or apply it', async () => {
    const { h, planId, conflictId } = await withConflict();
    for (const [method, url, payload] of [
      ['GET', `/api/sync/plans/${planId}/conflicts/${conflictId}`, undefined],
      ['POST', `/api/sync/plans/${planId}/conflicts/${conflictId}`, { resolution: 'keep-local' }],
      ['POST', `/api/sync/plans/${planId}/apply`, undefined],
    ] as const) {
      const response = await h.app.inject({
        method,
        url,
        headers: BOB,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(404);
    }
    // Still unresolved, remote untouched.
    expect(h.transport.files('acme', 'notes', 'main').get('shared.ts')).toBe('theirs\n');
  });
});

describe('GitHub sync: history', () => {
  it('records what each sync did, and says it is in memory', async () => {
    const h = await setup({ files: { 'a.ts': 'a\n' } });
    await connect(h);
    const first = await plan(h);
    await approveAndApply(h, String(first['planId']));

    const history = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${h.project}/sync/history`,
      headers: ALICE,
    });
    expect(history.statusCode).toBe(200);
    const body = history.json() as {
      persistence: string;
      entries: {
        outcome: string;
        commitSha: string | null;
        owner: string;
        repository: string;
        branch: string;
        approval: string;
      }[];
    };
    expect(body.persistence).toBe('memory');
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      outcome: 'success',
      owner: 'acme',
      repository: 'notes',
      branch: 'main',
      // Nothing was published (the file came IN), so no approval was needed...
      approval: 'not-required',
      // ...and the entry still records the file that was pulled.
      pulled: 1,
    });
    // Nothing was published, so there is no commit to point at. A sync that
    // publishes is checked for its sha in the plan/apply suite.
    expect(body.entries[0]?.commitSha).toBeNull();
    // No token, no secret, ever.
    expect(history.body).not.toContain(FAKE_KEY);
    expect(history.body).not.toContain('token');
  });

  it('is empty for another owner, and for a project nobody synced', async () => {
    const h = await setup({ files: { 'a.ts': 'a\n' } });
    await connect(h);
    const first = await plan(h);
    await approveAndApply(h, String(first['planId']));

    const other = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${h.project}/sync/history`,
      headers: BOB,
    });
    // The same 404 as a project that does not exist.
    expect(other.statusCode).toBe(404);
  });
});
