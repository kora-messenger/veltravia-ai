import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  isSyncError,
  syncHttpStatus,
  type ConflictResolution,
  type SyncManager,
  type SyncPlan,
} from '@veltravia/sync-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import { createRateLimiter, type RateLimiter } from '../rate-limit.js';

/**
 * GitHub synchronisation routes (Step 40, phase 3).
 *
 * Identity is the SAME caller resolution every other route uses: there is no
 * second authentication scheme and no GitHub credential of any kind reaches a
 * response. A project that belongs to somebody else answers exactly like a
 * missing one, so ids cannot be probed.
 *
 * GitHub is optional. These routes are the only ones that involve it, and a
 * project that was never connected simply reports not-connected.
 */

export interface SyncRouteDeps {
  readonly sync: SyncManager;
  /** Injected so tests can use a tiny window; production uses the defaults. */
  readonly limiter?: RateLimiter;
  readonly writeLimiter?: RateLimiter;
  /** Records an operation without content. Never receives file text. */
  readonly audit?: (event: {
    readonly ownerRef: string;
    readonly action: string;
    readonly projectId: string;
    readonly detail?: string;
  }) => void;
}

const projectParam = {
  type: 'object',
  required: ['projectId'],
  properties: {
    projectId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

const planParam = {
  type: 'object',
  required: ['planId'],
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

const conflictParam = {
  type: 'object',
  required: ['planId', 'conflictId'],
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' },
    conflictId: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

const connectBody = {
  type: 'object',
  additionalProperties: false,
  required: ['owner', 'repository', 'branch'],
  properties: {
    owner: { type: 'string', minLength: 1, maxLength: 100 },
    repository: { type: 'string', minLength: 1, maxLength: 150 },
    branch: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

const planBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', minLength: 1, maxLength: 2000 },
  },
} as const;

const resolveBody = {
  type: 'object',
  additionalProperties: false,
  required: ['resolution'],
  properties: {
    resolution: { type: 'string', enum: ['keep-local', 'keep-remote', 'manual'] },
    manualContent: { type: 'string', maxLength: 512 * 1024 },
  },
} as const;

/** The plan as the browser sees it. Conflict TEXT never appears here. */
function toPlanPayload(plan: SyncPlan): Record<string, unknown> {
  return {
    planId: plan.planId,
    projectId: plan.projectId,
    owner: plan.owner,
    repository: plan.repository,
    branch: plan.branch,
    status: plan.status,
    mode: plan.mode,
    remoteHead: plan.remoteHead,
    localRevision: plan.localRevision,
    push: plan.push,
    pull: plan.pull,
    conflicts: plan.conflicts,
    skipped: plan.skipped,
    unchanged: plan.unchanged,
    approvalReasons: plan.approvalReasons,
    approved: plan.approved,
    message: plan.message,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    failure: plan.failure,
  };
}

export function registerSyncRoutes(app: FastifyInstance, deps: SyncRouteDeps): void {
  const { sync } = deps;
  const limiter = deps.limiter ?? createRateLimiter({ max: 40, windowMs: 60_000 });
  // A sync publishes to somebody's repository: a tighter budget than a read.
  // Writes and remote reads have separate budgets. A test may pin both by
  // injecting `limiter` alone, which keeps the suites readable.
  const writeLimiter =
    deps.writeLimiter ?? deps.limiter ?? createRateLimiter({ max: 12, windowMs: 60_000 });

  const record = (ownerRef: string, action: string, projectId: string, detail?: string): void => {
    // Paths, branches and outcomes only: never file text, never a token.
    deps.audit?.({ ownerRef, action, projectId, ...(detail === undefined ? {} : { detail }) });
  };

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (isSyncError(error)) {
      return reply
        .status(syncHttpStatus(error.code))
        .send({ error: { code: error.code, message: error.message } });
    }
    // Anything else is a bug or a GitHub failure whose text we do not echo: it
    // could carry a URL, a path or remote content.
    return reply.status(502).send({
      error: {
        code: 'SYNC_GITHUB_FAILED',
        message: 'GitHub could not be reached, or answered with an error. Nothing was changed.',
      },
    });
  };

  const limited = (reply: FastifyReply, seconds: number): FastifyReply =>
    reply
      .status(429)
      .header('retry-after', String(seconds))
      .send({
        error: {
          code: 'SYNC_RATE_LIMITED',
          message: `Too many synchronisation requests. Try again in ${seconds} seconds.`,
        },
      });

  // ---- discovery -----------------------------------------------------------

  /** Repositories the connector is allowed to touch. Never more than that. */
  app.get('/api/github/repositories', async (request, reply) => {
    const owner = resolveCallerOwnerRef(request);
    const wait = limiter.take(`repos:${owner}`);
    if (wait > 0) return limited(reply, wait);
    try {
      return { repositories: await sync.listRepositories() };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get(
    '/api/github/branches',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['owner', 'repository'],
          properties: {
            owner: { type: 'string', minLength: 1, maxLength: 100 },
            repository: { type: 'string', minLength: 1, maxLength: 150 },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      const wait = limiter.take(`branches:${owner}`);
      if (wait > 0) return limited(reply, wait);
      try {
        const query = request.query as { owner: string; repository: string };
        return {
          branches: await sync.listBranches(owner, {
            owner: query.owner,
            repository: query.repository,
          }),
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // ---- connection ----------------------------------------------------------

  app.get(
    '/api/projects/:projectId/sync',
    { schema: { params: projectParam } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      try {
        const { projectId } = request.params as { projectId: string };
        const status = sync.status(owner, projectId);
        return {
          ...status,
          plans: status.openPlans.map(toPlanPayload),
          openPlans: undefined,
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/projects/:projectId/sync/connect',
    { schema: { params: projectParam, body: connectBody } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      const wait = writeLimiter.take(`connect:${owner}`);
      if (wait > 0) return limited(reply, wait);
      try {
        const { projectId } = request.params as { projectId: string };
        const body = request.body as { owner: string; repository: string; branch: string };
        const connection = await sync.connect(owner, {
          projectId,
          owner: body.owner,
          repository: body.repository,
          branch: body.branch,
        });
        record(owner, 'sync.connect', projectId, `${body.owner}/${body.repository}@${body.branch}`);
        return reply.status(201).send({ connection });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete(
    '/api/projects/:projectId/sync',
    { schema: { params: projectParam } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      try {
        const { projectId } = request.params as { projectId: string };
        sync.disconnect(owner, projectId);
        record(owner, 'sync.disconnect', projectId);
        return { disconnected: true };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // ---- planning and applying ------------------------------------------------

  app.post(
    '/api/projects/:projectId/sync/plans',
    { schema: { params: projectParam, body: planBody } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      const wait = writeLimiter.take(`plan:${owner}`);
      if (wait > 0) return limited(reply, wait);
      try {
        const { projectId } = request.params as { projectId: string };
        const body = (request.body ?? {}) as { message?: string };
        const plan = await sync.plan(owner, {
          projectId,
          ...(body.message === undefined ? {} : { message: body.message }),
        });
        record(owner, 'sync.plan', projectId, plan.status);
        return reply.status(201).send({ plan: toPlanPayload(plan) });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/sync/plans/:planId', { schema: { params: planParam } }, async (request, reply) => {
    const owner = resolveCallerOwnerRef(request);
    try {
      const { planId } = request.params as { planId: string };
      return { plan: toPlanPayload(sync.getPlan(owner, planId)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    '/api/sync/plans/:planId/approval',
    { schema: { params: planParam } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      const wait = writeLimiter.take(`approve:${owner}`);
      if (wait > 0) return limited(reply, wait);
      try {
        const { planId } = request.params as { planId: string };
        const plan = sync.approve(owner, planId);
        record(owner, 'sync.approve', plan.projectId);
        return { plan: toPlanPayload(plan) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/sync/plans/:planId/apply',
    { schema: { params: planParam } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      const wait = writeLimiter.take(`apply:${owner}`);
      if (wait > 0) return limited(reply, wait);
      try {
        const { planId } = request.params as { planId: string };
        const result = await sync.apply(owner, planId);
        record(owner, 'sync.apply', result.plan.projectId, result.commitSha ?? 'no-commit');
        const applied = toPlanPayload(result.plan);
        return {
          plan: applied,
          commitSha: result.commitSha,
          // What this sync actually did, in plain counts, so a screen can say
          // "3 files published, 1 pulled" without re-deriving it.
          summary: {
            published: result.plan.push.length,
            pulled: result.plan.pull.length,
            failed: applied.status === 'failed',
          },
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/sync/plans/:planId/cancel',
    { schema: { params: planParam } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      try {
        const { planId } = request.params as { planId: string };
        const plan = sync.cancel(owner, planId);
        record(owner, 'sync.cancel', plan.projectId);
        return { plan: toPlanPayload(plan) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // ---- conflicts ------------------------------------------------------------

  app.get(
    '/api/sync/plans/:planId/conflicts/:conflictId',
    { schema: { params: conflictParam } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      try {
        const { planId, conflictId } = request.params as {
          planId: string;
          conflictId: string;
        };
        return sync.viewConflict(owner, planId, conflictId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/sync/plans/:planId/conflicts/:conflictId',
    { schema: { params: conflictParam, body: resolveBody } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      const wait = writeLimiter.take(`resolve:${owner}`);
      if (wait > 0) return limited(reply, wait);
      try {
        const { planId, conflictId } = request.params as {
          planId: string;
          conflictId: string;
        };
        const body = request.body as { resolution: ConflictResolution; manualContent?: string };
        const plan = sync.resolveConflict(owner, planId, conflictId, {
          resolution: body.resolution,
          ...(body.manualContent === undefined ? {} : { manualContent: body.manualContent }),
        });
        record(owner, 'sync.resolve', plan.projectId, body.resolution);
        return { plan: toPlanPayload(plan) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // ---- history --------------------------------------------------------------

  app.get(
    '/api/projects/:projectId/sync/history',
    { schema: { params: projectParam } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      try {
        const { projectId } = request.params as { projectId: string };
        return {
          entries: sync.history(owner, projectId),
          // Said plainly, because it is true: the API keeps this in memory.
          persistence: 'memory' as const,
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
