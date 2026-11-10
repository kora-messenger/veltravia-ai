/**
 * Message credits through the API (Step 54).
 *
 * These boot the real app, because "the policy table is right" and "the route
 * charges somebody" are different claims. The paid plan and the credits are set
 * through the operator routes, so every charge here goes through the same path a
 * deployment uses: hold, measure, settle.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`; CI provides postgres:16. The
 * hold TTL is one second so the sweep can be proved without waiting a quarter of
 * an hour.
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
process.env['VELTRAVIA_MESSAGE_HOLD_TTL_SECONDS'] = '1';
process.env['VELTRAVIA_WORKER_EXECUTOR'] = 'simulated';

const operator = { 'x-veltravia-admin': 'usage-admin-test' };
const walletOperator = { authorization: 'Bearer wallet-admin-test' };

const as = (ref: string): Record<string, string> => ({ 'x-veltravia-owner-ref': ref });

interface ChargeView {
  id: string;
  state: string;
  credits: number;
  estimatedCredits: number;
  basis: string;
  limitations: string[];
  reservationId: string | null;
  modelId: string | null;
  conversationId: string | null;
  walletEntryId: string | null;
}

describeDb('message credits on postgres', () => {
  let persistence: Persistence;
  let app: FastifyInstance;

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'message-credits')) ?? '';
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
    if (credits > 0) await grant(ref, credits);
  }

  async function grant(ref: string, amount: number, key?: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/wallet/credits',
      headers: { ...walletOperator, ...as(ref) },
      payload: {
        ownerRef: ref,
        amount,
        reason: 'test funding',
        idempotencyKey: key ?? `fund-${ref}-${Math.random().toString(36).slice(2, 10)}`,
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
      url: '/api/message-credits/reservations',
      headers: as(ref),
      payload: { kind: 'chat.message', byok: true, ...body },
    });
    const parsed = response.json() as { charge: ChargeView; created: boolean };
    return { status: response.statusCode, charge: parsed.charge, created: parsed.created };
  }

  async function commit(
    ref: string,
    chargeId: string,
    measurement: Record<string, number | string | boolean>,
  ): Promise<{ status: number; charge: ChargeView; credits: number; aboveHold: number }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/message-credits/charges/${chargeId}/commit`,
      headers: as(ref),
      payload: { measurement },
    });
    if (response.statusCode >= 400) console.log('COMMIT-ERR', response.body);
    return {
      status: response.statusCode,
      ...(response.json() as { charge: ChargeView; credits: number; aboveHold: number }),
    };
  }

  async function balance(ref: string, query = ''): Promise<{ available: number }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/message-credits${query}`,
      headers: as(ref),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { wallet: { available: number } };
    return body.wallet;
  }

  it('labels the shipped rates as configurable defaults, not prices', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/message-credits/policy',
      headers: as('policy-owner'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      defaultsOnly: boolean;
      note: string;
      currency: string;
      plans: { planId: string; billable: boolean; policies: { kind: string }[] }[];
    };
    expect(body.defaultsOnly).toBe(true);
    expect(body.note).toContain('not market prices');
    expect(body.currency).toBe('credits');
    const paid = body.plans.find((plan) => plan.planId === 'paid');
    expect(paid?.billable).toBe(true);
    expect(paid?.policies.map((policy) => policy.kind)).toContain('chat.message');
  });

  it('estimates before the work and charges the flat part on a BYOK chat', async () => {
    const owner = 'chat-owner';
    await paidOwner(owner, 100);

    const estimate = await app.inject({
      method: 'POST',
      url: '/api/message-credits/estimate',
      headers: as(owner),
      payload: { kind: 'chat.message', byok: true },
    });
    expect(estimate.statusCode).toBe(200);
    const quoted = estimate.json() as { estimate: { credits: number }; affordable: boolean };
    expect(quoted.estimate.credits).toBe(1);
    expect(quoted.affordable).toBe(true);

    const hold = await reserve(owner, { idempotencyKey: 'chat-owner-first', conversationId: 'c1' });
    expect(hold.status).toBe(201);
    expect(hold.charge.state).toBe('reserved');
    expect(hold.charge.estimatedCredits).toBe(1);
    expect(hold.charge.conversationId).toBe('c1');

    const settled = await commit(owner, hold.charge.id, {
      inputTokens: 1200,
      outputTokens: 400,
      modelId: 'openai/gpt-4o-mini',
    });
    expect(settled.status).toBe(200);
    expect(settled.charge.state).toBe('committed');
    // The provider tokens belong to the caller's own key; the platform charge does not.
    expect(settled.credits).toBe(1);
    expect(settled.charge.limitations).toContain('byok-tokens-excluded');
    expect(settled.charge.walletEntryId).not.toBeNull();

    expect((await balance(owner)).available).toBe(99);
  });

  it('prices a model override differently without changing the interaction kind', async () => {
    const owner = 'model-owner';
    await paidOwner(owner, 50);

    const estimate = await app.inject({
      method: 'POST',
      url: '/api/message-credits/estimate',
      headers: as(owner),
      payload: { kind: 'chat.message', byok: true, modelId: 'anthropic/claude-sonnet' },
    });
    expect((estimate.json() as { estimate: { credits: number } }).estimate.credits).toBe(2);

    const hold = await reserve(owner, {
      idempotencyKey: 'model-owner-first',
      modelId: 'anthropic/claude-sonnet',
    });
    const settled = await commit(owner, hold.charge.id, { inputTokens: 10, outputTokens: 10 });
    expect(settled.credits).toBe(2);
    expect((await balance(owner)).available).toBe(48);
  });

  it('settles a measured charge when tokens are reported and records when they are not', async () => {
    const owner = 'measure-owner';
    await paidOwner(owner, 50);

    // A deployment that pays the provider itself: token rates apply on top of flat.
    const measured = await reserve(owner, {
      idempotencyKey: 'measure-owner-tokens',
      kind: 'coding.run',
      byok: false,
    });
    const settled = await commit(owner, measured.charge.id, {
      inputTokens: 4000,
      outputTokens: 2000,
    });
    expect(settled.charge.state).toBe('committed');
    expect(settled.charge.basis).toBe('flat+usage');
    expect(settled.credits).toBeGreaterThan(measured.charge.estimatedCredits);

    const unmeasured = await reserve(owner, {
      idempotencyKey: 'measure-owner-silent',
      kind: 'agent.execution',
      byok: false,
    });
    const silent = await commit(owner, unmeasured.charge.id, {});
    expect(silent.charge.state).toBe('committed');
    expect(silent.charge.limitations).toContain('tokens-unavailable');
    expect(silent.charge.limitations).toContain('output-tokens-missing');
    // Only the flat part was charged; no token count was invented.
    expect(silent.credits).toBe(unmeasured.charge.estimatedCredits);
  });

  it('refuses to hold credit an owner does not have, and says what is missing', async () => {
    const owner = 'broke-owner';
    await paidOwner(owner);

    const refused = await reserve(owner, { idempotencyKey: 'broke-owner-first' });
    expect(refused.status).toBe(402);
    expect(refused.charge).toBeUndefined();

    const response = await app.inject({
      method: 'POST',
      url: '/api/message-credits/reservations',
      headers: as(owner),
      payload: { kind: 'chat.message', byok: true, idempotencyKey: 'broke-owner-second' },
    });
    const parsed = response.json() as {
      error: { code: string; details?: { available: number; required: number } };
    };
    expect(parsed.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(parsed.error.details?.required).toBe(1);
    expect(parsed.error.details?.available).toBe(0);
  });

  it('charges a repeated request once, and a repeated settlement once', async () => {
    const owner = 'duplicate-owner';
    await paidOwner(owner, 10);

    const first = await reserve(owner, { idempotencyKey: 'same-request-abc' });
    const again = await reserve(owner, { idempotencyKey: 'same-request-abc' });
    expect(again.status).toBe(200);
    expect(again.created).toBe(false);
    expect(again.charge.id).toBe(first.charge.id);

    const settled = await commit(owner, first.charge.id, { inputTokens: 5, outputTokens: 5 });
    const repeated = await commit(owner, first.charge.id, { inputTokens: 5, outputTokens: 5 });
    expect(repeated.credits).toBe(settled.credits);
    expect((await balance(owner)).available).toBe(9);
  });

  it('gives a cancelled interaction its credit back', async () => {
    const owner = 'cancel-owner';
    await paidOwner(owner, 10);

    const hold = await reserve(owner, { idempotencyKey: 'cancel-owner-first' });
    const released = await app.inject({
      method: 'POST',
      url: `/api/message-credits/charges/${hold.charge.id}/release`,
      headers: as(owner),
      payload: { reason: 'The provider refused the request.' },
    });
    expect(released.statusCode).toBe(200);
    expect((released.json() as ChargeView).state).toBe('released');
    expect((await balance(owner)).available).toBe(10);

    const second = await app.inject({
      method: 'POST',
      url: `/api/message-credits/charges/${hold.charge.id}/release`,
      headers: as(owner),
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect((await balance(owner)).available).toBe(10);
  });

  it('cannot be overdrawn by concurrent requests', async () => {
    const owner = 'rush-owner';
    await paidOwner(owner, 20);

    const holds = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        reserve(owner, {
          idempotencyKey: `rush-${index}-request`,
          kind: 'coding.run',
        }),
      ),
    );
    const accepted = holds.filter((hold) => hold.status === 201);
    expect(accepted.length).toBe(4);
    expect((await balance(owner)).available).toBe(0);
  });

  it('sweeps a hold whose operation never came back', async () => {
    const owner = 'sweep-owner';
    await paidOwner(owner, 10);

    const hold = await reserve(owner, { idempotencyKey: 'sweep-owner-first' });
    expect(hold.status).toBe(201);
    // The hold TTL in this file is one second.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const swept = await app.inject({
      method: 'POST',
      url: '/api/message-credits/sweep',
      headers: as(owner),
      payload: { reason: 'test sweep' },
    });
    expect(swept.statusCode).toBe(200);
    expect((swept.json() as { released: number }).released).toBe(1);
    expect((await balance(owner)).available).toBe(10);
  });

  it('returns credit for a committed charge only through an operator refund', async () => {
    const owner = 'refund-owner';
    await paidOwner(owner, 10);
    const hold = await reserve(owner, { idempotencyKey: 'refund-owner-first' });
    await commit(owner, hold.charge.id, { inputTokens: 100, outputTokens: 100 });
    expect((await balance(owner)).available).toBe(9);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/message-credits/charges/${hold.charge.id}/refund`,
      headers: as(owner),
      payload: { ownerRef: owner },
    });
    expect(denied.statusCode).toBe(403);

    const refund = await app.inject({
      method: 'POST',
      url: `/api/message-credits/charges/${hold.charge.id}/refund`,
      headers: { ...walletOperator, ...as(owner) },
      payload: { ownerRef: owner, reason: 'Provider failed after the answer.' },
    });
    expect(refund.statusCode).toBe(200);
    expect((refund.json() as ChargeView).state).toBe('refunded');
    expect((await balance(owner)).available).toBe(10);

    // The money does not come back twice.
    const again = await app.inject({
      method: 'POST',
      url: `/api/message-credits/charges/${hold.charge.id}/refund`,
      headers: walletOperator,
      payload: { ownerRef: owner },
    });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    expect((await balance(owner)).available).toBe(10);
  });

  it('enforces the per-request and monthly limits the owner sets', async () => {
    const owner = 'limits-owner';
    await paidOwner(owner, 20);

    const settings = await app.inject({
      method: 'PUT',
      url: '/api/message-credits/settings',
      headers: as(owner),
      payload: { perRequestLimit: 0.5, monthlyLimit: 2 },
    });
    expect(settings.statusCode).toBe(200);

    const tooBig = await app.inject({
      method: 'POST',
      url: '/api/message-credits/reservations',
      headers: as(owner),
      payload: { kind: 'chat.message', byok: true, idempotencyKey: 'limits-owner-too-big' },
    });
    expect(tooBig.statusCode).toBe(400);
    expect((tooBig.json() as { error: { code: string } }).error.code).toBe(
      'REQUEST_LIMIT_EXCEEDED',
    );

    await app.inject({
      method: 'PUT',
      url: '/api/message-credits/settings',
      headers: as(owner),
      payload: { monthlyLimit: 1, perRequestLimit: null },
    });
    const first = await reserve(owner, { idempotencyKey: 'limits-owner-one' });
    expect(first.status).toBe(201);
    await commit(owner, first.charge.id, { inputTokens: 1, outputTokens: 1 });

    // One credit spent against a limit of one: the next message would cross it.
    const second = await app.inject({
      method: 'POST',
      url: '/api/message-credits/reservations',
      headers: as(owner),
      payload: { kind: 'chat.message', byok: true, idempotencyKey: 'limits-owner-two' },
    });
    expect(second.statusCode).toBe(402);
    expect((second.json() as { error: { code: string } }).error.code).toBe('MONTHLY_LIMIT_REACHED');
  });

  it('keeps a workspace wallet and the personal wallet apart', async () => {
    const owner = 'workspace-owner';
    await paidOwner(owner, 10);

    const workspaceGrant = await app.inject({
      method: 'POST',
      url: '/api/wallet/credits',
      headers: { ...walletOperator, ...as(owner) },
      payload: {
        ownerRef: owner,
        workspaceId: 'ws-one',
        amount: 5,
        reason: 'workspace funding',
        idempotencyKey: 'ws-funding-one',
      },
    });
    expect(workspaceGrant.statusCode).toBe(201);

    const hold = await reserve(owner, {
      idempotencyKey: 'workspace-owner-chat',
      workspaceId: 'ws-one',
    });
    expect(hold.status).toBe(201);
    await commit(owner, hold.charge.id, { inputTokens: 1, outputTokens: 1 });

    expect((await balance(owner)).available).toBe(10);
    expect((await balance(owner, '?workspaceId=ws-one')).available).toBe(4);

    const otherOwner = await app.inject({
      method: 'GET',
      url: '/api/message-credits/charges',
      headers: as('unrelated-owner'),
    });
    expect((otherOwner.json() as { charges: ChargeView[] }).charges).toHaveLength(0);
  });

  it('reports usage by model, project and conversation, and proves the ledger agrees', async () => {
    const owner = 'report-owner';
    await paidOwner(owner, 20);

    for (const [index, model] of ['openai/gpt-4o-mini', 'anthropic/claude-sonnet'].entries()) {
      const hold = await reserve(owner, {
        idempotencyKey: `report-owner-${index}`,
        modelId: model,
        projectId: 'project-one',
        conversationId: 'conversation-one',
      });
      await commit(owner, hold.charge.id, { inputTokens: 100, outputTokens: 100 });
    }

    const usage = await app.inject({
      method: 'GET',
      url: '/api/message-credits/usage',
      headers: as(owner),
    });
    expect(usage.statusCode).toBe(200);
    const body = usage.json() as {
      byModel: { key: string; charges: number; credits: number }[];
      byProject: { key: string }[];
      byConversation: { key: string }[];
    };
    expect(body.byModel.map((row) => row.key).sort()).toEqual([
      'anthropic/claude-sonnet',
      'openai/gpt-4o-mini',
    ]);
    expect(body.byProject.map((row) => row.key)).toContain('project-one');
    expect(body.byConversation.map((row) => row.key)).toContain('conversation-one');

    const integrity = await app.inject({
      method: 'GET',
      url: '/api/message-credits/integrity',
      headers: as(owner),
    });
    expect(integrity.statusCode).toBe(200);
    expect((integrity.json() as { consistent: boolean }).consistent).toBe(true);
  });

  it('survives a restart with its charges and its balance', async () => {
    const owner = 'restart-owner';
    await paidOwner(owner, 30);
    const hold = await reserve(owner, { idempotencyKey: 'restart-owner-first' });
    await commit(owner, hold.charge.id, { inputTokens: 10, outputTokens: 10 });

    const second = await createPersistence({ url: databaseUrl });
    const restarted = buildApp({
      persistence: second,
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    await restarted.ready();
    try {
      const summary = await restarted.inject({
        method: 'GET',
        url: '/api/message-credits',
        headers: as(owner),
      });
      expect(summary.statusCode).toBe(200);
      const body = summary.json() as {
        wallet: { available: number };
        month: { credits: number; charges: number };
      };
      expect(body.wallet.available).toBe(29);
      expect(body.month.charges).toBeGreaterThanOrEqual(1);
      expect(body.month.credits).toBeGreaterThanOrEqual(1);
    } finally {
      await restarted.close();
      await second.close();
    }
  });

  it('charges the cached part of a prompt at the cache rate and records the saving', async () => {
    const owner = 'cache-owner';
    await paidOwner(owner, 50);

    // A managed-key run: token rates apply, so the cache rate is exercised.
    const hold = await reserve(owner, {
      idempotencyKey: 'cache-owner-first',
      kind: 'coding.run',
      byok: false,
    });
    const settled = await commit(owner, hold.charge.id, {
      inputTokens: 10_000,
      cachedTokens: 6_000,
      outputTokens: 1_000,
      source: 'provider',
    });

    expect(settled.status).toBe(200);
    const charge = settled.charge as ChargeView & {
      cachedTokens: number | null;
      cachedSavings: number | null;
      measurementSource: string | null;
    };
    expect(Number(charge.cachedTokens)).toBe(6_000);
    expect(charge.measurementSource).toBe('provider');
    // 6k tokens moved from the input rate to the cheaper cache rate.
    expect(Number(charge.cachedSavings)).toBeGreaterThan(0);

    const read = await app.inject({
      method: 'GET',
      url: '/api/message-credits/charges?limit=5',
      headers: as(owner),
    });
    const rows = (read.json() as { charges: (ChargeView & { cachedTokens: number | null })[] })
      .charges;
    expect(rows.find((row) => row.id === hold.charge.id)?.cachedTokens).toBe(6_000);
  });

  it('says a charge had no measurement rather than implying zero usage', async () => {
    const owner = 'silent-owner';
    await paidOwner(owner, 20);

    const hold = await reserve(owner, {
      idempotencyKey: 'silent-owner-first',
      kind: 'agent.execution',
    });
    const settled = await commit(owner, hold.charge.id, {});
    const charge = settled.charge as ChargeView & {
      cachedSavings: number | null;
      measurementSource: string | null;
    };
    expect(charge.measurementSource).toBe('unavailable');
    expect(charge.cachedSavings).toBeNull();
  });
});
