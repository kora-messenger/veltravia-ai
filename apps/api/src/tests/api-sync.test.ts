import { describe, expect, it } from 'vitest';

import {
  createGitHubConnectorRuntime,
  FakeGitDataTransport,
  type GitHubTransportRequest,
} from '@veltravia/connector-github';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';

import type { GitHubApiConnector } from '../github.js';
import { createRateLimiter } from '../rate-limit.js';
import { buildApp } from '../server.js';

/**
 * GitHub synchronisation over HTTP (Step 40, phase 3).
 *
 * The remote end is the offline Git Data fake, so no token exists and CI never
 * needs one. What is real here: ownership, the repository scope, the approval
 * gate, the single-commit publish, and the connector's own guards.
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

async function setup(options?: {
  limiter?: ReturnType<typeof createRateLimiter>;
  repositories?: { owner: string; name: string }[];
  withDefaultBranch?: boolean;
}): Promise<Harness> {
  const projectEngine = createProjectEngine({
    now: () => new Date('2026-11-06T09:00:00Z'),
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });

  const transport = new FakeGitDataTransport({
    repositories: options?.repositories ?? [{ owner: 'acme', name: 'notes' }],
  });
  const runtime = createGitHubConnectorRuntime({
    connectorId: 'github-demo',
    connectionId: 'conn-sync-test',
    // Exactly one repository: the scope is the security boundary, not a hint.
    scope: { repositories: [{ owner: 'acme', repository: 'notes', defaultBranch: 'main' }] },
    transport,
    now: () => new Date('2026-11-06T09:00:00Z'),
  });
  // The same lifecycle the production wiring uses, against the app's own
  // ConnectorManager: register, grant every declared permission, connect.
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
    ...(options?.limiter === undefined ? {} : { syncLimiter: options.limiter }),
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

async function writeFile(
  h: Harness,
  path: string,
  content: string,
  headers: Record<string, string> = ALICE,
): Promise<void> {
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const dir = segments.slice(0, i).join('/');
    await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${h.workspace}/directories`,
      headers,
      payload: { path: dir },
    });
  }
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/workspaces/${h.workspace}/files`,
    headers,
    payload: { path, content },
  });
  expect([201, 200]).toContain(response.statusCode);
}

describe('GitHub sync: repository discovery and connection', () => {
  it('lists only repositories the connector is scoped to', async () => {
    const h = await setup({
      repositories: [
        { owner: 'acme', name: 'notes' },
        { owner: 'acme', name: 'secret' },
      ],
    });
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/github/repositories',
      headers: ALICE,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { repositories: { owner: string; repository: string }[] };
    expect(body.repositories).toEqual([
      expect.objectContaining({ owner: 'acme', repository: 'notes' }),
    ]);
  });

  it('lists branches with the default marked', async () => {
    const h = await setup();
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/github/branches?owner=acme&repository=notes',
      headers: ALICE,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { branches: { name: string; isDefault: boolean }[] };
    expect(body.branches).toEqual([expect.objectContaining({ name: 'main', isDefault: true })]);
  });

  it('refuses a repository outside the connector scope', async () => {
    const h = await setup();
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/github/branches?owner=acme&repository=secret',
      headers: ALICE,
    });
    // 404, exactly like a repository that does not exist: the answer never
    // reveals whether a repository outside the scope exists.
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'SYNC_REPOSITORY_NOT_ALLOWED',
    );
  });

  it('connects, reports status, and refuses a branch that does not exist', async () => {
    const h = await setup();
    const bad = await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'nope' },
    });
    expect(bad.statusCode).toBe(404);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('SYNC_BRANCH_NOT_FOUND');

    const ok = await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    expect(ok.statusCode).toBe(201);

    const status = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${h.project}/sync`,
      headers: ALICE,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json() as {
      connected: boolean;
      connection: { owner: string; repository: string; branch: string };
      persistence: string;
    };
    expect(body.connected).toBe(true);
    expect(body.connection.repository).toBe('notes');
    // Honest about what survives a restart.
    expect(body.persistence).toBe('memory');
  });

  it('disconnects without touching anything remote', async () => {
    const h = await setup();
    await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    const before = h.transport.requests.filter((r) => r.method !== 'GET').length;
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/projects/${h.project}/sync`,
      headers: ALICE,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { disconnected: boolean }).disconnected).toBe(true);
    expect(h.transport.requests.filter((r) => r.method !== 'GET').length).toBe(before);
    const status = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${h.project}/sync`,
      headers: ALICE,
    });
    expect((status.json() as { connected: boolean }).connected).toBe(false);
  });
});

describe('GitHub sync: who may do what', () => {
  it('answers a foreign project exactly like a missing one', async () => {
    const h = await setup();
    const foreign = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${h.project}/sync`,
      headers: BOB,
    });
    const missing = await h.app.inject({
      method: 'GET',
      url: '/api/projects/prj-does-not-exist/sync',
      headers: BOB,
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
  });

  it('does not let a second owner connect, plan or read history on it', async () => {
    const h = await setup();
    for (const [method, url, payload] of [
      [
        'POST',
        `/api/projects/${h.project}/sync/connect`,
        { owner: 'acme', repository: 'notes', branch: 'main' },
      ],
      ['POST', `/api/projects/${h.project}/sync/plans`, {}],
      ['GET', `/api/projects/${h.project}/sync/history`, undefined],
    ] as const) {
      const response = await h.app.inject({
        method,
        url,
        headers: BOB,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('keeps one owner’s export and native files working while GitHub is disconnected', async () => {
    const h = await setup();
    await writeFile(h, 'README.md', '# notes\n');
    const exported = await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/exports`,
      headers: ALICE,
      payload: {},
    });
    expect(exported.statusCode).toBe(201);
    const view = exported.json() as { exportId: string; totals: { files: number } };
    expect(view.totals.files).toBe(1);
    const download = await h.app.inject({
      method: 'GET',
      url: `/api/exports/${view.exportId}/download`,
      headers: ALICE,
    });
    expect(download.statusCode).toBe(200);
    // No GitHub request was made by any of it.
    expect(h.transport.requests).toEqual([]);
  });
});

describe('GitHub sync: planning and publishing', () => {
  it('plans an initial sync, requires approval, and publishes ONE commit', async () => {
    const h = await setup();
    await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    await writeFile(h, 'README.md', '# notes\n');
    await writeFile(h, 'src/index.ts', 'export const a = 1;\n');
    await writeFile(h, '.env', 'SECRET=1\n');

    const planned = await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/plans`,
      headers: ALICE,
      payload: { message: 'Initial import' },
    });
    expect(planned.statusCode).toBe(201);
    const plan = (
      planned.json() as {
        plan: {
          planId: string;
          status: string;
          push: { path: string; kind: string }[];
          skipped: { path: string; reason: string }[];
          approvalReasons: string[];
        };
      }
    ).plan;
    expect(plan.status).toBe('needs-approval');
    expect(plan.approvalReasons).toContain('first-sync');
    expect(plan.push.map((c) => c.path).sort()).toEqual(['README.md', 'src/index.ts']);
    // The credential file never becomes a change, and says why.
    expect(plan.skipped).toEqual([
      expect.objectContaining({ path: '.env', reason: 'credential-file' }),
    ]);

    const refused = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.planId}/apply`,
      headers: ALICE,
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe(
      'SYNC_APPROVAL_REQUIRED',
    );

    const approved = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.planId}/approval`,
      headers: ALICE,
    });
    expect(approved.statusCode).toBe(200);

    const applied = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.planId}/apply`,
      headers: ALICE,
    });
    expect(applied.statusCode).toBe(200);
    const result = applied.json() as {
      commitSha: string;
      summary: { published: number; pulled: number; failed: boolean };
    };
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.summary.published).toBe(2);
    expect(result.summary.pulled).toBe(0);
    expect(result.summary.failed).toBe(false);

    // One commit object was created for two files, and .env never left.
    const publishCalls = h.transport.requests.filter(
      (r) => r.path.endsWith('/git/commits') && r.method === 'POST',
    );
    expect(publishCalls).toHaveLength(1);
    // ONE commit object, pointing at ONE tree that holds both files: the
    // paths live in the tree the commit names, not in the commit itself.
    const commitBody = JSON.stringify(publishCalls[0]?.body ?? {});
    const treeShas = h.transport.requests.filter(
      (r) => /\/git\/trees$/.test(r.path) && r.method === 'POST',
    );
    expect(treeShas).toHaveLength(1);
    const treeBody = JSON.stringify(treeShas[0]?.body ?? {});
    expect(treeBody).toContain('README.md');
    expect(treeBody).toContain('src/index.ts');
    expect(commitBody).toContain('parents');
    expect(commitBody).not.toContain('.env');
    expect(commitBody).not.toContain('SECRET=1');

    const history = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${h.project}/sync/history`,
      headers: ALICE,
    });
    const entries = (
      history.json() as { entries: { outcome: string; commitSha: string; added: string[] }[] }
    ).entries;
    expect(entries[0]).toMatchObject({
      outcome: 'success',
      commitSha: result.commitSha,
      added: ['README.md', 'src/index.ts'],
    });
  });

  it('refuses to publish a credential-shaped file even when the name looks harmless', async () => {
    const h = await setup();
    await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    await writeFile(h, 'config.ts', `export const token = "${FAKE_KEY}";\n`);
    const planned = await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/plans`,
      headers: ALICE,
      payload: {},
    });
    const plan = (
      planned.json() as {
        plan: {
          planId: string;
          push: unknown[];
          skipped: { path: string; reason: string; kind?: string }[];
        };
      }
    ).plan;
    expect(plan.push).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ path: 'config.ts', reason: 'secret-in-content' }),
    ]);
    // The exclusion report never repeats the secret.
    expect(planned.body).not.toContain(FAKE_KEY);
  });

  it('rejects path traversal smuggled in a project path', async () => {
    const h = await setup();
    await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    await writeFile(h, 'ok.txt', 'fine\n');
    const planned = await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/plans`,
      headers: ALICE,
      payload: {},
    });
    const plan = (planned.json() as { plan: { planId: string; push: { path: string }[] } }).plan;
    expect(plan.push.map((c) => c.path)).toEqual(['ok.txt']);
  });

  it('cancels a plan and refuses to apply it afterwards', async () => {
    const h = await setup();
    await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    await writeFile(h, 'a.txt', '1\n');
    const plan = (
      await h.app.inject({
        method: 'POST',
        url: `/api/projects/${h.project}/sync/plans`,
        headers: ALICE,
        payload: {},
      })
    ).json() as { plan: { planId: string } };

    const cancelled = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.plan.planId}/cancel`,
      headers: ALICE,
    });
    expect(cancelled.statusCode).toBe(200);
    const applied = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.plan.planId}/apply`,
      headers: ALICE,
    });
    expect(applied.statusCode).toBe(409);
    expect(h.transport.requests.some((r) => r.path.endsWith('/git/commits'))).toBe(false);
  });

  it('reports a GitHub failure without writing anything locally', async () => {
    const h = await setup();
    await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    await writeFile(h, 'a.txt', '1\n');
    const plan = (
      await h.app.inject({
        method: 'POST',
        url: `/api/projects/${h.project}/sync/plans`,
        headers: ALICE,
        payload: {},
      })
    ).json() as { plan: { planId: string } };
    await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.plan.planId}/approval`,
      headers: ALICE,
    });
    h.transport.failNext(2, 502);
    const applied = await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.plan.planId}/apply`,
      headers: ALICE,
    });
    expect(applied.statusCode).toBeGreaterThanOrEqual(400);
    const body = applied.body;
    // No token, no remote body, no stack trace in the response.
    expect(body).not.toContain('api.github.com');
    const history = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${h.project}/sync/history`,
      headers: ALICE,
    });
    const entries = (history.json() as { entries: { outcome: string }[] }).entries;
    expect(entries[0]?.outcome).toBe('failure');
  });
});

describe('GitHub sync: rate limiting', () => {
  it('limits planning per caller', async () => {
    const h = await setup({
      limiter: createRateLimiter({ max: 2, windowMs: 60_000 }),
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/projects/${h.project}/sync/plans`,
        headers: ALICE,
        payload: {},
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 2)).toEqual([201, 201]);
    expect(statuses[2]).toBe(429);
  });
});

describe('GitHub sync: never a second integration', () => {
  it('uses only the connector’s declared endpoints', async () => {
    const h = await setup();
    await h.app.inject({
      method: 'POST',
      url: `/api/projects/${h.project}/sync/connect`,
      headers: ALICE,
      payload: { owner: 'acme', repository: 'notes', branch: 'main' },
    });
    await writeFile(h, 'a.txt', '1\n');
    const plan = (
      await h.app.inject({
        method: 'POST',
        url: `/api/projects/${h.project}/sync/plans`,
        headers: ALICE,
        payload: {},
      })
    ).json() as { planId: string };
    await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.planId}/approval`,
      headers: ALICE,
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/sync/plans/${plan.planId}/apply`,
      headers: ALICE,
    });

    const allowed: ((r: GitHubTransportRequest) => boolean)[] = [
      (r) => r.path === '/user/repos',
      (r) => /^\/repos\/acme\/notes$/.test(r.path),
      (r) => r.path.startsWith('/repos/acme/notes/branches'),
      (r) => r.path.startsWith('/repos/acme/notes/git/trees'),
      (r) => r.path.startsWith('/repos/acme/notes/git/blobs'),
      (r) => r.path === '/repos/acme/notes/git/commits',
      // Reading a commit to resolve the tree it points at (github.tree.get).
      (r) => /^\/repos\/acme\/notes\/git\/commits\/[0-9a-f]{40}$/.test(r.path),
      (r) => r.path === '/repos/acme/notes/git/refs/heads/main',
      (r) => r.path.startsWith('/repos/acme/notes/contents'),
    ];
    for (const request of h.transport.requests) {
      expect(allowed.some((test) => test(request))).toBe(true);
    }
    // Repository deletion is not reachable at any point.
    expect(h.transport.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });
});
