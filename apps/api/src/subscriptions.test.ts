/**
 * Subscription plans over HTTP (Step 60).
 *
 * These are boundary tests, not lifecycle tests: the state machine is pinned in
 * the core suite, and the pure renewal arithmetic in the service suite beside
 * this one. What matters here is that the boundary holds - an operator token is
 * needed to change anybody's plan, an owner cannot reach another account, and a
 * plan that does not include a feature stops the route that starts it.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveDeploymentConfig } from './deployment/config.js';
import { buildApp } from './server.js';

const OWNER = 'plan-owner';
const OTHER = 'plan-other';
const ADMIN = 'subscription-admin-test';

// The operator token is read from the process environment, the same way the
// wallet and spending-limit surfaces read theirs.
process.env['VELTRAVIA_BILLING_ADMIN_TOKEN'] = ADMIN;

let app: FastifyInstance;
let disabledApp: FastifyInstance;

function headers(owner = OWNER) {
  return { 'x-veltravia-owner-ref': owner };
}

function admin(owner = OWNER) {
  return { 'x-veltravia-owner-ref': owner, 'x-veltravia-admin': ADMIN };
}

function newApp(): FastifyInstance {
  return buildApp({
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
}

beforeAll(async () => {
  app = newApp();
  await app.ready();
  disabledApp = newApp();
  await disabledApp.ready();
});

afterAll(async () => {
  await app?.close();
  await disabledApp?.close();
});

interface PlanView {
  id: string;
  name: string;
  rank: number;
  active: boolean;
  visible: boolean;
  selfService: boolean;
  monthlyMessageCredits: number;
  monthlyIntegrationCredits: number;
  entitlements: Record<string, boolean | number | null>;
}

interface OverviewBody {
  status: string;
  effective: { source: string; plan: PlanView; entitled: boolean; reason: string | null };
  plans: PlanView[];
  allowances: { messageCredits: number; integrationCredits: number };
  subscription: unknown;
  selfService: { enabled: boolean; note: string | null };
}

describe('the plan an account is on', () => {
  it('gives an account with no subscription the included allowance', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: headers(OWNER),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as OverviewBody;
    expect(body.status).toBe('none');
    expect(body.effective.source).toBe('development-allowance');
    expect(body.effective.plan.id).toBe('development');
    expect(body.subscription).toBeNull();
    expect(body.allowances.integrationCredits).toBe(500);
  });

  it('publishes the catalogue in rank order, with no prices anywhere in it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/plans',
      headers: headers(OWNER),
    });
    expect(response.statusCode).toBe(200);
    const plans = (response.json() as { plans: PlanView[] }).plans;
    expect(plans.map((plan) => plan.id)).toEqual([
      'development',
      'starter',
      'builder',
      'pro',
      'elite',
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/price|usd|ngn|₦/i);
  });

  it('says plainly that plan changes are made by an operator for now', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: headers(OWNER),
    });
    const body = response.json() as OverviewBody;
    expect(body.selfService.enabled).toBe(false);
    expect(body.selfService.note).toContain('operator');
  });
});

describe('changing a plan without checkout', () => {
  it('refuses a self-service change, and says nothing was changed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscriptions/me/change-plan',
      headers: headers(OWNER),
      payload: { planId: 'pro' },
    });
    expect(response.statusCode).toBe(403);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SUBSCRIPTION_CHANGE_UNAVAILABLE');
    expect(body.error.message).toContain('Nothing was changed');
  });

  it('closes the operator surface when the deployment has no token', async () => {
    // The token is read per request, so removing it for the duration of this call
    // is exactly the deployment with no operator configured.
    const saved = process.env['VELTRAVIA_BILLING_ADMIN_TOKEN'];
    delete process.env['VELTRAVIA_BILLING_ADMIN_TOKEN'];
    try {
      const response = await disabledApp.inject({
        method: 'GET',
        url: '/api/subscriptions/admin/plans',
        headers: headers(OWNER),
      });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'SUBSCRIPTION_ADMIN_DISABLED',
      );
    } finally {
      process.env['VELTRAVIA_BILLING_ADMIN_TOKEN'] = saved;
    }
  });

  it('refuses an operator call with the wrong token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/admin/plans',
      headers: { 'x-veltravia-owner-ref': OWNER, 'x-veltravia-admin': 'not-the-token' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the operator surface', () => {
  it('assigns a plan, and the owner then sees it', async () => {
    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}`,
      headers: admin(),
      payload: { planId: 'builder', reason: 'Paid by transfer' },
    });
    expect(assigned.statusCode).toBe(201);
    const created = assigned.json() as {
      created: boolean;
      subscription: { planId: string; status: string; currentPeriodStart: string };
    };
    expect(created.created).toBe(true);
    expect(created.subscription.planId).toBe('builder');
    expect(created.subscription.status).toBe('active');

    const overview = await app.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: headers(OWNER),
    });
    const body = overview.json() as OverviewBody;
    expect(body.effective.source).toBe('subscription');
    expect(body.effective.plan.name).toBe('Builder');
    expect(body.allowances.integrationCredits).toBe(10_000);
  });

  it('tells the account what changed, once', async () => {
    const events = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/events',
      headers: headers(OWNER),
    });
    expect(events.statusCode).toBe(200);
    const list = (events.json() as { events: { kind: string; message: string }[] }).events;
    expect(list.map((event) => event.kind)).toContain('assigned');
    expect(list[0]?.message.length).toBeGreaterThan(10);
  });

  it('changes the plan rather than assigning a second subscription', async () => {
    const changed = await app.inject({
      method: 'PUT',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}`,
      headers: admin(),
      payload: { planId: 'elite', reason: 'Upgraded' },
    });
    expect(changed.statusCode).toBe(200);
    const body = changed.json() as { direction: string; subscription: { planId: string } };
    expect(body.direction).toBe('upgrade');
    expect(body.subscription.planId).toBe('elite');

    const downgraded = await app.inject({
      method: 'PUT',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}`,
      headers: admin(),
      payload: { planId: 'starter', reason: 'Back down' },
    });
    expect((downgraded.json() as { direction: string }).direction).toBe('downgrade');
  });

  it('keeps one account out of another', async () => {
    const other = await app.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: headers(OTHER),
    });
    const body = other.json() as OverviewBody;
    expect(body.subscription).toBeNull();
    expect(body.status).toBe('none');

    const events = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/events',
      headers: headers(OTHER),
    });
    expect((events.json() as { events: unknown[] }).events).toHaveLength(0);
  });

  it('refuses a plan id that does not exist', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/subscriptions/admin/subscriptions/${OTHER}`,
      headers: admin(),
      payload: { planId: 'imagination' },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('PLAN_NOT_FOUND');
  });

  it('refuses an operator call with no plan id', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/subscriptions/admin/subscriptions/${OTHER}`,
      headers: admin(),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates a plan an operator defined, and validates it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/subscriptions/admin/plans',
      headers: admin(),
      payload: {
        plan: {
          id: 'studio',
          name: 'Studio',
          description: 'A plan this deployment defined itself.',
          rank: 25,
          monthlyMessageCredits: 300,
          monthlyIntegrationCredits: 4_000,
          entitlements: {
            'features.coding_agent': true,
            'features.superagent': true,
            'models.managed': true,
            'models.byok': true,
            'limits.projects': 5,
          },
          quotas: { concurrentJobs: 4 },
        },
        reason: 'A local tier',
      },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { plan: PlanView }).plan.id).toBe('studio');

    const refusal = await app.inject({
      method: 'POST',
      url: '/api/subscriptions/admin/plans',
      headers: admin(),
      payload: { plan: { id: 'broken', name: 'Broken', entitlements: { 'features.magic': true } } },
    });
    expect(refusal.statusCode).toBe(400);
    expect((refusal.json() as { error: { code: string } }).error.code).toBe('INVALID_PLAN');
  });

  it('cannot deactivate the allowance a lapsed subscription falls back to', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscriptions/admin/plans/development/activation',
      headers: admin(),
      payload: { active: false },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain(
      'cannot be deactivated',
    );
  });
});

describe('suspension', () => {
  it('stops the account and says so on the owner surface', async () => {
    const suspended = await app.inject({
      method: 'POST',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}/status`,
      headers: admin(),
      payload: { action: 'suspend', reason: 'Chargeback under review' },
    });
    expect(suspended.statusCode).toBe(200);
    expect((suspended.json() as { subscription: { status: string } }).subscription.status).toBe(
      'suspended',
    );

    const overview = await app.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: headers(OWNER),
    });
    const body = overview.json() as OverviewBody;
    expect(body.effective.entitled).toBe(false);
    expect(body.effective.reason).toBe('Chargeback under review');

    const permissions = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/permissions',
      headers: headers(OWNER),
    });
    const perms = permissions.json() as {
      entitled: boolean;
      features: { managedProviders: boolean; byokProviders: boolean };
    };
    expect(perms.entitled).toBe(false);
    expect(perms.features.managedProviders).toBe(false);
    expect(perms.features.byokProviders).toBe(false);
  });

  it('refuses to change the plan of a suspended account', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}`,
      headers: admin(),
      payload: { planId: 'pro' },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'SUBSCRIPTION_SUSPENDED',
    );
  });

  it('reactivates into a fresh period', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/subscriptions/admin/subscriptions/${OWNER}/status`,
      headers: admin(),
      payload: { action: 'reactivate', reason: 'Review closed' },
    });
    expect(response.statusCode).toBe(200);
    const record = (
      response.json() as { subscription: { status: string; suspensionReason: string | null } }
    ).subscription;
    expect(record.status).toBe('active');
    expect(record.suspensionReason).toBeNull();
  });
});

describe('the plan gate', () => {
  it('lets a plan that includes a feature start the work', async () => {
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: headers(OTHER),
      payload: { name: 'Gate project', description: 'Feature gate', projectType: 'web' },
    });
    expect(project.statusCode).toBe(201);

    // The development allowance includes the coding agent, so a run is started
    // rather than refused. It may then fail for its own reasons; the gate is what
    // this asserts, and a refusal here would say NOT_IN_PLAN.
    const run = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: headers(OTHER),
      payload: {
        projectId: (project.json() as { id: string }).id,
        instruction: 'Add a greeting module.',
      },
    });
    expect(run.statusCode).not.toBe(403);
  });

  it('refuses the route itself when the plan does not include the feature', async () => {
    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/subscriptions/admin/subscriptions/${OTHER}`,
      headers: admin(),
      payload: { planId: 'studio', reason: 'Narrow tier' },
    });
    expect(assigned.statusCode).toBe(201);

    // 'studio' grants the coding agent, so take it away the way an operator would.
    const edited = await app.inject({
      method: 'POST',
      url: '/api/subscriptions/admin/plans',
      headers: admin(),
      payload: {
        plan: {
          id: 'studio',
          name: 'Studio',
          description: 'A plan this deployment defined itself.',
          rank: 25,
          monthlyMessageCredits: 300,
          monthlyIntegrationCredits: 4_000,
          entitlements: {
            'features.coding_agent': false,
            'features.superagent': true,
            'models.managed': true,
            'models.byok': true,
          },
          quotas: { concurrentJobs: 4 },
        },
        reason: 'Coding agent withdrawn from this tier',
      },
    });
    expect(edited.statusCode).toBe(201);

    const projects = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: headers(OTHER),
    });
    const projectId = (projects.json() as { projects: { id: string }[] }).projects[0]?.id ?? 'x';

    const run = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: headers(OTHER),
      payload: { projectId, instruction: 'Add a greeting module.' },
    });
    expect(run.statusCode).toBe(403);
    const body = run.json() as { error: { code: string; message: string; entitlement: string } };
    expect(body.error.code).toBe('NOT_IN_PLAN');
    expect(body.error.entitlement).toBe('features.coding_agent');
    expect(body.error.message).toContain('Studio');
  });

  it('does not gate the plan surface itself', async () => {
    // 'studio' grants none of the coding features any more; reading a plan must
    // still work, or an account could not find out why it is refused.
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: headers(OTHER),
    });
    expect(response.statusCode).toBe(200);
  });
});
