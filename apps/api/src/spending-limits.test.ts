/**
 * Spending limits through the API (Step 59).
 *
 * The claim under test is not "the policy table stores a number" but "a limit
 * configured here stops a billable operation at the choke point that would have
 * spent the credit". Every refusal below comes from the real reserve path with
 * the real charge stores, and the concurrent case fires genuinely parallel
 * requests rather than a loop.
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

interface PolicyView {
  scope: string;
  version: number;
  rules: { id: string; limit: number; mode: string; period: string; target: string }[];
  perOperationLimit: number | null;
  maxReservedCredits: number | null;
}

interface OverviewView {
  limits: {
    ruleId: string;
    scope: string;
    limit: number;
    consumed: number;
    remaining: number;
    state: string;
    mode: string;
  }[];
  usage: {
    today: { category: string; committed: number; reserved: number; priced: boolean }[];
    month: { category: string; committed: number; reserved: number }[];
  };
  heldCredits: number;
  perOperationLimit: number | null;
  maxReservedCredits: number | null;
  enforcement: string;
  events: { kind: string; message: string; ruleId: string | null }[];
  platform: { maxLimitPerRule: number | null; enforcementDisabled: boolean };
  wallet: { available: number; reserved: number; spent: number } | null;
  scopes: { scope: string; policy: PolicyView | null; inherited: boolean }[];
}

interface ApiError {
  code: string;
  message: string;
  reason?: string;
  ruleId?: string | null;
}

describeDb('spending limits on postgres', () => {
  let persistence: Persistence;
  let app: FastifyInstance;

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'spending-limits')) ?? '';
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

  async function setPolicy(ref: string, body: Record<string, unknown>) {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/spending-limits/policy',
      headers: as(ref),
      payload: body,
    });
    const parsed = response.json() as { policy?: PolicyView; error?: ApiError };
    return { status: response.statusCode, ...parsed };
  }

  async function overview(ref: string, query = ''): Promise<OverviewView> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/spending-limits${query}`,
      headers: as(ref),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as OverviewView;
  }

  async function reserve(ref: string, body: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/message-credits/reservations',
      headers: as(ref),
      payload: { kind: 'chat.message', byok: true, ...body },
    });
    const payload = response.json() as {
      error?: ApiError & { details?: Record<string, unknown> };
      charge?: { id: string };
    };
    /*
     * The route carries the specifics of a refusal (which rule, how much of the
     * allowance was left) in `details`, because they are diagnostics rather than
     * the answer. This test asserts on them, so they are folded up here once
     * instead of every expectation reaching through two levels.
     */
    const error = payload.error
      ? ({ ...(payload.error.details ?? {}), ...payload.error } as ApiError)
      : undefined;
    return { status: response.statusCode, body: { error, charge: payload.charge } };
  }

  it('starts unconfigured, so no limit is invented for an account that set none', async () => {
    const view = await overview('limits-fresh-owner');
    expect(view.enforcement).toBe('unconfigured');
    expect(view.limits).toEqual([]);
    expect(view.perOperationLimit).toBeNull();
    expect(view.maxReservedCredits).toBeNull();
    expect(view.usage.month.every((row) => row.committed === 0)).toBe(true);
  });

  it('refuses a billable reserve once a hard daily limit is used up, and names the rule', async () => {
    const owner = 'limits-hard-owner';
    await paidOwner(owner, 100);
    const created = await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [
        {
          id: 'daily-ai',
          target: 'ai_messages',
          period: 'daily',
          limit: 2,
          mode: 'hard',
          warnAt: [0.5],
        },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.policy?.version).toBe(1);

    // A BYOK chat is one credit, so two fit inside a limit of two...
    expect((await reserve(owner, { idempotencyKey: 'limit-hard-001' })).status).toBe(201);
    expect((await reserve(owner, { idempotencyKey: 'limit-hard-002' })).status).toBe(201);

    // ...and the third is refused before any hold. Both earlier holds are still
    // open, so this also proves reserved credit counts against the allowance.
    const third = await reserve(owner, { idempotencyKey: 'limit-hard-003' });
    expect(third.status).toBe(402);
    expect(third.body.error?.code).toBe('SPENDING_LIMIT_REACHED');
    expect(third.body.error?.ruleId).toBe('daily-ai');
    expect(third.body.error?.message).toContain('already used up');

    const view = await overview(owner);
    expect(view.limits[0]?.ruleId).toBe('daily-ai');
    expect(view.limits[0]?.consumed).toBe(2);
    expect(view.limits[0]?.remaining).toBe(0);
    expect(view.limits[0]?.state).toBe('reached');
    expect(view.heldCredits).toBe(2);
    expect(view.events.some((event) => event.kind === 'limit-reached')).toBe(true);
  });

  it('lets a soft limit warn and continue, and records each threshold once', async () => {
    const owner = 'limits-soft-owner';
    await paidOwner(owner, 50);
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [
        {
          id: 'monthly-soft',
          target: 'ai_messages',
          period: 'monthly',
          limit: 2,
          mode: 'soft',
          warnAt: [0.5, 0.9],
        },
      ],
    });

    for (const key of ['limit-soft-001', 'limit-soft-002', 'limit-soft-003']) {
      expect((await reserve(owner, { idempotencyKey: key })).status).toBe(201);
    }

    const view = await overview(owner);
    const warnings = view.events.filter((event) => event.kind === 'warning');
    // Three operations crossed both thresholds; each crossing is one event, so
    // the count is the number of thresholds, not the number of requests.
    expect(warnings).toHaveLength(2);
  });

  it('holds concurrent requests to the same allowance', async () => {
    const owner = 'limits-race-owner';
    // Enough wallet credit that the wallet is not what refuses: the limit is.
    await paidOwner(owner, 500);
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [
        {
          id: 'race-daily',
          target: 'ai_messages',
          period: 'daily',
          limit: 5,
          mode: 'hard',
          warnAt: [],
        },
      ],
    });

    // Eight requests for one credit each, fired together. Distinct idempotency
    // keys mean the charge table would accept all eight; only the limit decides
    // how many may exist.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        reserve(owner, { idempotencyKey: `limit-race-${String(index).padStart(3, '0')}` }),
      ),
    );
    const accepted = results.filter((result) => result.status === 201).length;
    const refused = results.filter((result) => result.status === 402).length;
    expect(accepted).toBe(5);
    expect(refused).toBe(3);

    const view = await overview(owner);
    expect(view.limits[0]?.consumed).toBe(5);
    expect(view.limits[0]?.remaining).toBe(0);
  });

  it('refuses an operation above the per-operation ceiling even with room in the window', async () => {
    const owner = 'limits-per-op-owner';
    await paidOwner(owner, 100);
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [],
      perOperationLimit: 0,
    });

    const refused = await reserve(owner, { idempotencyKey: 'limit-per-op-001' });
    expect(refused.status).toBe(402);
    expect(refused.body.error?.code).toBe('SPENDING_LIMIT_REACHED');
    expect(refused.body.error?.reason).toBe('per-operation-limit');
  });

  it('applies the tighter of a workspace and a personal limit', async () => {
    const owner = 'limits-scope-owner';
    await paidOwner(owner, 100);
    await setPolicy(owner, {
      scope: 'workspace',
      workspaceId: 'ws_tight',
      expectedVersion: null,
      rules: [
        {
          id: 'ws-daily',
          target: 'ai_messages',
          period: 'daily',
          limit: 1,
          mode: 'hard',
          warnAt: [],
        },
      ],
    });
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [
        {
          id: 'user-daily',
          target: 'ai_messages',
          period: 'daily',
          limit: 50,
          mode: 'hard',
          warnAt: [],
        },
      ],
    });

    expect(
      (await reserve(owner, { idempotencyKey: 'limit-scope-001', workspaceId: 'ws_tight' })).status,
    ).toBe(201);

    const refused = await reserve(owner, {
      idempotencyKey: 'limit-scope-002',
      workspaceId: 'ws_tight',
    });
    expect(refused.status).toBe(402);
    expect(refused.body.error?.ruleId).toBe('ws-daily');

    // The same owner outside that workspace still has their own 50-credit limit.
    expect(
      (await reserve(owner, { idempotencyKey: 'limit-scope-003', workspaceId: 'ws_other' })).status,
    ).toBe(201);
  });

  it('refuses a stale edit instead of overwriting somebody else change', async () => {
    const owner = 'limits-version-owner';
    await paidOwner(owner, 10);
    const created = await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [{ id: 'v', target: 'all', period: 'weekly', limit: 5, mode: 'hard', warnAt: [] }],
    });
    expect(created.policy?.version).toBe(1);

    const first = await setPolicy(owner, {
      scope: 'user',
      expectedVersion: 1,
      rules: [{ id: 'v', target: 'all', period: 'weekly', limit: 6, mode: 'hard', warnAt: [] }],
    });
    expect(first.status).toBe(200);
    expect(first.policy?.version).toBe(2);

    const stale = await setPolicy(owner, {
      scope: 'user',
      expectedVersion: 1,
      rules: [{ id: 'v', target: 'all', period: 'weekly', limit: 7, mode: 'hard', warnAt: [] }],
    });
    expect(stale.status).toBe(409);
    expect(stale.error?.code).toBe('STALE_VERSION');

    const policies = await app.inject({
      method: 'GET',
      url: '/api/spending-limits/policies',
      headers: as(owner),
    });
    expect((policies.json() as { policies: PolicyView[] }).policies[0]?.rules[0]?.limit).toBe(6);
  });

  it('never lets a caller name somebody else account', async () => {
    // The owner comes from the request context, so a body `ownerRef` is not a
    // parameter: the policy is written for the caller and the other account is
    // untouched.
    const owner = 'limits-identity-owner';
    const other = 'limits-identity-other';
    await paidOwner(other, 10);
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      ownerRef: other,
      rules: [{ id: 'mine', target: 'all', period: 'daily', limit: 3, mode: 'hard', warnAt: [] }],
    });

    expect((await overview(other)).limits).toEqual([]);
    expect((await overview(owner)).limits[0]?.ruleId).toBe('mine');

    // A workspace id narrows a read; it does not widen it.
    expect((await overview(owner, '?workspaceId=ws_elsewhere')).limits[0]?.consumed).toBe(0);
  });

  it('refuses a limit that is malformed, naming what is wrong', async () => {
    const owner = 'limits-invalid-owner';
    const badTarget = await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [{ id: 'x', target: 'gambling', period: 'daily', limit: 5, mode: 'hard', warnAt: [] }],
    });
    expect(badTarget.status).toBe(400);
    expect(badTarget.error?.message).toContain('gambling');

    const noWorkspace = await setPolicy(owner, {
      scope: 'workspace',
      expectedVersion: null,
      rules: [],
    });
    expect(noWorkspace.status).toBe(400);
    expect(noWorkspace.error?.message).toContain('workspace');
  });

  it('refuses a stale reset, so removing a policy is also a checked write', async () => {
    const owner = 'limits-reset-owner';
    await paidOwner(owner, 10);
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [{ id: 'r', target: 'all', period: 'daily', limit: 4, mode: 'hard', warnAt: [] }],
    });
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: 1,
      rules: [{ id: 'r', target: 'all', period: 'daily', limit: 5, mode: 'hard', warnAt: [] }],
    });

    const stale = await app.inject({
      method: 'DELETE',
      url: '/api/spending-limits/policy',
      headers: as(owner),
      payload: { scope: 'user', expectedVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/spending-limits/policy',
      headers: as(owner),
      payload: { scope: 'user', expectedVersion: 2 },
    });
    expect(removed.statusCode).toBe(204);

    const view = await overview(owner);
    expect(view.limits).toEqual([]);
    expect(view.enforcement).toBe('unconfigured');
  });

  it('answers a dry run without charging or writing an event', async () => {
    const owner = 'limits-check-owner';
    await paidOwner(owner, 10);
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [{ id: 'dry', target: 'all', period: 'daily', limit: 1, mode: 'hard', warnAt: [] }],
    });
    expect((await reserve(owner, { idempotencyKey: 'limit-dry-001' })).status).toBe(201);

    const check = await app.inject({
      method: 'GET',
      url: '/api/spending-limits/check?category=ai_messages&requested=1',
      headers: as(owner),
    });
    expect(check.statusCode).toBe(200);
    const decision = check.json() as { allowed: boolean; violation: { ruleId: string } | null };
    expect(decision.allowed).toBe(false);
    expect(decision.violation?.ruleId).toBe('dry');

    // The dry run wrote no refusal event of its own.
    const view = await overview(owner);
    expect(view.events.filter((event) => event.kind === 'limit-reached')).toHaveLength(0);
  });

  it('keeps the platform maximum operator-only and applies it to new policies', async () => {
    const denied = await app.inject({
      method: 'PUT',
      url: '/api/spending-limits/platform',
      headers: as('nobody'),
      payload: { maxLimitPerRule: 1_000_000, defaultRules: [] },
    });
    expect(denied.statusCode).toBe(403);

    const set = await app.inject({
      method: 'PUT',
      url: '/api/spending-limits/platform',
      headers: operator,
      payload: { maxLimitPerRule: 1_000, updatedBy: 'operator', reason: 'test ceiling' },
    });
    expect(set.statusCode).toBe(200);

    const owner = 'limits-platform-owner';
    const tooHigh = await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [
        { id: 'big', target: 'all', period: 'monthly', limit: 5_000, mode: 'hard', warnAt: [] },
      ],
    });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.error?.code).toBe('LIMIT_ABOVE_CEILING');

    const within = await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [
        { id: 'small', target: 'all', period: 'monthly', limit: 900, mode: 'hard', warnAt: [] },
      ],
    });
    expect(within.status).toBe(201);

    // Put the platform back, so the rest of the suite is not quietly narrowed.
    await app.inject({
      method: 'PUT',
      url: '/api/spending-limits/platform',
      headers: operator,
      payload: { maxLimitPerRule: null, updatedBy: 'operator', reason: 'reset' },
    });
  });

  it('warns instead of refusing when an operator disables enforcement', async () => {
    const owner = 'limits-disabled-owner';
    await paidOwner(owner, 10);
    await setPolicy(owner, {
      scope: 'user',
      expectedVersion: null,
      rules: [{ id: 'off', target: 'all', period: 'daily', limit: 1, mode: 'hard', warnAt: [] }],
    });

    await app.inject({
      method: 'PUT',
      url: '/api/spending-limits/platform',
      headers: operator,
      payload: { enforcementDisabled: true, updatedBy: 'operator', reason: 'incident' },
    });

    try {
      expect((await reserve(owner, { idempotencyKey: 'limit-off-001' })).status).toBe(201);
      expect((await reserve(owner, { idempotencyKey: 'limit-off-002' })).status).toBe(201);
      expect((await overview(owner)).enforcement).toBe('disabled');
    } finally {
      await app.inject({
        method: 'PUT',
        url: '/api/spending-limits/platform',
        headers: operator,
        payload: { enforcementDisabled: false, updatedBy: 'operator', reason: 'incident over' },
      });
    }
  });
});
