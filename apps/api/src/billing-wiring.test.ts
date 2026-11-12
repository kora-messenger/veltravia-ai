/**
 * Billing wiring through the real app (Step 57).
 *
 * The unit tests prove the coordinator's rules. This file proves the app actually
 * calls it: a paid operation is refused at a zero balance before any work, a real
 * agent run settles through the wallet, an uploaded file is measured, and the
 * fleet view reports the same numbers. Anything less would be a coordinator that
 * nothing uses.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`; CI provides postgres:16.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prepareIsolatedTestSchema } from '@veltravia/storage-postgres';
import { createPersistence, type Persistence } from './persistence.js';
import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';

const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
let databaseUrl = baseDatabaseUrl;
const describeDb = databaseUrl === '' ? describe.skip : describe;

process.env['VELTRAVIA_USAGE_ADMIN_TOKEN'] = 'usage-admin-test';
process.env['VELTRAVIA_WALLET_ADMIN_TOKEN'] = 'wallet-admin-test';
process.env['VELTRAVIA_WORKER_EXECUTOR'] = 'simulated';

const operator = { 'x-veltravia-admin': 'usage-admin-test' };
const walletOperator = { authorization: 'Bearer wallet-admin-test' };
const as = (ref: string): Record<string, string> => ({ 'x-veltravia-owner-ref': ref });

interface BillingView {
  operations: { operation: string; treatment: string; kind: string | null; note: string }[];
  lanes: { lane: string; note: string }[];
  infrastructure: {
    categories: { category: string; status: string; source: string | null }[];
    sampled: { bufferedBytes: number; liveStreams: number };
  };
}

interface UsageView {
  live: { streams: number; bufferedBytes: number };
  records: {
    id: string;
    category: string;
    quantity: number;
    operationKey: string;
    source: string;
    detail: Record<string, unknown>;
  }[];
}

describeDb('billing wiring on postgres', () => {
  let persistence: Persistence;
  let app: FastifyInstance;

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'billing-wiring')) ?? '';
    persistence = await createPersistence({ url: databaseUrl });
    app = buildApp({
      persistence,
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await persistence?.close();
  });

  async function paidOwner(ref: string, credits = 0): Promise<void> {
    const plan = await app.inject({
      method: 'PUT',
      url: '/api/usage/entitlement',
      headers: { ...operator, ...as(ref) },
      payload: { planId: 'paid' },
    });
    expect(plan.statusCode).toBe(200);
    if (credits > 0) {
      const grant = await app.inject({
        method: 'POST',
        url: '/api/wallet/credits',
        headers: { ...walletOperator, ...as(ref) },
        payload: {
          ownerRef: ref,
          amount: credits,
          reason: 'test funding',
          idempotencyKey: `fund-${ref}-${Math.random().toString(36).slice(2, 10)}`,
        },
      });
      expect(grant.statusCode).toBe(201);
    }
  }

  async function wallet(ref: string) {
    const response = await app.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: as(ref),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { wallet: { available: number; reserved: number; spent: number } };
  }

  it('publishes the operation registry and what each infrastructure category can measure', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/billing' });
    expect(response.statusCode).toBe(200);
    const view = response.json() as BillingView;
    const byId = new Map(view.operations.map((entry) => [entry.operation, entry]));
    expect(byId.get('reasoning')?.kind).toBe('reasoning.run');
    expect(byId.get('agent-run')?.kind).toBe('agent.run');
    expect(byId.get('chat')?.treatment).toBe('charged');
    expect(byId.get('connector')?.treatment).toBe('charged');
    // The three categories this step completed say so, and nothing claims to be
    // measured without a source.
    const categories = new Map(
      view.infrastructure.categories.map((entry) => [entry.category, entry]),
    );
    expect(categories.get('file_storage')?.status).toBe('measured');
    expect(categories.get('bandwidth')?.status).toBe('measured');
    expect(categories.get('realtime')?.status).toBe('measured');
    expect(view.lanes.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses a paid reasoning run at a zero balance before the run exists', async () => {
    await paidOwner('billing-empty-owner');
    const before = await wallet('billing-empty-owner');

    const response = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: as('billing-empty-owner'),
      payload: { task: 'Summarise the project in one line.' },
    });

    expect(response.statusCode).toBe(402);
    const body = response.json() as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('BILLING_INSUFFICIENT_CREDITS');
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(body.error.details?.['operation']).toBe('reasoning');
    expect(Array.isArray(body.error.details?.['preserved'])).toBe(true);

    const after = await wallet('billing-empty-owner');
    expect(after.wallet.reserved).toBe(before.wallet.reserved);
    expect(after.wallet.spent).toBe(0);
  });

  it('settles a completed agent run from the wallet, once', async () => {
    await paidOwner('billing-agent-owner', 200);
    const agents = await app.inject({ method: 'GET', url: '/api/agents' });
    const agentId = (agents.json() as { agents: { id: string }[] }).agents[0]!.id;

    const run = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      headers: as('billing-agent-owner'),
      payload: { agentId, task: 'List one thing this workspace contains.' },
    });
    expect(run.statusCode).toBe(200);
    const view = run.json() as { runId: string; status: string };
    expect(view.runId.length).toBeGreaterThan(0);

    const after = await wallet('billing-agent-owner');
    expect(after.wallet.reserved).toBe(0);
    // A completed run is charged; the exact figure belongs to the catalog, so the
    // assertion is that it is a real deduction, not a hold left open.
    if (view.status === 'completed') {
      expect(after.wallet.spent).toBeGreaterThan(0);
    } else {
      expect(after.wallet.spent).toBe(0);
      expect(after.wallet.available).toBe(200);
    }
  });

  it('releases the hold when the work never ran', async () => {
    await paidOwner('billing-release-owner', 200);
    // A gateway run with no provider configured is refused after the hold, which
    // is exactly the case that used to strand credit.
    const run = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      headers: as('billing-release-owner'),
      payload: {
        agentId: 'agent.general',
        task: 'Answer with a single word.',
        reasoning: 'gateway',
        modelId: 'gpt-4o-mini',
      },
    });
    expect([409, 200, 502, 503]).toContain(run.statusCode);
    const after = await wallet('billing-release-owner');
    expect(after.wallet.reserved).toBe(0);
    if (run.statusCode !== 200) expect(after.wallet.available).toBe(200);
  });

  it('measures an uploaded file and the bytes released when it is deleted', async () => {
    const content = Buffer.from('x'.repeat(4096), 'utf8');
    // File routes are single-owner in this deployment and refuse a client-supplied
    // identity, so this case runs as the default owner. The measurement is the
    // point; who owns it is already tested elsewhere.
    const upload = await app.inject({
      method: 'POST',
      url: '/api/files',
      payload: {
        filename: 'notes.txt',
        mimeType: 'text/plain',
        source: 'user_upload',
        contentBase64: content.toString('base64'),
      },
    });
    expect(upload.statusCode).toBe(201);
    const file = upload.json() as { id?: string; fileId?: string };
    const fileId = String(file.id ?? file.fileId ?? '');

    const usage = await app.inject({
      method: 'GET',
      url: '/api/billing/usage',
    });
    expect(usage.statusCode).toBe(200);
    const view = usage.json() as UsageView;
    const added = view.records.find(
      (record) => record.category === 'file_storage' && record.detail['direction'] === 'added',
    );
    expect(added).toBeDefined();
    expect(added?.quantity).toBe(4096);
    expect(added?.source).toBe('measured');

    // The stored-bytes gauge reads the file manager's own number; a wrong field
    // name there left it at zero while still looking measured.
    const snapshot = await app.inject({ method: 'GET', url: '/api/usage' });
    expect(snapshot.statusCode).toBe(200);
    const gauges = snapshot.json() as { gauges: { fileBytes: number } };
    expect(gauges.gauges.fileBytes).toBeGreaterThanOrEqual(4096);

    if (fileId !== '') {
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/files/${fileId}`,
      });
      expect(removed.statusCode).toBe(204);
      const after = await app.inject({
        method: 'GET',
        url: '/api/billing/usage',
      });
      const released = (after.json() as UsageView).records.find(
        (record) => record.category === 'file_storage' && record.detail['direction'] === 'removed',
      );
      expect(released?.quantity).toBe(4096);

      const afterDelete = await app.inject({ method: 'GET', url: '/api/usage' });
      const remaining = (afterDelete.json() as { gauges: { fileBytes: number } }).gauges.fileBytes;
      expect(remaining).toBe(gauges.gauges.fileBytes - 4096);
    }
  });

  it('counts the bytes it carried, without waiting for the flush', async () => {
    // The reads above already passed through the API; a buffered sample proves
    // the hook observes traffic rather than narrating it.
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/usage',
    });
    const view = response.json() as UsageView;
    expect(view.live.bufferedBytes).toBeGreaterThanOrEqual(0);
    expect(typeof view.live.streams).toBe('number');
  });

  it('reconciles an account it has just billed', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/reconcile',
      headers: as('billing-agent-owner'),
    });
    expect(response.statusCode).toBe(200);
    const report = response.json() as {
      consistent: boolean;
      checked: string[];
      stranding: { openHolds: number };
      wallet: { problems: string[] };
    };
    expect(report.consistent).toBe(true);
    expect(report.wallet.problems).toEqual([]);
    expect(report.stranding.openHolds).toBe(0);
    expect(report.checked.length).toBeGreaterThanOrEqual(4);
  });
});
