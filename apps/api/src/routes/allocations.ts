/**
 * Workspace credit allocation routes (Step 62).
 *
 * Two surfaces in one file because they answer the same question from two sides:
 *
 *  - **Administration** (`GET/PUT/POST /api/allocations…`). Everything here takes
 *    the caller from the request context. A workspace id in the body narrows the
 *    look; it never widens access, because the service resolves it through the
 *    Project Engine and answers 404 for a workspace that is not the caller's.
 *  - **The gate** (`POST /api/allocations/authorize`, `/settle`, `/release`). The
 *    same calls the billing coordinator makes internally, exposed so the rule can
 *    be inspected from outside instead of guessed at.
 *
 * Amounts are validated by the allocation core: a negative, non-finite or
 * above-ceiling number is refused with 400 before any balance is read.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  AllocationError,
  type AllocationPolicyName,
  type AllocationTargetKind,
  type CreditCategory,
} from '@veltravia/allocation-core';

import type { AllocationService } from '../allocation-service.js';
import { resolveCallerOwnerRef } from '../project-access.js';

export interface AllocationRouteDeps {
  readonly allocations: AllocationService;
}

const owner = (request: FastifyRequest): string => resolveCallerOwnerRef(request);

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AllocationError) {
    return reply.status(error.status).send({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  throw error;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const CATEGORIES = ['ai_tokens', 'integration_credits'] as const;
const TARGET_KINDS = ['member', 'project', 'agent', 'environment'] as const;
const POLICIES = [
  'manual',
  'equal',
  'project',
  'member',
  'priority',
  'restricted',
  'temporary',
  'automatic',
] as const;

const categoryOf = (value: unknown): CreditCategory | null =>
  typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
    ? (value as CreditCategory)
    : null;

const targetKindOf = (value: unknown): AllocationTargetKind | null =>
  typeof value === 'string' && (TARGET_KINDS as readonly string[]).includes(value)
    ? (value as AllocationTargetKind)
    : null;

const policyOf = (value: unknown): AllocationPolicyName | null =>
  typeof value === 'string' && (POLICIES as readonly string[]).includes(value)
    ? (value as AllocationPolicyName)
    : null;

export function registerAllocationRoutes(app: FastifyInstance, deps: AllocationRouteDeps): void {
  const { allocations } = deps;

  app.get('/api/allocations/capabilities', async (_request, reply) =>
    reply.send(allocations.capabilities()),
  );

  app.get('/api/allocations', async (request, reply) => {
    const workspaceId = str((request.query as Record<string, unknown>).workspaceId);
    if (workspaceId === null) {
      return reply
        .status(400)
        .send({ error: 'A workspaceId is required.', code: 'WORKSPACE_REQUIRED' });
    }
    try {
      return reply.send(await allocations.summary({ ownerRef: owner(request), workspaceId }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/allocations/list', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      return reply.send({
        allocations: await allocations.list({
          ownerRef: owner(request),
          workspaceId: str(query.workspaceId),
          category: categoryOf(query.category),
          targetKind: targetKindOf(query.targetKind),
          targetRef: str(query.targetRef),
        }),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/allocations/history', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    try {
      return reply.send({
        events: await allocations.history({
          ownerRef: owner(request),
          workspaceId: str(query.workspaceId),
          category: categoryOf(query.category),
          allocationId: str(query.allocationId),
          limit: num(query.limit),
        }),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/allocations/policy', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const workspaceId = str(query.workspaceId);
    const category = categoryOf(query.category);
    if (workspaceId === null || category === null) {
      return reply
        .status(400)
        .send({ error: 'A workspaceId and a category are required.', code: 'INVALID_REQUEST' });
    }
    try {
      return reply.send(
        await allocations.policy({ ownerRef: owner(request), workspaceId, category }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put('/api/allocations/policy', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const workspaceId = str(body.workspaceId);
    const category = categoryOf(body.category);
    const policy = policyOf(body.defaultPolicy);
    if (workspaceId === null || category === null || policy === null) {
      return reply.status(400).send({
        error: 'workspaceId, category and defaultPolicy are required.',
        code: 'INVALID_REQUEST',
      });
    }
    try {
      return reply.send(
        await allocations.setPolicy({
          ownerRef: owner(request),
          workspaceId,
          category,
          defaultPolicy: policy,
          autoLimit: num(body.autoLimit) ?? 0,
          maxTargetSharePct: num(body.maxTargetSharePct) ?? 100,
          actor: str(request.headers['x-veltravia-actor']) ?? owner(request),
          reason: str(body.reason) ?? 'Workspace allocation policy updated',
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put('/api/allocations/pool', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const workspaceId = str(body.workspaceId);
    const category = categoryOf(body.category);
    if (workspaceId === null || category === null) {
      return reply
        .status(400)
        .send({ error: 'workspaceId and category are required.', code: 'INVALID_REQUEST' });
    }
    try {
      const note = str(body.note);
      const pool = await allocations.setPool({
        ownerRef: owner(request),
        workspaceId,
        category,
        total: body.total as number,
        ...(note === null ? {} : { note }),
        actor: str(request.headers['x-veltravia-actor']) ?? owner(request),
        reason: str(body.reason) ?? 'Workspace allocation pool set',
      });
      return reply.send({ pool });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/allocations', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const workspaceId = str(body.workspaceId);
    const category = categoryOf(body.category);
    const targetKind = targetKindOf(body.targetKind);
    const targetRef = str(body.targetRef);
    if (workspaceId === null || category === null || targetKind === null || targetRef === null) {
      return reply.status(400).send({
        error: 'workspaceId, category, targetKind and targetRef are required.',
        code: 'INVALID_REQUEST',
      });
    }
    const policy = body.policy === undefined ? null : policyOf(body.policy);
    if (body.policy !== undefined && policy === null) {
      return reply
        .status(400)
        .send({ error: 'Unknown allocation policy.', code: 'INVALID_REQUEST' });
    }
    try {
      const idempotencyKey = str(body.idempotencyKey);
      const allocation = await allocations.allocate({
        ownerRef: owner(request),
        workspaceId,
        category,
        targetKind,
        targetRef,
        amount: body.amount as number,
        limit: body.limit === undefined || body.limit === null ? null : num(body.limit),
        priority: num(body.priority),
        ...(policy === null ? {} : { policy }),
        allowedOperations: Array.isArray(body.allowedOperations)
          ? body.allowedOperations.filter((entry): entry is string => typeof entry === 'string')
          : [],
        expiresAt: str(body.expiresAt),
        actor: str(request.headers['x-veltravia-actor']) ?? owner(request),
        reason: str(body.reason) ?? 'Allocation created',
        ...(idempotencyKey === null ? {} : { idempotencyKey }),
      });
      return reply.status(201).send({ allocation });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/allocations/distribute', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const workspaceId = str(body.workspaceId);
    const category = categoryOf(body.category);
    const policy = policyOf(body.policy);
    if (workspaceId === null || category === null || policy === null) {
      return reply.status(400).send({
        error: 'workspaceId, category and policy are required.',
        code: 'INVALID_REQUEST',
      });
    }
    const targets = (Array.isArray(body.targets) ? body.targets : [])
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        const kind = targetKindOf(record.kind ?? record.targetKind);
        const ref = str(record.ref ?? record.targetRef);
        if (kind === null || ref === null) return null;
        const priority = num(record.priority);
        const limit = num(record.limit);
        return {
          kind,
          ref,
          ...(priority === undefined ? {} : { priority }),
          ...(limit === undefined ? {} : { limit }),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (targets.length === 0) {
      return reply
        .status(400)
        .send({ error: 'Name at least one target to allocate to.', code: 'INVALID_REQUEST' });
    }
    try {
      return reply.send(
        await allocations.distribute({
          ownerRef: owner(request),
          workspaceId,
          category,
          policy,
          budget: body.budget as number,
          targets,
          actor: str(request.headers['x-veltravia-actor']) ?? owner(request),
          reason: str(body.reason) ?? 'Allocation policy applied',
          ...(Array.isArray(body.allowedOperations)
            ? {
                allowedOperations: body.allowedOperations.filter(
                  (entry): entry is string => typeof entry === 'string',
                ),
              }
            : {}),
          expiresAt: str(body.expiresAt),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/allocations/:allocationId/:action', async (request, reply) => {
    const { allocationId, action } = request.params as {
      allocationId: string;
      action: string;
    };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const actor = str(request.headers['x-veltravia-actor']) ?? owner(request);
    const reason = str(body.reason) ?? `Allocation ${action}`;
    const ownerRef = owner(request);
    try {
      switch (action) {
        case 'increase':
          return reply.send({
            allocation: await allocations.increase({
              ownerRef,
              allocationId,
              amount: body.amount as number,
              actor,
              reason,
            }),
          });
        case 'reduce':
          return reply.send({
            allocation: await allocations.reduce({
              ownerRef,
              allocationId,
              amount: body.amount as number,
              actor,
              reason,
            }),
          });
        case 'reclaim':
          return reply.send({
            allocation: await allocations.reclaim({ ownerRef, allocationId, actor, reason }),
          });
        case 'limit':
          return reply.send({
            allocation: await allocations.setLimit({
              ownerRef,
              allocationId,
              limit:
                body.limit === undefined || body.limit === null ? null : (num(body.limit) ?? null),
              actor,
              reason,
            }),
          });
        case 'priority':
          return reply.send({
            allocation: await allocations.setPriority({
              ownerRef,
              allocationId,
              priority: num(body.priority) ?? 0,
              actor,
              reason,
            }),
          });
        case 'revoke':
          return reply.send({
            allocation: await allocations.revoke({ ownerRef, allocationId, actor, reason }),
          });
        default:
          return reply.status(404).send({
            error: `Unknown allocation action "${action}".`,
            code: 'UNKNOWN_ACTION',
            actions: ['increase', 'reduce', 'reclaim', 'limit', 'priority', 'revoke'],
          });
      }
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/allocations/authorize', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return reply.send(
        await allocations.authorize({
          ownerRef: owner(request),
          workspaceId: str(body.workspaceId),
          category: categoryOf(body.category) ?? 'ai_tokens',
          amount: num(body.amount) ?? 0,
          operationKey: str(body.operationKey) ?? `inspect:${Date.now()}`,
          operationKind: str(body.operationKind),
          projectId: str(body.projectId),
          agentRef: str(body.agentRef),
          memberRef: str(body.memberRef),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/allocations/settle', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const allocationId = str(body.allocationId);
    if (allocationId === null) {
      return reply
        .status(400)
        .send({ error: 'allocationId is required.', code: 'INVALID_REQUEST' });
    }
    await allocations.settle({
      ownerRef: owner(request),
      allocationId,
      amount: num(body.amount) ?? 0,
      operationKey: str(body.operationKey) ?? 'inspect',
      reason: str(body.reason) ?? 'Settled',
    });
    return reply.send({ settled: true });
  });

  app.post('/api/allocations/release', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const allocationId = str(body.allocationId);
    if (allocationId === null) {
      return reply
        .status(400)
        .send({ error: 'allocationId is required.', code: 'INVALID_REQUEST' });
    }
    await allocations.release({
      ownerRef: owner(request),
      allocationId,
      amount: num(body.amount) ?? 0,
      operationKey: str(body.operationKey) ?? 'inspect',
      reason: str(body.reason) ?? 'Released',
    });
    return reply.send({ released: true });
  });

  app.post('/api/allocations/sweep', async (request, reply) => {
    const workspaceId = str((request.body as Record<string, unknown> | null)?.workspaceId);
    if (workspaceId === null) {
      return reply
        .status(400)
        .send({ error: 'workspaceId is required.', code: 'WORKSPACE_REQUIRED' });
    }
    try {
      return reply.send({ released: await allocations.sweep(owner(request), workspaceId) });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
