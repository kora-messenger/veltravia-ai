/**
 * Spending limits survive an API restart, and hold across instances.
 *
 * Two claims, both of which the in-memory suite cannot make:
 *
 * 1. A policy, its audit trail and its warning record are in the database, so a
 *    second instance (own pools, own managers, nothing shared but Postgres) reads
 *    the same limit and enforces it.
 * 2. The guard that makes "read the allowance, then take the hold" safe is a
 *    database lock, not a process mutex: requests arriving at two instances at
 *    once are still held to one allowance between them. A process-local chain
 *    would let both instances read the same untouched allowance.
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

const OWNER = `limits-restart-${Date.now().toString(36)}`;
const OTHER = `${OWNER}-other`;

function makeApp(persistence: Persistence): FastifyInstance {
  return buildApp({
    persistence,
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
}

describeDb('spending limits across a restart', () => {
  let first: Persistence;
  let app: FastifyInstance;
  let second: Persistence;
  let reopened: FastifyInstance;

  beforeAll(async () => {
    databaseUrl =
      (await prepareIsolatedTestSchema(baseDatabaseUrl, 'spending-limit-persistence')) ?? '';
    first = await createPersistence({ url: databaseUrl });
    app = makeApp(first);
    await app.ready();
    second = await createPersistence({ url: databaseUrl });
    reopened = makeApp(second);
    await reopened.ready();

    // Fund and entitle both accounts once; a second instance reads the same wallet.
    for (const owner of [OWNER, OTHER]) {
      const plan = await app.inject({
        method: 'PUT',
        url: '/api/usage/entitlement',
        headers: { ...operator, ...as(owner) },
        payload: { planId: 'paid' },
      });
      expect(plan.statusCode).toBe(200);
      const grant = await app.inject({
        method: 'POST',
        url: '/api/wallet/credits',
        headers: { ...walletOperator, ...as(owner) },
        payload: {
          ownerRef: owner,
          amount: 100,
          reason: 'restart test funding',
          idempotencyKey: `fund-${owner}`,
        },
      });
      expect(grant.statusCode).toBe(201);
    }
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await reopened?.close();
    await first?.close();
    await second?.close();
  });

  async function reserve(
    target: FastifyInstance,
    owner: string,
    key: string,
  ): Promise<{ status: number; code: string | null; ruleId: string | null }> {
    const response = await target.inject({
      method: 'POST',
      url: '/api/message-credits/reservations',
      headers: as(owner),
      payload: { kind: 'chat.message', byok: true, idempotencyKey: key },
    });
    const payload = response.json() as {
      error?: { code?: string; details?: { ruleId?: string } };
    };
    return {
      status: response.statusCode,
      code: payload.error?.code ?? null,
      ruleId: payload.error?.details?.ruleId ?? null,
    };
  }

  it('a limit set on one instance is read and enforced by another', async () => {
    const written = await app.inject({
      method: 'PUT',
      url: '/api/spending-limits/policy',
      headers: as(OWNER),
      payload: {
        scope: 'user',
        expectedVersion: null,
        rules: [
          {
            id: 'restart-daily',
            target: 'ai_messages',
            period: 'daily',
            limit: 1,
            mode: 'hard',
            warnAt: [0.5],
          },
        ],
      },
    });
    expect(written.statusCode).toBe(201);
    expect((written.json() as { policy: { version: number } }).policy.version).toBe(1);

    // The first instance spends the only credit...
    expect((await reserve(app, OWNER, 'restart-first')).status).toBe(201);

    // ...and the second instance refuses the next one, naming the rule it read.
    const refused = await reserve(reopened, OWNER, 'restart-second');
    expect(refused.status).toBe(402);
    expect(refused.code).toBe('SPENDING_LIMIT_REACHED');
    expect(refused.ruleId).toBe('restart-daily');

    // The overview on the second instance agrees, including the held credit.
    const view = await reopened.inject({
      method: 'GET',
      url: '/api/spending-limits',
      headers: as(OWNER),
    });
    expect(view.statusCode).toBe(200);
    const body = view.json() as {
      limits: { ruleId: string; consumed: number; remaining: number }[];
      heldCredits: number;
      scopes: { scope: string; policy: { version: number } | null }[];
    };
    expect(body.limits[0]?.consumed).toBe(1);
    expect(body.limits[0]?.remaining).toBe(0);
    expect(body.heldCredits).toBe(1);
    expect(body.scopes.find((scope) => scope.scope === 'user')?.policy?.version).toBe(1);
  });

  it('another owner sees none of it', async () => {
    const view = await reopened.inject({
      method: 'GET',
      url: '/api/spending-limits',
      headers: as(OTHER),
    });
    expect(view.statusCode).toBe(200);
    expect((view.json() as { limits: unknown[] }).limits).toEqual([]);

    // And their own spending is not blocked by the other account's limit.
    expect((await reserve(reopened, OTHER, 'other-first')).status).toBe(201);
  });

  it('records the refusal and the edit trail in the database, not in the process', async () => {
    const events = await reopened.inject({
      method: 'GET',
      url: '/api/spending-limits/events?limit=50',
      headers: as(OWNER),
    });
    expect(events.statusCode).toBe(200);
    const kinds = (events.json() as { events: { kind: string; ruleId: string | null }[] }).events;
    expect(kinds.some((event) => event.kind === 'limit-reached')).toBe(true);
    // A warning was recorded once when the single credit was spent.
    expect(kinds.filter((event) => event.kind === 'warning')).toHaveLength(1);

    const audit = await reopened.inject({
      method: 'GET',
      url: '/api/spending-limits/audit?limit=20',
      headers: as(OWNER),
    });
    expect(audit.statusCode).toBe(200);
    const records = (audit.json() as { audit: { action: string; version: number | null }[] }).audit;
    expect(records.some((record) => record.action === 'created')).toBe(true);
  });

  it('holds two instances to one allowance between them', async () => {
    const owner = `${OWNER}-race`;
    const plan = await app.inject({
      method: 'PUT',
      url: '/api/usage/entitlement',
      headers: { ...operator, ...as(owner) },
      payload: { planId: 'paid' },
    });
    expect(plan.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: '/api/wallet/credits',
      headers: { ...walletOperator, ...as(owner) },
      payload: {
        ownerRef: owner,
        amount: 100,
        reason: 'race funding',
        idempotencyKey: `fund-${owner}`,
      },
    });
    const policy = await app.inject({
      method: 'PUT',
      url: '/api/spending-limits/policy',
      headers: as(owner),
      payload: {
        scope: 'user',
        expectedVersion: null,
        rules: [
          {
            id: 'shared-race',
            target: 'ai_messages',
            period: 'daily',
            limit: 3,
            mode: 'hard',
            warnAt: [],
          },
        ],
      },
    });
    expect(policy.statusCode).toBe(201);

    /*
     * Six requests alternating between the two instances, fired together. Each
     * instance has its own pools and its own promise chains, so only the database
     * lock can stop both from reading the same untouched allowance.
     */
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        reserve(index % 2 === 0 ? app : reopened, owner, `shared-race-${index}`),
      ),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(3);
    expect(results.filter((result) => result.status === 402)).toHaveLength(3);
  });
});
