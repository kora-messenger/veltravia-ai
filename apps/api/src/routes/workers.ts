import type { FastifyInstance, FastifyReply } from 'fastify';

import { isOrchestrationError, orchestrationHttpStatus } from '@veltravia/orchestration-core';
import {
  WORKER_STATUSES,
  isWorkerError,
  workerHttpStatus,
  type WorkerAssignment,
} from '@veltravia/worker-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import type { WorkerService } from '../worker-service.js';
import type { VerificationService } from '../verification.js';
import { checkTestEvidence } from '../evidence-gate.js';

/**
 * Superagent worker routes (Step 43).
 *
 * Identity is the caller resolution every other route uses; there is no second
 * authentication scheme. A worker belongs to a task, the task belongs to an
 * owner, and the worker id alone grants nothing: a foreign id and a missing one
 * answer the same 404.
 *
 * Nothing here lets a worker finish its own work. `start` runs it, `review` is
 * the only door that can complete it, and the routes never accept a status
 * field from the client.
 */

export interface WorkerRouteDeps {
  readonly workers: WorkerService;
  /**
   * When present, a worker's claimed test result must be backed by a stored
   * verification run (Step 45). Absent means the gate is off and a claim is
   * simply a claim.
   */
  readonly verification?: VerificationService | undefined;
}

const idParam = {
  type: 'object',
  required: ['workerId'],
  properties: { workerId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const taskParam = {
  type: 'object',
  required: ['taskId'],
  properties: { taskId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const owner = (request: { headers: Record<string, unknown> }): string =>
  resolveCallerOwnerRef(request as never);

export function registerWorkerRoutes(app: FastifyInstance, deps: WorkerRouteDeps): void {
  const { workers } = deps;
  const { manager, scheduler } = workers;

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (isWorkerError(error)) {
      return reply
        .status(workerHttpStatus(error.code))
        .send({ error: { code: error.code, message: error.message } });
    }
    if (isOrchestrationError(error)) {
      return reply
        .status(orchestrationHttpStatus(error.code))
        .send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({
      error: { code: 'WORKER_INTERNAL', message: 'The worker request could not be completed.' },
    });
  };

  app.get('/api/worker-orchestration', async () => ({
    storage: workers.store,
    durable: workers.durable,
    simulatedExecution: workers.simulated,
    concurrency: { defaultLimit: scheduler.defaultLimit, ceiling: 4 },
    statuses: WORKER_STATUSES,
    honest: {
      note: 'Workers run a simulated executor. Scheduling, lifecycle, persistence and review are real; the assigned work is not performed.',
      simulated: workers.simulated,
    },
  }));

  app.post(
    '/api/tasks/:taskId/workers',
    { schema: { params: taskParam } },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as {
        workerType?: unknown;
        assignment?: unknown;
        parentTaskId?: unknown;
      };
      try {
        const worker = await manager.delegate(owner(request), {
          taskId,
          workerType: body?.workerType as never,
          assignment: body?.assignment,
          parentTaskId: typeof body?.parentTaskId === 'string' ? body.parentTaskId : null,
        });
        return reply.status(201).send({ worker });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/workers', async (request, reply) => {
    try {
      const query = request.query as {
        taskId?: string;
        status?: string;
        active?: string;
        limit?: string;
      };
      const list = await manager.list(owner(request), {
        taskId: query.taskId,
        status: query.status === undefined ? undefined : [query.status as never],
        activeOnly: query.active === 'true',
        limit: query.limit === undefined ? undefined : Number(query.limit),
      });
      return reply.send({ workers: list, storage: workers.store, durable: workers.durable });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/workers/:workerId', { schema: { params: idParam } }, async (request, reply) => {
    const { workerId } = request.params as { workerId: string };
    try {
      return reply.send({ worker: await manager.get(owner(request), workerId) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get(
    '/api/workers/:workerId/events',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { workerId } = request.params as { workerId: string };
      const query = request.query as { after?: string; limit?: string };
      try {
        await manager.get(owner(request), workerId);
        const events = await manager.events(
          owner(request),
          workerId,
          Number(query.after ?? 0),
          Number(query.limit ?? 50),
        );
        return reply.send({ events });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/workers/:workerId/start',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { workerId } = request.params as { workerId: string };
      try {
        return reply.send({ worker: await manager.start(owner(request), workerId) });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * The evidence gate. Refusing to accept is always allowed; accepting a claimed
   * test result requires the run that produced it.
   */
  const evidenceProblem = async (caller: string, workerId: string) => {
    if (deps.verification === undefined) return null;
    let worker;
    try {
      worker = await manager.get(caller, workerId);
    } catch {
      return null;
    }
    return checkTestEvidence({
      verification: deps.verification,
      ownerRef: caller,
      workerId,
      evidence: worker.result?.evidence ?? [],
    });
  };

  app.post(
    '/api/workers/:workerId/review',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { workerId } = request.params as { workerId: string };
      const body = request.body as {
        decision?: 'accept' | 'reject' | 'request_revision';
        summary?: string;
        criteriaResults?: readonly (boolean | null)[];
        changedPaths?: readonly string[];
      };
      try {
        if (body?.decision === 'accept' && deps.verification !== undefined) {
          const problem = await evidenceProblem(owner(request), workerId);
          if (problem !== null) {
            return reply.status(409).send({
              error: {
                code: 'WORKER_REVIEW_REFUSED',
                message: problem.message,
                reason: problem.code,
              },
            });
          }
        }
        const outcome = await manager.review(owner(request), workerId, {
          decision: body?.decision,
          summary: String(body?.summary ?? ''),
          criteriaResults: Array.isArray(body?.criteriaResults) ? body.criteriaResults : [],
          changedPaths: Array.isArray(body?.changedPaths) ? body.changedPaths : undefined,
        });
        return reply.send({ worker: outcome.worker, checks: outcome.checks });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/workers/:workerId/cancel',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { workerId } = request.params as { workerId: string };
      const body = request.body as { reason?: string };
      try {
        const worker = await manager.cancel(
          owner(request),
          workerId,
          String(body?.reason ?? 'The owner cancelled this work.'),
        );
        return reply.send({ worker });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/workers/:workerId/requeue',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { workerId } = request.params as { workerId: string };
      const body = request.body as { reason?: string };
      try {
        const worker = await manager.requeue(
          owner(request),
          workerId,
          String(body?.reason ?? 'The Primary Agent re-queued this work.'),
        );
        return reply.send({ worker });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post('/api/scheduler/plan', async (request, reply) => {
    const body = request.body as { limit?: number };
    try {
      const plan = await scheduler.plan(owner(request), {
        limit: typeof body?.limit === 'number' ? body.limit : undefined,
      });
      return reply.send({
        decision: plan.decision,
        selected: plan.selected.map((worker) => ({
          workerId: worker.id,
          taskId: worker.taskId,
        })),
        skipped: plan.skipped,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/scheduler/dispatch', async (request, reply) => {
    const body = request.body as { limit?: number };
    try {
      const outcome = await scheduler.dispatch(owner(request), manager, {
        limit: typeof body?.limit === 'number' ? body.limit : undefined,
      });
      return reply.send({
        decision: outcome.plan.decision,
        skipped: outcome.plan.skipped,
        started: outcome.started.map((worker) => ({
          workerId: worker.id,
          taskId: worker.taskId,
          status: worker.status,
        })),
        workers: outcome.started,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/scheduler/decisions', async (request, reply) => {
    try {
      return reply.send({ decisions: await scheduler.history(owner(request), 20) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/workers/recover', async (request, reply) => {
    try {
      const recovered = await manager.recoverStalled(owner(request));
      return reply.send({ recovered });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get(
    '/api/tasks/:taskId/superagents',
    { schema: { params: taskParam } },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      try {
        const progress = await manager.progressFor(owner(request), taskId);
        return reply.send(progress);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}

export type { WorkerAssignment };
