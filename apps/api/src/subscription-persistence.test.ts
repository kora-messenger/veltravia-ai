/**
 * A subscription survives a restart, and only one instance can renew a period.
 *
 * The in-memory suite cannot make either claim:
 *
 * 1. The plan an account is on, its periods and its history are in PostgreSQL, so
 *    a second instance (own pool, own managers, nothing shared but the database)
 *    reads the same plan and enforces the same entitlements.
 * 2. The claim that stops a period being granted twice is a database constraint,
 *    not a process mutex. Two renewals arriving at two instances at once must
 *    record one period between them, or a customer is given a free month by a
 *    well-timed retry.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`; CI provides postgres:16.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prepareIsolatedTestSchema, runWithOwner } from '@veltravia/storage-postgres';
import { createPersistence, type Persistence } from './persistence.js';
import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';

const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
let databaseUrl = baseDatabaseUrl;
const describeDb = databaseUrl === '' ? describe.skip : describe;

process.env['VELTRAVIA_BILLING_ADMIN_TOKEN'] = 'subscription-admin-test';

const operator = { 'x-veltravia-admin': 'subscription-admin-test' };
const as = (ref: string): Record<string, string> => ({ 'x-veltravia-owner-ref': ref });

const OWNER = `plan-restart-${Date.now().toString(36)}`;
const OTHER = `${OWNER}-other`;

function makeApp(persistence: Persistence): FastifyInstance {
  return buildApp({
    persistence,
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
}

describeDb('subscriptions across a restart', () => {
  let first: Persistence;
  let app: FastifyInstance;
  let second: Persistence;
  let reopened: FastifyInstance;

  beforeAll(async () => {
    databaseUrl =
      (await prepareIsolatedTestSchema(baseDatabaseUrl, 'subscription-persistence')) ?? '';
    first = await createPersistence({ url: databaseUrl });
    app = makeApp(first);
    await app.ready();
    second = await createPersistence({ url: databaseUrl });
    reopened = makeApp(second);
    await reopened.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await reopened?.close();
    await first?.close();
    await second?.close();
  });

  it('seeds the catalogue once, not once per instance', async () => {
    const response = await reopened.inject({
      method: 'GET',
      url: '/api/subscriptions/plans',
      headers: as(OWNER),
    });
    expect(response.statusCode).toBe(200);
    const plans = (response.json() as { plans: { id: string }[] }).plans;
    expect(plans.map((plan) => plan.id)).toEqual([
      'development',
      'starter',
      'builder',
      'pro',
      'elite',
    ]);
  });

  it('reads the assigned plan on an instance that never assigned it', async () => {
    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}`,
      headers: { ...operator, ...as(OWNER) },
      payload: { planId: 'builder', reason: 'Paid by transfer' },
    });
    expect(assigned.statusCode).toBe(201);

    const overview = await reopened.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: as(OWNER),
    });
    expect(overview.statusCode).toBe(200);
    const body = overview.json() as {
      effective: { source: string; plan: { id: string } };
      allowances: { integrationCredits: number };
    };
    expect(body.effective.source).toBe('subscription');
    expect(body.effective.plan.id).toBe('builder');
    expect(body.allowances.integrationCredits).toBe(10_000);
  });

  it('keeps one account out of another in the database too', async () => {
    const response = await reopened.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: as(OTHER),
    });
    const body = response.json() as { status: string; subscription: unknown };
    expect(body.status).toBe('none');
    expect(body.subscription).toBeNull();
  });

  it('lets exactly one instance record a period', async () => {
    const period = {
      ownerRef: OWNER,
      periodStart: '2031-01-01T00:00:00.000Z',
      periodEnd: '2031-02-01T00:00:00.000Z',
      planId: 'builder',
      messageCredits: 300,
      integrationCredits: 10_000,
      kind: 'renewal' as const,
      processedAt: new Date().toISOString(),
      actor: 'race-test',
    };
    const [a, b] = await Promise.all([
      runWithOwner(OWNER, () => first.stores!.subscriptions.recordPeriod(period)),
      runWithOwner(OWNER, () => second.stores!.subscriptions.recordPeriod(period)),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('carries a suspension into the other instance, and with it the refusal', async () => {
    const suspended = await app.inject({
      method: 'POST',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}/status`,
      headers: { ...operator, ...as(OWNER) },
      payload: { action: 'suspend', reason: 'Chargeback under review' },
    });
    expect(suspended.statusCode).toBe(200);

    const overview = await reopened.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: as(OWNER),
    });
    const body = overview.json() as { effective: { entitled: boolean; reason: string | null } };
    expect(body.effective.entitled).toBe(false);
    expect(body.effective.reason).toBe('Chargeback under review');
  });

  it('records the operator actions in the audit trail', async () => {
    const audit = await reopened.inject({
      method: 'GET',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}`,
      headers: { ...operator, ...as(OWNER) },
    });
    expect(audit.statusCode).toBe(200);
    const body = audit.json() as { audit: { action: string }[] };
    const actions = body.audit.map((entry) => entry.action);
    expect(actions).toContain('subscription-assigned');
    expect(actions).toContain('subscription-suspended');
  });
});
