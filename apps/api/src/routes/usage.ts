/**
 * Usage routes (Step 52).
 *
 * Reads are the owner's own: the snapshot, the limits that apply, the records
 * behind them and the capability matrix that says which of those numbers are
 * measured at all. The owner always comes from the request context, so another
 * owner's project id narrows to nothing rather than widening access.
 *
 * Writes are operator work, not owner work: changing a plan or a limit (or
 * correcting a measurement) while the bill is being judged by that very limit is
 * not something a caller may do for itself. They require the deployment's admin
 * token, and when that token is not configured the endpoints answer 503 instead
 * of falling open. That is the same rule as every other credential-gated surface
 * here.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { QuotaLimitKey, UsageCategory } from '@veltravia/usage-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import { UsageLimitError, type UsageService } from '../usage-service.js';

export interface UsageRouteDeps {
  readonly usage: UsageService;
}

const owner = (request: { headers: Record<string, unknown> }): string =>
  resolveCallerOwnerRef(request as never);

export function usageHttpStatus(error: unknown): number {
  if (error instanceof UsageLimitError) return error.status;
  return 500;
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof UsageLimitError) {
    return reply.status(error.status).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.decision === null ? {} : { decision: error.decision }),
      },
    });
  }
  return reply.status(503).send({
    error: {
      code: 'USAGE_UNAVAILABLE',
      message: 'Metering is unavailable right now. Nothing was charged and nothing was changed.',
    },
  });
}

/** Constant-time comparison, hashed first so lengths always match. */
function sameToken(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function requireOperator(
  request: { headers: Record<string, unknown> },
  reply: FastifyReply,
  env: NodeJS.ProcessEnv,
): boolean {
  const expected = env.VELTRAVIA_USAGE_ADMIN_TOKEN?.trim() ?? '';
  if (expected === '') {
    reply.status(503).send({
      error: {
        code: 'USAGE_ADMIN_DISABLED',
        message: 'This deployment has no admin token configured, so operator changes are closed.',
      },
    });
    return false;
  }
  const header = request.headers['x-veltravia-admin'];
  const provided = typeof header === 'string' ? header : '';
  if (provided === '' || !sameToken(provided, expected)) {
    reply.status(403).send({
      error: { code: 'USAGE_ADMIN_FORBIDDEN', message: 'That change needs an operator token.' },
    });
    return false;
  }
  return true;
}

const projectQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { projectId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

export function registerUsageRoutes(
  app: FastifyInstance,
  deps: UsageRouteDeps,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const usage = deps.usage;

  app.get('/api/usage/capabilities', async () => usage.capabilities());

  app.get('/api/usage', { schema: { querystring: projectQuery } }, async (request, reply) => {
    const query = request.query as { projectId?: string };
    try {
      return await usage.snapshot(owner(request), { projectId: query.projectId ?? null });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get(
    '/api/usage/limits',
    { schema: { querystring: projectQuery } },
    async (request, reply) => {
      const query = request.query as { projectId?: string };
      try {
        return { limits: await usage.limits(owner(request), query.projectId ?? null) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/usage/records',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 64 },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { projectId?: string; limit?: number };
      try {
        const records = await usage.records(owner(request), {
          projectId: query.projectId ?? null,
          limit: query.limit ?? 100,
        });
        return { records, count: records.length };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/usage/adjustments', async (request, reply) => {
    try {
      const adjustments = await usage.adjustments(owner(request), { limit: 100 });
      return { adjustments, count: adjustments.length };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---------------------------------------------------------------- operator */

  app.post(
    '/api/usage/adjustments',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'quantity', 'reason', 'auditId'],
          properties: {
            category: {
              type: 'string',
              enum: [
                'database_storage',
                'backend_execution',
                'file_storage',
                'bandwidth',
                'hosting',
                'background_jobs',
                'realtime',
                'ai_provider',
              ],
            },
            quantity: { type: 'number', minimum: -1_000_000_000, maximum: 1_000_000_000 },
            reason: { type: 'string', minLength: 8, maxLength: 400 },
            auditId: { type: 'string', minLength: 1, maxLength: 64 },
            targetRecordId: { type: 'string', minLength: 1, maxLength: 64 },
            projectId: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireOperator(request, reply, env)) return reply;
      const body = request.body as {
        category: UsageCategory;
        quantity: number;
        reason: string;
        auditId: string;
        targetRecordId?: string;
        projectId?: string;
      };
      try {
        // The adjustment is written for the calling owner: an operator fixes a
        // measurement for the owner they are acting for, never silently for
        // somebody else.
        const adjustment = await usage.adjust({
          ownerRef: owner(request),
          category: body.category,
          quantity: body.quantity,
          reason: body.reason,
          actor: 'operator',
          auditId: body.auditId,
          targetRecordId: body.targetRecordId ?? null,
          projectId: body.projectId ?? null,
        });
        return reply.status(201).send({ adjustment });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put(
    '/api/usage/limits',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: {
            key: {
              type: 'string',
              enum: [
                'databaseStorageBytes',
                'fileStorageBytes',
                'bandwidthBytes',
                'backendExecutionMs',
                'backendExecutionCalls',
                'backgroundJobs',
                'concurrentJobs',
                'realtimeConnections',
                'providerTokens',
              ],
            },
            // null is an explicit "unlimited here", which differs from no row.
            value: { type: ['number', 'null'], minimum: 0 },
            projectId: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireOperator(request, reply, env)) return reply;
      const body = request.body as {
        key: QuotaLimitKey;
        value?: number | null;
        projectId?: string;
      };
      try {
        const limits = await usage.setLimit({
          ownerRef: owner(request),
          key: body.key,
          value: body.value === undefined ? null : body.value,
          actor: 'operator',
          projectId: body.projectId ?? null,
        });
        return { limits };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put(
    '/api/usage/entitlement',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['planId'],
          properties: { planId: { type: 'string', enum: ['development', 'paid'] } },
        },
      },
    },
    async (request, reply) => {
      if (!requireOperator(request, reply, env)) return reply;
      const body = request.body as { planId: 'development' | 'paid' };
      try {
        const entitlement = await usage.setPlan({
          ownerRef: owner(request),
          planId: body.planId,
          actor: 'operator',
        });
        return { entitlement };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
