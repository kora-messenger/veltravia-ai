import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  CENTRAL_PRIMARY_AGENT_CONTRACT,
  PRIMARY_AGENT_RESPONSIBILITIES,
  TASK_STATUSES,
  isOrchestrationError,
  orchestrationHttpStatus,
  type TaskStatus,
} from '@veltravia/orchestration-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import { createRateLimiter, type RateLimiter } from '../rate-limit.js';
import type { TaskService } from '../task-service.js';

/**
 * Task orchestration routes (Step 42).
 *
 * The rules these routes keep:
 *  - identity is `resolveCallerOwnerRef`, the same caller resolution as every
 *    other route; a body or query can never assert an owner;
 *  - a task's project scope is verified against the Project Engine before the
 *    row exists, and every later read and write is owner-scoped in the store;
 *  - another owner's task and a task that never existed answer the same 404;
 *  - a client can ask for a status change but not assert one: the lifecycle
 *    table decides, and a worker cannot complete a task.
 *
 * There is no streaming here. Progress is read by polling the events route with
 * `after`, which is enough for a monitor and honest about what it is.
 */

export interface TaskRouteDeps {
  readonly tasks: TaskService;
  readonly createLimiter?: RateLimiter;
}

const taskIdParam = {
  type: 'object',
  required: ['taskId'],
  properties: {
    taskId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

const attemptParam = {
  type: 'object',
  required: ['taskId', 'attempt'],
  properties: {
    taskId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    attempt: { type: 'integer', minimum: 1, maximum: 10 },
  },
} as const;

const dependencyParam = {
  type: 'object',
  required: ['taskId', 'dependsOnTaskId'],
  properties: {
    taskId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    dependsOnTaskId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9_-]+$',
    },
  },
} as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'objective', 'projectId'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 160 },
    objective: { type: 'string', minLength: 1, maxLength: 4_000 },
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
    workspaceId: { type: ['string', 'null'], maxLength: 128 },
    chatId: { type: ['string', 'null'], maxLength: 128 },
    parentTaskId: { type: ['string', 'null'], maxLength: 128 },
    dependencies: {
      type: 'array',
      maxItems: 25,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    assignment: { type: 'object' },
    maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
  },
} as const;

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  const { manager, store, durable } = deps.tasks;
  const writeLimiter = deps.createLimiter ?? createRateLimiter({ max: 120, windowMs: 60_000 });

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (isOrchestrationError(error)) {
      return reply
        .status(orchestrationHttpStatus(error.code))
        .send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({
      error: {
        code: 'ORCHESTRATION_INTERNAL',
        message: 'The task request could not be completed.',
      },
    });
  };

  const limited = (reply: FastifyReply, seconds: number): FastifyReply =>
    reply
      .status(429)
      .header('retry-after', String(seconds))
      .send({
        error: {
          code: 'TASK_RATE_LIMITED',
          message: `Too many task requests. Try again in ${seconds} seconds.`,
        },
      });

  const ownerOf = (request: Parameters<typeof resolveCallerOwnerRef>[0]): string =>
    resolveCallerOwnerRef(request);

  /**
   * What the platform says about orchestration right now. The store is named
   * because a caller must be able to tell durable records from development
   * ones, and `durable` is not a claim about multi-instance support.
   */
  app.get('/api/orchestration/contract', async () => ({
    contract: CENTRAL_PRIMARY_AGENT_CONTRACT,
    reservedResponsibilities: PRIMARY_AGENT_RESPONSIBILITIES.filter(
      (entry) => entry.neverDelegated,
    ).map((entry) => entry.id),
    statuses: TASK_STATUSES,
    storage: { store, durable, multiInstance: false },
  }));

  app.post('/api/tasks', { schema: { body: createBody } }, async (request, reply) => {
    const wait = writeLimiter.take(ownerOf(request));
    if (wait > 0) return limited(reply, wait);
    const body = request.body as {
      title: string;
      objective: string;
      projectId: string;
      workspaceId?: string | null;
      chatId?: string | null;
      parentTaskId?: string | null;
      dependencies?: string[];
      assignment?: unknown;
      maxAttempts?: number;
    };
    try {
      const task = await manager.createTask(ownerOf(request), {
        title: body.title,
        objective: body.objective,
        projectId: body.projectId,
        workspaceId: body.workspaceId ?? null,
        chatId: body.chatId ?? null,
        parentTaskId: body.parentTaskId ?? null,
        dependencies: body.dependencies ?? [],
        assignment: body.assignment,
        maxAttempts: body.maxAttempts,
      });
      return reply.status(201).send({ task, storage: { store, durable } });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get(
    '/api/tasks',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 128 },
            chatId: { type: 'string', minLength: 1, maxLength: 128 },
            parentTaskId: { type: 'string', minLength: 1, maxLength: 128 },
            status: { type: 'string', enum: [...TASK_STATUSES] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as {
        projectId?: string;
        chatId?: string;
        parentTaskId?: string;
        status?: TaskStatus;
        limit?: number;
      };
      try {
        const tasks = await manager.listTasks(ownerOf(request), query);
        return { tasks, total: tasks.length, storage: { store, durable } };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/tasks/:taskId', { schema: { params: taskIdParam } }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return { task: await manager.getTask(ownerOf(request), taskId) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    '/api/tasks/:taskId/transitions',
    {
      schema: {
        params: taskIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['to'],
          properties: {
            to: { type: 'string', enum: [...TASK_STATUSES] },
            message: { type: 'string', maxLength: 2_000 },
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as {
        to: TaskStatus;
        message?: string;
        expectedVersion?: number;
      };
      const wait = writeLimiter.take(ownerOf(request));
      if (wait > 0) return limited(reply, wait);
      try {
        return {
          task: await manager.transition(ownerOf(request), taskId, {
            to: body.to,
            // A client status change is always the primary agent acting on its
            // own plan; a worker's report goes through the attempt routes.
            actor: 'primary_agent',
            message: body.message ?? null,
            expectedVersion: body.expectedVersion,
          }),
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/assignment',
    {
      schema: { params: taskIdParam, body: { type: 'object' } },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      try {
        return { task: await manager.setAssignment(ownerOf(request), taskId, request.body) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/dependencies',
    {
      schema: {
        params: taskIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['dependsOnTaskId'],
          properties: {
            dependsOnTaskId: { type: 'string', minLength: 1, maxLength: 128 },
            required: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as { dependsOnTaskId: string; required?: boolean };
      try {
        return {
          task: await manager.addDependency(ownerOf(request), taskId, body.dependsOnTaskId, {
            required: body.required,
          }),
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete(
    '/api/tasks/:taskId/dependencies/:dependsOnTaskId',
    { schema: { params: dependencyParam } },
    async (request, reply) => {
      const { taskId, dependsOnTaskId } = request.params as {
        taskId: string;
        dependsOnTaskId: string;
      };
      try {
        return { task: await manager.removeDependency(ownerOf(request), taskId, dependsOnTaskId) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/progress',
    {
      schema: {
        params: taskIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['step'],
          properties: {
            step: { type: 'string', minLength: 1, maxLength: 200 },
            message: { type: 'string', maxLength: 500 },
            percent: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as { step: string; message?: string; percent?: number | null };
      try {
        await manager.recordProgress(ownerOf(request), taskId, {
          step: body.step,
          message: body.message ?? null,
          percent: body.percent ?? null,
        });
        return reply.status(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/attempts',
    {
      schema: {
        params: taskIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: ['string', 'null'], maxLength: 128 },
            worker: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = (request.body ?? {}) as { runId?: string | null; worker?: string };
      try {
        const attempt = await manager.startAttempt(ownerOf(request), taskId, {
          runId: body.runId ?? null,
          worker: body.worker,
        });
        return reply.status(201).send({ attempt });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/attempts/:attempt/finish',
    {
      schema: {
        params: attemptParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['summary'],
          properties: {
            summary: { type: 'string', minLength: 1, maxLength: 2_000 },
            outputs: {
              type: 'array',
              maxItems: 50,
              items: { type: 'string', minLength: 1, maxLength: 512 },
            },
            acceptance: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['criterionId', 'satisfied'],
                properties: {
                  criterionId: { type: 'string', minLength: 1, maxLength: 64 },
                  satisfied: { type: ['boolean', 'null'] },
                  note: { type: 'string', maxLength: 500 },
                },
              },
            },
            blockedReason: { type: ['string', 'null'], maxLength: 500 },
            failure: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', minLength: 1, maxLength: 64 },
                message: { type: 'string', minLength: 1, maxLength: 500 },
              },
            },
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId, attempt } = request.params as { taskId: string; attempt: number };
      const body = request.body as {
        summary: string;
        outputs?: string[];
        acceptance?: { criterionId: string; satisfied: boolean | null; note?: string }[];
        blockedReason?: string | null;
        failure?: { code: string; message: string } | null;
        expectedVersion?: number;
      };
      try {
        return {
          task: await manager.finishAttempt(ownerOf(request), taskId, {
            attempt,
            summary: body.summary,
            evidence: {
              outputs: body.outputs ?? [],
              acceptance: body.acceptance ?? [],
              blockedReason: body.blockedReason ?? null,
              failure: body.failure ?? null,
            },
            expectedVersion: body.expectedVersion,
          }),
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/tasks/:taskId/attempts',
    { schema: { params: taskIdParam } },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      try {
        return { attempts: await manager.attempts(ownerOf(request), taskId) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/review',
    {
      schema: {
        params: taskIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'summary'],
          properties: {
            decision: { type: 'string', enum: ['accept', 'reject'] },
            summary: { type: 'string', minLength: 1, maxLength: 2_000 },
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as {
        decision: 'accept' | 'reject';
        summary: string;
        expectedVersion?: number;
      };
      try {
        return {
          task: await manager.review(ownerOf(request), taskId, {
            decision: body.decision,
            summary: body.summary,
            expectedVersion: body.expectedVersion,
          }),
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/retry',
    {
      schema: {
        params: taskIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as { reason: string };
      try {
        return { task: await manager.retry(ownerOf(request), taskId, body.reason) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/cancel',
    {
      schema: {
        params: taskIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as { reason: string };
      try {
        return { task: await manager.cancel(ownerOf(request), taskId, body.reason) };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/tasks/:taskId/checkpoint',
    {
      schema: {
        params: taskIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'id'],
          properties: {
            kind: { type: 'string', enum: ['revision', 'snapshot', 'manual'] },
            id: { type: 'string', minLength: 1, maxLength: 128 },
            note: { type: ['string', 'null'], maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const body = request.body as {
        kind: 'revision' | 'snapshot' | 'manual';
        id: string;
        note?: string | null;
      };
      try {
        return {
          task: await manager.linkCheckpoint(ownerOf(request), taskId, {
            kind: body.kind,
            id: body.id,
            note: body.note ?? null,
          }),
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/tasks/:taskId/events',
    {
      schema: {
        params: taskIdParam,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            after: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      const query = request.query as { after?: number; limit?: number };
      try {
        const events = await manager.events(ownerOf(request), taskId, {
          after: query.after ?? 0,
          limit: query.limit,
        });
        return { events, after: events.at(-1)?.seq ?? query.after ?? 0 };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
