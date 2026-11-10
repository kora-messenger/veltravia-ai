import type { FastifyInstance, FastifyReply } from 'fastify';

import { UsageLimitError } from '../usage-service.js';

const isUsageLimitError = (error: unknown): error is UsageLimitError =>
  error instanceof UsageLimitError;

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
import type { OperationBilling, OperationRef } from '../operation-billing.js';
import { messageCreditErrorBody } from './message-credits.js';

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
  /**
   * Step 52: metering. `beforeStart` refuses a start that would exceed an
   * allowance (it throws, and the route answers 429/402); `afterReview` writes
   * down what the worker actually consumed. Both are optional so the route layer
   * still works with no metering configured, which is what the unit tests use.
   */
  readonly usage?:
    | {
        readonly beforeStart: (input: { ownerRef: string; workerId: string }) => Promise<void>;
        readonly afterReview: (input: {
          ownerRef: string;
          workerId: string;
          startedAt: string | null;
          finishedAt: string;
        }) => Promise<void>;
      }
    | undefined;
  /**
   * Step 55: a worker is one billable operation. Its hold is taken before the
   * first model turn and settled once - on acceptance - from every call the
   * executor tallied. Refusing a start for money happens before anything is
   * claimed, so an unaffordable worker leaves no half-started record.
   */
  readonly billing?: OperationBilling | undefined;
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
    if (isUsageLimitError(error)) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.decision === null ? {} : { decision: error.decision }),
        },
      });
    }
    if (isOrchestrationError(error)) {
      return reply
        .status(orchestrationHttpStatus(error.code))
        .send({ error: { code: error.code, message: error.message } });
    }
    // A refused hold (no credit, a spending limit) is a payment answer, not an
    // internal failure: it keeps its own code and status.
    const credit = messageCreditErrorBody(error);
    if (credit.status !== 500) {
      return reply.status(credit.status).send(credit.body);
    }
    return reply.status(500).send({
      error: { code: 'WORKER_INTERNAL', message: 'The worker request could not be completed.' },
    });
  };

  /**
   * The operation a worker's provider calls are charged to. The project comes
   * from its task, because a worker inherits the task's project rather than
   * carrying a second copy of it.
   */
  const operationRefOf = async (
    ownerRef: string,
    worker: { readonly id: string; readonly taskId: string },
  ): Promise<OperationRef> => {
    const task = await workers.tasks.manager.getTask(ownerRef, worker.taskId).catch(() => null);
    const projectId = task?.projectId ?? null;
    return {
      ownerRef,
      kind: 'agent.execution',
      operationId: worker.id,
      taskId: worker.taskId,
      ...(projectId === null ? {} : { projectId }),
    };
  };

  /**
   * Closes a worker's charge. Accepting the work settles what was measured;
   * anything else (a refusal, a cancellation, a stalled worker) gives the hold
   * back. Billing never decides whether work was accepted, so a settlement
   * failure is reported by the charge row, not by turning the review into an
   * error.
   */
  const closeWorkerCharge = async (
    ownerRef: string,
    worker: { readonly id: string; readonly taskId: string },
    outcome: 'settle' | 'release',
    reason: string,
  ): Promise<void> => {
    if (deps.billing === undefined) return;
    const ref = await operationRefOf(ownerRef, worker);
    if (outcome === 'release') {
      await deps.billing.abandon(ref, reason).catch(() => undefined);
      return;
    }
    await deps.billing.settle(ref).catch(() => undefined);
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
        // Refused before anything is claimed: a spent allowance must not leave a
        // half-started worker behind.
        if (deps.usage !== undefined) {
          await deps.usage.beforeStart({ ownerRef: owner(request), workerId });
        }
        // The hold comes before the first model turn, and a worker nobody can pay
        // for is refused here rather than half-way through its assignment.
        const pending = await manager.get(owner(request), workerId);
        if (deps.billing !== undefined) {
          await deps.billing.begin(await operationRefOf(owner(request), pending));
        }
        const started = await manager.start(owner(request), workerId);
        if (started.status !== 'awaiting_review') {
          // The executor is finished (a failure, a timeout, a cancellation) and no
          // review will follow: give the hold back instead of leaving it to the
          // sweep. Model spend is still written to the usage ledger.
          await closeWorkerCharge(
            owner(request),
            started,
            'release',
            `The worker ended as ${started.status} without work to accept.`,
          );
        }
        return reply.send({ worker: started });
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
        if (deps.usage !== undefined) {
          // Measured wall clock, written once per worker, after the decision is
          // made: metering never decides whether work was accepted, so a failure
          // to write it down must not turn an accepted review into an error.
          await deps.usage
            .afterReview({
              ownerRef: owner(request),
              workerId,
              startedAt: outcome.worker.startedAt ?? null,
              finishedAt: outcome.worker.updatedAt,
            })
            .catch(() => undefined);
        }
        await closeWorkerCharge(
          owner(request),
          outcome.worker,
          outcome.worker.status === 'completed' ? 'settle' : 'release',
          'The review did not accept this work, so its hold went back.',
        );
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
        await closeWorkerCharge(
          owner(request),
          worker,
          'release',
          'The worker was cancelled before its work was accepted.',
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
      for (const worker of recovered) {
        await closeWorkerCharge(
          owner(request),
          worker,
          'release',
          'The worker stalled and was recovered without accepted work.',
        );
      }
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
