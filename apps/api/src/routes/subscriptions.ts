/**
 * Subscription routes (Step 60).
 *
 * Three surfaces, and the split is the security model:
 *
 *  - **Owner routes** (`/api/subscriptions`, `/me/...`) speak only for the caller.
 *    There is no owner parameter anywhere in an owner route, so one account
 *    cannot read or edit another's plan even by spoofing a body field.
 *  - **Operator routes** (`/admin/...`) need the deployment's operator token, and
 *    refuse with 503 when none is configured rather than falling open. They are
 *    the only place a plan can be written or another account's plan changed.
 *  - **Nothing here enforces a feature.** Enforcement is the gate the server
 *    installs over the routes that start the work (see `subscription-guards.ts`),
 *    so a browser that never opens this screen is still held to its plan.
 *
 * Self-service plan changes are closed by default: with no checkout in this
 * build, letting a customer move themselves onto a paid tier would be a free
 * upgrade. The catalogue and the comparison are still published, and the refusal
 * says why.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { SubscriptionError, isSubscriptionStatus } from '@veltravia/subscriptions-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import type { SubscriptionService } from '../subscription-service.js';

export interface SubscriptionRouteDeps {
  readonly subscriptions: SubscriptionService;
  /** Read for the allowance figures the plan screen shows beside the ceilings. */
  readonly messageCredits?: { summary(ref: { ownerRef: string }): Promise<unknown> };
  readonly integrationCredits?: { summary(ref: { ownerRef: string }): Promise<unknown> };
  readonly wallet?: { overview(ref: { ownerRef: string }): Promise<unknown> };
  readonly usage?: {
    snapshot(ownerRef: string, options?: { projectId?: string | null }): Promise<unknown>;
  };
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SubscriptionError) {
    return reply
      .status(error.status)
      .send({ error: { code: error.code, message: error.message, ...error.details } });
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'SUBSCRIPTION_CONFLICT'
  ) {
    return reply.status(409).send({
      error: {
        code: 'SUBSCRIPTION_CONFLICT',
        message: (error as Error).message,
      },
    });
  }
  return reply.status(503).send({
    error: {
      code: 'SUBSCRIPTIONS_UNAVAILABLE',
      message: 'Your plan could not be read just now. Nothing was changed.',
    },
  });
}

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  deps: SubscriptionRouteDeps,
  env: NodeJS.ProcessEnv,
): void {
  const { subscriptions } = deps;

  /**
   * Operator gate. No token configured means the writing surface is closed,
   * because a plan anybody can edit is not a plan.
   */
  const operator = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const expected = (
      env.VELTRAVIA_BILLING_ADMIN_TOKEN ??
      env.VELTRAVIA_USAGE_ADMIN_TOKEN ??
      ''
    ).trim();
    if (expected === '') {
      reply.status(503).send({
        error: {
          code: 'SUBSCRIPTION_ADMIN_DISABLED',
          message: 'This deployment has no operator token, so plan management is closed.',
        },
      });
      return false;
    }
    const authorization = request.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const header = request.headers['x-veltravia-admin'];
    const token =
      bearer.length > 0
        ? bearer
        : typeof header === 'string'
          ? header
          : Array.isArray(header)
            ? header[0]
            : undefined;
    if (token !== expected) {
      reply.status(403).send({
        error: { code: 'SUBSCRIPTION_ADMIN_DENIED', message: 'That operator token is not valid.' },
      });
      return false;
    }
    return true;
  };

  const ownerRef = (request: FastifyRequest): string => resolveCallerOwnerRef(request);

  /** Everything the plan screen needs, in one read. */
  app.get('/api/subscriptions', async (request, reply) => {
    try {
      const owner = ownerRef(request);
      const overview = await subscriptions.overview(owner);
      const [message, integrations, wallet, usage] = await Promise.all([
        deps.messageCredits === undefined
          ? Promise.resolve(null)
          : deps.messageCredits.summary({ ownerRef: owner }).catch(() => null),
        deps.integrationCredits === undefined
          ? Promise.resolve(null)
          : deps.integrationCredits.summary({ ownerRef: owner }).catch(() => null),
        deps.wallet === undefined
          ? Promise.resolve(null)
          : deps.wallet.overview({ ownerRef: owner }).catch(() => null),
        deps.usage === undefined
          ? Promise.resolve(null)
          : deps.usage.snapshot(owner).catch(() => null),
      ]);
      return reply.send({
        ...overview,
        allowances: {
          messageCredits: overview.effective.plan.monthlyMessageCredits,
          integrationCredits: overview.effective.plan.monthlyIntegrationCredits,
        },
        entitlements: overview.effective.plan.entitlements,
        quotas: overview.effective.plan.quotas,
        message,
        integrations,
        wallet,
        usage,
        selfService: {
          enabled: subscriptions.selfServiceEnabled,
          note: subscriptions.selfServiceEnabled
            ? null
            : 'Plan changes are made by an operator until checkout exists.',
        },
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** The catalogue on its own, for a comparison screen. */
  app.get('/api/subscriptions/plans', async (_request, reply) => {
    try {
      return reply.send({ plans: await subscriptions.catalogue() });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** What happened to this account's plan, newest first. This is the notification feed. */
  app.get('/api/subscriptions/events', async (request, reply) => {
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const limit = Math.min(Math.max(num(query['limit']) ?? 25, 1), 100);
      return reply.send({ events: await subscriptions.events(ownerRef(request), limit) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * The caller's own feature flags.
   *
   * Advisory: a screen uses it to explain and to hide what cannot work, but every
   * protected route checks the same answer on the server. Disabling a button is
   * never the enforcement.
   */
  app.get('/api/subscriptions/permissions', async (request, reply) => {
    try {
      const access = await subscriptions.access(ownerRef(request));
      return reply.send({
        planId: access.planId,
        planName: access.planName,
        status: access.status,
        source: access.source,
        entitled: access.entitled,
        reason: access.reason,
        features: {
          managedProviders: access.managedProviders,
          byokProviders: access.byokProviders,
        },
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Move yourself onto another plan.
   *
   * Closed unless the deployment has opened it *and* the target plan is marked
   * self-selectable, which for the shipped catalogue means only the development
   * allowance. Nothing is charged, because this build has no checkout.
   */
  app.post('/api/subscriptions/me/change-plan', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const planId = str(body['planId']);
      if (planId === undefined) {
        return reply.status(400).send({
          error: { code: 'INVALID_PLAN', message: 'planId is required.', field: 'planId' },
        });
      }
      const owner = ownerRef(request);
      const result = await subscriptions.changePlan({
        ownerRef: owner,
        planId,
        actor: owner,
        reason: str(body['reason']) ?? 'Changed from the plan screen.',
        expectedVersion: num(body['expectedVersion']) ?? null,
        selfService: true,
      });
      return reply.send({ subscription: result.subscription, direction: result.direction });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Stop the subscription. It always runs to the end of the period it paid for. */
  app.post('/api/subscriptions/me/cancel', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const owner = ownerRef(request);
      const record = await subscriptions.cancel({
        ownerRef: owner,
        actor: owner,
        reason: str(body['reason']) ?? 'Cancelled from the plan screen.',
        immediate: body['immediate'] === true,
      });
      return reply.send({ subscription: record });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // --------------------------------------------------------------- operator

  app.get('/api/subscriptions/admin/plans', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      return reply.send({ plans: await subscriptions.plans() });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Create or edit a plan. The id is in the body so one route does both. */
  app.post('/api/subscriptions/admin/plans', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const plan = await subscriptions.savePlan({
        draft: body['plan'] ?? body,
        actor: 'operator',
        reason: str(body['reason']) ?? 'Plan saved from the operator surface.',
      });
      return reply.status(201).send({ plan });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/subscriptions/admin/plans/:planId/activation', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body['active'] !== 'boolean') {
        return reply.status(400).send({
          error: {
            code: 'INVALID_PLAN',
            message: 'active must be true or false.',
            field: 'active',
          },
        });
      }
      const plan = await subscriptions.setPlanActive({
        planId: String(params['planId']),
        active: body['active'],
        actor: 'operator',
        reason: str(body['reason']) ?? 'Activation changed from the operator surface.',
      });
      return reply.send({ plan });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/subscriptions/admin/subscriptions', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const planId = str(query['planId']);
      const status = str(query['status']);
      if (status !== undefined && !isSubscriptionStatus(status)) {
        return reply.status(400).send({
          error: { code: 'INVALID_STATUS', message: `"${status}" is not a subscription status.` },
        });
      }
      const subscriptionsList = await subscriptions.adminSubscriptions({
        ...(planId === undefined ? {} : { planId }),
        ...(status === undefined ? {} : { status }),
        limit: Math.min(Math.max(num(query['limit']) ?? 100, 1), 500),
        skip: Math.max(num(query['skip']) ?? 0, 0),
      });
      return reply.send({ subscriptions: subscriptionsList });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/subscriptions/admin/subscriptions/:ownerRef', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const target = String(params['ownerRef'] ?? '');
      if (target.trim() === '') {
        return reply.status(400).send({
          error: { code: 'INVALID_OWNER', message: 'An owner is required.', field: 'ownerRef' },
        });
      }
      return reply.send(await subscriptions.adminSubscription(target));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Put an account on a plan: assign when it has none, change when it has one.
   * `expectedVersion` is honoured on a change so an operator cannot overwrite a
   * change somebody else made in between.
   */
  app.put('/api/subscriptions/admin/subscriptions/:ownerRef', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const target = String(params['ownerRef'] ?? '');
      const body = (request.body ?? {}) as Record<string, unknown>;
      const planId = str(body['planId']);
      if (target.trim() === '') {
        return reply.status(400).send({
          error: { code: 'INVALID_OWNER', message: 'An owner is required.', field: 'ownerRef' },
        });
      }
      if (planId === undefined) {
        return reply.status(400).send({
          error: { code: 'INVALID_PLAN', message: 'planId is required.', field: 'planId' },
        });
      }
      const current = await subscriptions.adminSubscription(target);
      if (current.subscription === null) {
        const record = await subscriptions.assign({
          ownerRef: target,
          planId,
          actor: 'operator',
          reason: str(body['reason']) ?? 'Assigned from the operator surface.',
          ...(typeof body['renews'] === 'boolean' ? { renews: body['renews'] } : {}),
        });
        return reply.status(201).send({ subscription: record, created: true });
      }
      const result = await subscriptions.changePlan({
        ownerRef: target,
        planId,
        actor: 'operator',
        reason: str(body['reason']) ?? 'Changed from the operator surface.',
        expectedVersion: num(body['expectedVersion']) ?? null,
      });
      return reply.send({ subscription: result.subscription, direction: result.direction });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/subscriptions/admin/subscriptions/:ownerRef/status', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const target = String(params['ownerRef'] ?? '');
      const body = (request.body ?? {}) as Record<string, unknown>;
      const action = str(body['action']);
      const reason = str(body['reason']) ?? 'Changed from the operator surface.';
      if (action === undefined || !['suspend', 'reactivate', 'cancel', 'expire'].includes(action)) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_ACTION',
            message: 'action must be suspend, reactivate, cancel or expire.',
            field: 'action',
          },
        });
      }
      const record =
        action === 'suspend'
          ? await subscriptions.suspend({ ownerRef: target, actor: 'operator', reason })
          : action === 'reactivate'
            ? await subscriptions.reactivate({ ownerRef: target, actor: 'operator', reason })
            : action === 'cancel'
              ? await subscriptions.cancel({
                  ownerRef: target,
                  actor: 'operator',
                  reason,
                  immediate: body['immediate'] === true,
                })
              : await subscriptions.expire({ ownerRef: target, actor: 'operator', reason });
      return reply.send({ subscription: record });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Process one account's overdue renewal now. Idempotent per period. */
  app.post('/api/subscriptions/admin/subscriptions/:ownerRef/renew', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const target = String(params['ownerRef'] ?? '');
      const result = await subscriptions.renew(target, 'operator');
      return reply.send({ renewed: result.applied });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Run the renewal pass over every account. Safe to run twice. */
  app.post('/api/subscriptions/admin/renewals', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      return reply.send(await subscriptions.sweep('renewal-sweep'));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/subscriptions/admin/audit', async (request, reply) => {
    if (!operator(request, reply)) return reply;
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const limit = Math.min(Math.max(num(query['limit']) ?? 50, 1), 200);
      return reply.send({ audit: await subscriptions.platformAudit(limit) });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
