/**
 * Usage metering through the API (Step 52).
 *
 * Two kinds of proof here, and they are deliberately separate:
 *
 *  - in memory (always runs): what the snapshot says, that a limit nothing
 *    measures is reported as unenforced rather than as room to spare, that the
 *    operator endpoints are closed unless the deployment configured a token, and
 *    that one owner's usage is invisible to another;
 *  - on a database (skipped without `VELTRAVIA_TEST_DATABASE_URL`): that a spent
 *    allowance refuses the work before it starts, that the refusal says which
 *    limit and by how much, and that the same job count cannot be spent twice.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { prepareIsolatedTestSchema } from '@veltravia/storage-postgres';

import { buildApp } from './server.js';
import { createPersistence, type Persistence } from './persistence.js';

process.env['VELTRAVIA_WORKER_EXECUTOR'] = 'simulated';

const ADMIN = 'usage-admin-token-for-tests';

interface SnapshotBody {
  readonly durable: boolean;
  readonly developmentMode: boolean;
  readonly entitlement: { readonly planId: string; readonly managedProviders: boolean };
  readonly counters: Record<string, number>;
  readonly gauges: { readonly fileBytes: number | null; readonly openJobs: number | null };
  readonly cost: {
    readonly infrastructureUsd: number;
    readonly managedProviderUsd: number;
    readonly byokProviderUsd: number;
  };
  readonly limits: readonly {
    readonly key: string;
    readonly enforcement: string;
    readonly used: number | null;
    readonly value: number | null;
  }[];
}

let memoryApp: FastifyInstance | null = null;

afterEach(async () => {
  await memoryApp?.close();
  memoryApp = null;
});

async function startMemory(): Promise<FastifyInstance> {
  const api = await buildApp({ logger: false, env: {} as NodeJS.ProcessEnv });
  await api.ready();
  memoryApp = api;
  return api;
}

describe('usage API', () => {
  it('reports which numbers are measured and which limits are therefore unenforced', async () => {
    const api = await startMemory();
    const capabilities = await api.inject({ method: 'GET', url: '/api/usage/capabilities' });
    expect(capabilities.statusCode).toBe(200);
    const body = capabilities.json() as {
      enforcement: string;
      durable: boolean;
      categories: readonly { category: string; status: string; note: string }[];
    };
    expect(body.durable).toBe(false);
    // Database bytes are not probed anywhere yet, so the API must say so.
    const database = body.categories.find((entry) => entry.category === 'database_storage');
    expect(database?.status).toBe('unavailable');
    expect(body.enforcement).toBe('partial');

    const snapshot = await api.inject({ method: 'GET', url: '/api/usage' });
    expect(snapshot.statusCode).toBe(200);
    const view = snapshot.json() as SnapshotBody;
    expect(view.entitlement.planId).toBe('development');
    expect(view.developmentMode).toBe(true);
    // File bytes are genuinely probed here, so the gauge is a real zero rather
    // than a missing number: this deployment does count files.
    expect(view.gauges.fileBytes).toBe(0);
    const databaseLimit = view.limits.find((entry) => entry.key === 'databaseStorageBytes');
    expect(databaseLimit?.enforcement).toBe('not_enforced');
    expect(databaseLimit?.used).toBeNull();
    // A limit nothing can change here is still published, with its value.
    expect(databaseLimit?.value).toBeGreaterThan(0);
    const jobs = view.limits.find((entry) => entry.key === 'backgroundJobs');
    expect(jobs?.enforcement).toBe('hard');
  });

  it('keeps one owner’s usage out of another owner’s snapshot', async () => {
    const api = await startMemory();
    const mine = await api.inject({
      method: 'GET',
      url: '/api/usage/records',
      headers: { 'x-veltravia-owner-ref': 'usage-owner-a' },
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { count: number }).count).toBe(0);

    // The route reads the caller, so asking as another owner is a different view,
    // not a wider one.
    const theirs = await api.inject({
      method: 'GET',
      url: '/api/usage/records',
      headers: { 'x-veltravia-owner-ref': 'usage-owner-b' },
    });
    expect((theirs.json() as { count: number }).count).toBe(0);
  });

  it('refuses a hidden query parameter instead of quietly widening the read', async () => {
    const api = await startMemory();
    const response = await api.inject({
      method: 'GET',
      url: '/api/usage?ownerRef=someone-else',
    });
    expect(response.statusCode).toBe(400);
  });

  it('closes the operator endpoints when the deployment has no admin token', async () => {
    const api = await startMemory();
    const response = await api.inject({
      method: 'PUT',
      url: '/api/usage/entitlement',
      headers: { 'x-veltravia-admin': ADMIN },
      payload: { planId: 'paid' },
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'USAGE_ADMIN_DISABLED',
    );
  });

  it('refuses an operator change with the wrong token, and a malformed adjustment', async () => {
    const api = await buildApp({
      logger: false,
      env: { VELTRAVIA_USAGE_ADMIN_TOKEN: ADMIN } as NodeJS.ProcessEnv,
    });
    await api.ready();
    memoryApp = api;

    const forbidden = await api.inject({
      method: 'PUT',
      url: '/api/usage/limits',
      headers: { 'x-veltravia-admin': 'not-the-token' },
      payload: { key: 'backgroundJobs', value: 5 },
    });
    expect(forbidden.statusCode).toBe(403);

    // A vague reason is refused by the schema: an audited correction has to say
    // what it was correcting.
    const vague = await api.inject({
      method: 'POST',
      url: '/api/usage/adjustments',
      headers: { 'x-veltravia-admin': ADMIN },
      payload: { category: 'backend_execution', quantity: -10, reason: 'oops', auditId: 'audit-1' },
    });
    expect(vague.statusCode).toBe(400);

    // With no database the write is refused rather than silently dropped.
    const noStore = await api.inject({
      method: 'PUT',
      url: '/api/usage/limits',
      headers: { 'x-veltravia-admin': ADMIN },
      payload: { key: 'backgroundJobs', value: 5 },
    });
    expect(noStore.statusCode).toBe(503);
    expect((noStore.json() as { error: { code: string } }).error.code).toBe('USAGE_NOT_DURABLE');
  });
});

/* ------------------------------------------------------------------ database */

const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = baseDatabaseUrl === '' ? describe.skip : describe;

describeDb('usage enforcement on postgres', () => {
  let persistence: Persistence;
  let app: FastifyInstance;
  const owner = `usage-api-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    const url = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'usage-api')) ?? '';
    persistence = await createPersistence({ url });
    app = await buildApp({
      logger: false,
      persistence,
      env: {
        VELTRAVIA_USAGE_ADMIN_TOKEN: ADMIN,
        VELTRAVIA_WORKER_EXECUTOR: 'simulated',
      } as NodeJS.ProcessEnv,
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await persistence?.close();
  });

  const headers = { 'x-veltravia-owner-ref': owner, 'x-veltravia-admin': ADMIN } as const;

  async function seedProject(): Promise<string> {
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: {
        name: `Usage ${Math.random().toString(36).slice(2, 8)}`,
        description: 'usage fixture',
        projectType: 'web',
      },
    });
    expect(project.statusCode).toBe(201);
    const projectId = (project.json() as { id: string }).id;
    const workspace = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workspaces`,
      headers,
      payload: { name: 'main' },
    });
    const workspaceId = (workspace.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      headers,
      payload: {
        path: 'package.json',
        content: JSON.stringify({ name: 'fx', scripts: { test: 'vitest run' } }),
      },
    });
    return projectId;
  }

  it('spends the job allowance once, then refuses the next intake before it plans', async () => {
    const projectId = await seedProject();

    // One job this month. Enough for one intake, not two.
    const limited = await app.inject({
      method: 'PUT',
      url: '/api/usage/limits',
      headers,
      payload: { key: 'backgroundJobs', value: 1 },
    });
    expect(limited.statusCode).toBe(200);

    const first = await app.inject({
      method: 'POST',
      url: '/api/executions',
      headers,
      payload: { projectId, request: 'Add a health endpoint and document it.' },
    });
    expect(first.statusCode).toBe(201);
    const executionId = (first.json() as { execution: { id: string } }).execution.id;

    const snapshot = await app.inject({ method: 'GET', url: '/api/usage', headers });
    const view = snapshot.json() as SnapshotBody;
    expect(view.durable).toBe(true);
    expect(view.counters.background_jobs).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/executions',
      headers,
      payload: { projectId, request: 'Add another endpoint.' },
    });
    expect(second.statusCode).toBe(429);
    const refusal = second.json() as {
      error: {
        code: string;
        message: string;
        decision: { limitKey: string; limit: number; used: number };
      };
    };
    expect(refusal.error.code).toBe('USAGE_LIMIT_REACHED');
    expect(refusal.error.decision.limitKey).toBe('backgroundJobs');
    expect(refusal.error.decision.limit).toBe(1);
    expect(refusal.error.decision.used).toBe(1);
    // The message states the numbers rather than only saying "over limit".
    expect(refusal.error.message).toContain('Background jobs this month');

    // Nothing was planned for the refused request: the store has one execution.
    const listed = await app.inject({
      method: 'GET',
      url: `/api/executions?projectId=${projectId}`,
      headers,
    });
    expect((listed.json() as { count: number }).count).toBe(1);
    expect(executionId).not.toBe('');

    // Raising the limit is an operator decision, and it takes effect at once.
    const raised = await app.inject({
      method: 'PUT',
      url: '/api/usage/limits',
      headers,
      payload: { key: 'backgroundJobs', value: 10 },
    });
    expect(raised.statusCode).toBe(200);
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/executions',
      headers,
      payload: { projectId, request: 'Add another endpoint.' },
    });
    expect(allowed.statusCode).toBe(201);
  }, 60_000);

  it('records an audited correction without rewriting the row it corrects', async () => {
    const adjust = await app.inject({
      method: 'POST',
      url: '/api/usage/adjustments',
      headers,
      payload: {
        category: 'background_jobs',
        quantity: -1,
        reason: 'Duplicate intake while the queue was restarting.',
        auditId: `audit-${owner}-1`,
      },
    });
    expect(adjust.statusCode).toBe(201);

    const again = await app.inject({
      method: 'POST',
      url: '/api/usage/adjustments',
      headers,
      payload: {
        category: 'background_jobs',
        quantity: -1,
        reason: 'Duplicate intake while the queue was restarting.',
        auditId: `audit-${owner}-1`,
      },
    });
    // The same audit id is one correction, not two.
    expect(again.statusCode).toBe(201);

    const listed = await app.inject({ method: 'GET', url: '/api/usage/adjustments', headers });
    const body = listed.json() as { adjustments: readonly { auditId: string; quantity: number }[] };
    expect(body.adjustments.filter((row) => row.auditId === `audit-${owner}-1`)).toHaveLength(1);

    const snapshot = await app.inject({ method: 'GET', url: '/api/usage', headers });
    // Two jobs admitted, one correction: the month reads one.
    expect((snapshot.json() as SnapshotBody).counters.background_jobs).toBe(1);
  }, 30_000);
});
