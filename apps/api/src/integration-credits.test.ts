/**
 * Integration credits through the API (Step 56).
 *
 * These boot the real app over a real PostgreSQL, because "the policy is right"
 * and "the route charges somebody and the row survives a restart" are different
 * claims. The paid plan and the credits are set through the operator routes, so a
 * charge here travels the same path a deployment uses: plan -> policy -> hold ->
 * measurement -> settlement -> ledger.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`; CI provides postgres:16. The
 * hold window is one second so the sweep can be proved without waiting.
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
process.env['VELTRAVIA_INTEGRATION_CREDIT_ADMIN_TOKEN'] = 'integration-admin-test';
process.env['VELTRAVIA_INTEGRATION_HOLD_TTL_SECONDS'] = '1';

const usageOperator = { 'x-veltravia-admin': 'usage-admin-test' };
const walletOperator = { authorization: 'Bearer wallet-admin-test' };
const creditOperator = { authorization: 'Bearer integration-admin-test' };

const as = (ref: string): Record<string, string> => ({ 'x-veltravia-owner-ref': ref });

interface ChargeView {
  id: string;
  state: string;
  credits: number;
  estimatedCredits: number;
  basis: string;
  billingClass: string;
  limitations: string[];
  reservationId: string | null;
  walletEntryId: string | null;
  integrationId: string | null;
  connectorId: string | null;
  operationId: string | null;
  executionId: string | null;
  requestId: string | null;
  requests: number | null;
  measurementSource: string | null;
}

describeDb('integration credits on postgres', () => {
  let persistence: Persistence;
  let app: FastifyInstance;

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'integration-credits')) ?? '';
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
      headers: { ...usageOperator, ...as(ref) },
      payload: { planId: 'paid' },
    });
    expect(plan.statusCode).toBe(200);
    if (credits > 0) await grant(ref, credits);
  }

  async function grant(ref: string, amount: number): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/wallet/credits',
      headers: { ...walletOperator, ...as(ref) },
      payload: {
        ownerRef: ref,
        amount,
        reason: 'test funding',
        idempotencyKey: `fund-${ref}-${Math.random().toString(36).slice(2, 10)}`,
      },
    });
    expect(response.statusCode).toBe(201);
  }

  async function reserve(
    ref: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; charge: ChargeView; created: boolean }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/integration-credits/reservations',
      headers: as(ref),
      payload: { kind: 'integration.operation', operationId: 'contents.get', ...body },
    });
    const parsed = response.json() as { charge: ChargeView; created: boolean };
    return { status: response.statusCode, charge: parsed.charge, created: parsed.created };
  }

  async function commit(
    ref: string,
    chargeId: string,
    measurement: Record<string, unknown>,
  ): Promise<{ status: number; charge: ChargeView; credits: number }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/integration-credits/charges/${chargeId}/commit`,
      headers: as(ref),
      payload: { measurement },
    });
    return {
      status: response.statusCode,
      ...(response.json() as { charge: ChargeView; credits: number }),
    };
  }

  async function balance(ref: string): Promise<number> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/integration-credits',
      headers: as(ref),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { wallet: { available: number } }).wallet.available;
  }

  it('publishes the defaults and names the three billing classes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/integration-credits/policy',
      headers: as('policy-owner'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      version: string;
      defaultsOnly: boolean;
      note: string;
      classes: Array<{ billingClass: string }>;
      plans: Array<{ planId: string; billable: boolean }>;
    };
    expect(body.defaultsOnly).toBe(true);
    expect(body.note).toContain('not market prices');
    expect(body.classes.map((entry) => entry.billingClass)).toEqual([
      'free',
      'paid',
      'externally-billed',
    ]);
    expect(body.plans.find((plan) => plan.planId === 'paid')?.billable).toBe(true);
    expect(body.plans.find((plan) => plan.planId === 'development')?.billable).toBe(false);
  });

  it('classifies an operation before anything runs, without charging', async () => {
    await paidOwner('classify-owner', 5);
    const free = await app.inject({
      method: 'POST',
      url: '/api/integration-credits/classify',
      headers: as('classify-owner'),
      payload: {
        kind: 'integration.operation',
        integrationId: 'mock-storage',
        operationId: 'storage.objects.get',
      },
    });
    expect(free.statusCode).toBe(200);
    expect(free.json()).toMatchObject({
      classification: { billingClass: 'free', billable: false },
      estimate: { credits: 0, exempt: true },
    });

    const paid = await app.inject({
      method: 'POST',
      url: '/api/integration-credits/classify',
      headers: as('classify-owner'),
      payload: {
        kind: 'integration.operation',
        integrationId: 'github',
        operationId: 'contents.get',
        expectedRequests: 2,
      },
    });
    expect(paid.json()).toMatchObject({
      classification: { billingClass: 'paid', billable: true },
      affordable: true,
    });
    expect((paid.json() as { estimate: { credits: number } }).estimate.credits).toBeCloseTo(
      0.48,
      4,
    );

    const external = await app.inject({
      method: 'POST',
      url: '/api/integration-credits/classify',
      headers: as('classify-owner'),
      payload: { kind: 'external.service', operationId: 'invoices.list' },
    });
    expect(external.json()).toMatchObject({
      classification: { billingClass: 'externally-billed', billable: false },
      estimate: { exempt: true },
    });

    // Classifying is a question, never a charge.
    const page = await app.inject({
      method: 'GET',
      url: '/api/integration-credits/charges',
      headers: as('classify-owner'),
    });
    expect((page.json() as { total: number }).total).toBe(0);
  });

  it('refuses an operation with no credit, and the plan is untouched', async () => {
    await paidOwner('empty-owner');
    const refused = await reserve('empty-owner', {
      integrationId: 'github',
      idempotencyKey: 'empty-owner-op-1',
    });
    expect(refused.status).toBe(402);
    expect((refused as unknown as { error?: unknown }).error).toBeUndefined();
    expect(await balance('empty-owner')).toBe(0);
    const rows = await app.inject({
      method: 'GET',
      url: '/api/integration-credits/charges?state=released',
      headers: as('empty-owner'),
    });
    expect((rows.json() as { total: number }).total).toBe(1);
  });

  it('holds, measures, settles and reports the charge with its identifiers', async () => {
    await paidOwner('charge-owner', 20);
    const reserved = await reserve('charge-owner', {
      integrationId: 'github',
      connectorId: 'github',
      operationId: 'contents.get',
      connectionId: 'conn-1',
      executionId: 'run-9',
      requestId: 'inv-9',
      idempotencyKey: 'charge-owner-op-1',
    });
    expect(reserved.status).toBe(201);
    expect(reserved.charge.state).toBe('reserved');
    expect(await balance('charge-owner')).toBeCloseTo(20 - reserved.charge.estimatedCredits, 4);

    const settled = await commit('charge-owner', reserved.charge.id, {
      requests: 3,
      units: { record: 10 },
      source: 'connector',
    });
    expect(settled.status).toBe(200);
    expect(settled.credits).toBeCloseTo(0.4 + 3 * 0.04, 4);
    expect(settled.charge.walletEntryId).not.toBeNull();
    expect(settled.charge).toMatchObject({
      state: 'committed',
      integrationId: 'github',
      connectorId: 'github',
      operationId: 'contents.get',
      executionId: 'run-9',
      requestId: 'inv-9',
      requests: 3,
      measurementSource: 'connector',
    });
    expect(await balance('charge-owner')).toBeCloseTo(20 - settled.credits, 4);

    const summary = await app.inject({
      method: 'GET',
      url: '/api/integration-credits',
      headers: as('charge-owner'),
    });
    const body = summary.json() as {
      month: { charges: number; credits: number; byIntegration: Array<{ key: string }> };
      wallet: { spent: number };
    };
    expect(body.month.charges).toBe(1);
    expect(body.month.credits).toBeCloseTo(settled.credits, 4);
    expect(body.month.byIntegration.map((row) => row.key)).toContain('github');
  });

  it('charges one operation once when the same key arrives twice', async () => {
    await paidOwner('idem-owner', 10);
    const first = await reserve('idem-owner', {
      integrationId: 'github',
      idempotencyKey: 'idem-owner-op-1',
    });
    const second = await reserve('idem-owner', {
      integrationId: 'github',
      idempotencyKey: 'idem-owner-op-1',
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.created).toBe(false);
    expect(second.charge.id).toBe(first.charge.id);
    const page = await app.inject({
      method: 'GET',
      url: '/api/integration-credits/charges',
      headers: as('idem-owner'),
    });
    expect((page.json() as { total: number }).total).toBe(1);
  });

  it('returns the hold when the caller releases it', async () => {
    await paidOwner('release-owner', 10);
    const reserved = await reserve('release-owner', {
      integrationId: 'github',
      idempotencyKey: 'release-owner-op-1',
    });
    const released = await app.inject({
      method: 'POST',
      url: `/api/integration-credits/charges/${reserved.charge.id}/release`,
      headers: as('release-owner'),
      payload: { reason: 'The connector refused the request.' },
    });
    expect(released.statusCode).toBe(200);
    expect((released.json() as ChargeView).state).toBe('released');
    expect(await balance('release-owner')).toBe(10);
  });

  it('records a measurement nobody reported instead of inventing a zero', async () => {
    await paidOwner('blind-owner', 10);
    const reserved = await reserve('blind-owner', {
      kind: 'connector.operation',
      connectorId: 'slack',
      operationId: 'chat.post',
      idempotencyKey: 'blind-owner-op-1',
    });
    const settled = await commit('blind-owner', reserved.charge.id, {});
    expect(settled.charge.limitations).toContain('request-count-unavailable');
    expect(settled.charge.requests).toBeNull();
    expect(settled.charge.measurementSource).toBe('unavailable');
  });

  it('enforces the spending limits a user sets', async () => {
    await paidOwner('limited-owner', 50);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/integration-credits/settings',
      headers: as('limited-owner'),
      payload: { monthlyLimit: 0.3, perOperationLimit: null },
    });
    expect(saved.statusCode).toBe(200);
    const refused = await reserve('limited-owner', {
      integrationId: 'github',
      idempotencyKey: 'limited-owner-op-1',
    });
    expect(refused.status).toBe(402);
    const settings = await app.inject({
      method: 'GET',
      url: '/api/integration-credits/settings',
      headers: as('limited-owner'),
    });
    expect(settings.json()).toMatchObject({ monthlyLimit: 0.3, perOperationLimit: null });
  });

  it('keeps refunds behind an operator token', async () => {
    await paidOwner('refund-owner', 10);
    const reserved = await reserve('refund-owner', {
      integrationId: 'github',
      idempotencyKey: 'refund-owner-op-1',
    });
    const settled = await commit('refund-owner', reserved.charge.id, { requests: 1 });
    const withoutToken = await app.inject({
      method: 'POST',
      url: `/api/integration-credits/charges/${settled.charge.id}/refund`,
      headers: as('refund-owner'),
      payload: { ownerRef: 'refund-owner', reason: 'not allowed' },
    });
    expect(withoutToken.statusCode).toBe(403);

    const refunded = await app.inject({
      method: 'POST',
      url: `/api/integration-credits/charges/${settled.charge.id}/refund`,
      headers: { ...creditOperator, ...as('refund-owner') },
      payload: { ownerRef: 'refund-owner', reason: 'the provider returned a bad answer' },
    });
    expect(refunded.statusCode).toBe(200);
    expect((refunded.json() as ChargeView).state).toBe('refunded');
    expect(await balance('refund-owner')).toBe(10);
  });

  it('releases an abandoned hold when the sweep runs', async () => {
    await paidOwner('sweep-owner', 10);
    await reserve('sweep-owner', {
      integrationId: 'github',
      idempotencyKey: 'sweep-owner-op-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const swept = await app.inject({
      method: 'POST',
      url: '/api/integration-credits/sweep',
      headers: as('sweep-owner'),
    });
    expect(swept.statusCode).toBe(200);
    expect((swept.json() as { released: number }).released).toBe(1);
    expect(await balance('sweep-owner')).toBe(10);
  });

  it('never shows one owner another owner charges', async () => {
    await paidOwner('tenant-a', 10);
    await reserve('tenant-a', {
      integrationId: 'github',
      idempotencyKey: 'tenant-a-op-1',
    });
    const theirs = await app.inject({
      method: 'GET',
      url: '/api/integration-credits/charges',
      headers: as('tenant-b'),
    });
    expect((theirs.json() as { total: number }).total).toBe(0);
  });

  it('reads the charges again from a second instance of the app', async () => {
    await paidOwner('restart-owner', 10);
    const reserved = await reserve('restart-owner', {
      integrationId: 'github',
      idempotencyKey: 'restart-owner-op-1',
    });
    const settled = await commit('restart-owner', reserved.charge.id, { requests: 1 });
    // A new persistence instance stands in for a restarted process: same
    // database, nothing in memory.
    const second = await createPersistence({ url: databaseUrl });
    const secondApp = buildApp({
      persistence: second,
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    await secondApp.ready();
    try {
      const response = await secondApp.inject({
        method: 'GET',
        url: '/api/integration-credits/charges',
        headers: as('restart-owner'),
      });
      expect(response.statusCode).toBe(200);
      const page = response.json() as { total: number; charges: ChargeView[] };
      expect(page.total).toBe(1);
      expect(page.charges[0]?.id).toBe(settled.charge.id);
      expect(page.charges[0]?.credits).toBeCloseTo(settled.credits, 4);
    } finally {
      await secondApp.close();
      await second.close();
    }
  });
});
