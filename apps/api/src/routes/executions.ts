/**
 * Execution routes (Step 50).
 *
 * The routes are thin on purpose: intake asks the coordinator to plan, dispatch
 * asks it to start what the plan says is ready, sync reconciles progress against
 * stored evidence, review and integrate go through the worker and change-set
 * engines. Nothing here can declare work complete, prove a test run, or merge a
 * change; those answers come from Steps 43-46.
 *
 * The owner always comes from the request context, never the payload, so
 * another owner's execution id is a 404 exactly like a missing one.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { ExecutionError, executionHttpStatus } from '@veltravia/execution-core';

import { UsageLimitError } from '../usage-service.js';

import { resolveCallerOwnerRef } from '../project-access.js';
import type { ExecutionService } from '../execution-service.js';

export interface ExecutionRouteDeps {
  readonly executions: ExecutionService;
  /**
   * Step 52: metering. `beforeStart` refuses an intake whose background-job
   * allowance is spent, `afterStart` commits the hold the refusal path was
   * judged against. Both are optional so the routes still work unmetered.
   */
  readonly usage?:
    | {
        /**
         * Judges the allowance and takes a hold. Throws (429/402) when the
         * intake must not happen. The returned pair closes the hold either way:
         * `settle` keeps the job, `release` gives it back.
         */
        readonly beforeStart: (input: { ownerRef: string; projectId: string }) => Promise<{
          readonly settle: () => Promise<void>;
          readonly release: () => Promise<void>;
        } | null>;
      }
    | undefined;
}

const idParam = {
  type: 'object',
  required: ['executionId'],
  properties: { executionId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const taskParam = {
  type: 'object',
  required: ['executionId', 'taskId'],
  properties: {
    executionId: { type: 'string', minLength: 1, maxLength: 64 },
    taskId: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

const owner = (request: { headers: Record<string, unknown> }): string =>
  resolveCallerOwnerRef(request as never);

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
  if (error instanceof ExecutionError) {
    return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerExecutionRoutes(app: FastifyInstance, deps: ExecutionRouteDeps): void {
  const executions = deps.executions.manager;

  /** What the dashboard can expect: budgets, the open statuses, the limits. */
  app.get('/api/executions/capabilities', async () => ({
    capabilities: {
      maxConcurrent: { default: 3, ceiling: 6 },
      requiresVerificationFor: ['frontend', 'backend', 'database', 'api', 'testing'],
      approvalReasons: [
        'deployment',
        'publishing',
        'destructive-change',
        'sensitive-data',
        'payments',
        'permission-expansion',
        'scope-change',
      ],
      progress: 'computed from task records, workers, verification runs and change sets',
      simulatedWorkers: true,
      autoIntegration: false,
    },
  }));

  /** Natural-language intake: plans, creates the task graph, records approvals. */
  app.post(
    '/api/executions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'request'],
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 64 },
            // Length is the engine's rule, not the schema's: one owner for it.
            request: { type: 'string', minLength: 1, maxLength: 8000 },
            workspaceId: { type: 'string', minLength: 1, maxLength: 64 },
            maxConcurrent: { type: 'integer', minimum: 1, maximum: 6 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        projectId: string;
        request: string;
        workspaceId?: string;
        maxConcurrent?: number;
      };
      // Nothing is planned until the allowance answers yes. The hold taken here
      // is what stops two simultaneous requests from spending one job.
      let hold: { settle: () => Promise<void>; release: () => Promise<void> } | null;
      try {
        hold =
          deps.usage === undefined
            ? null
            : await deps.usage.beforeStart({ ownerRef: owner(request), projectId: body.projectId });
      } catch (error) {
        return fail(reply, error);
      }
      try {
        const view = await executions.start({
          ownerRef: owner(request),
          text: body.request,
          projectId: body.projectId,
          ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
          ...(body.maxConcurrent === undefined ? {} : { maxConcurrent: body.maxConcurrent }),
        });
        // The job exists now: the hold becomes a recorded job. A metering write
        // that fails must not turn a created execution into an error.
        await hold?.settle().catch(() => undefined);
        return reply.status(201).send(view);
      } catch (error) {
        // The plan never started, so the hold goes back.
        await hold?.release().catch(() => undefined);
        return fail(reply, error);
      }
    },
  );

  app.get('/api/executions', async (request) => {
    const query = request.query as { projectId?: string; open?: string; limit?: string };
    const views = await executions.list(owner(request), {
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      openOnly: query.open === 'true',
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    });
    return { executions: views.map((view) => view.execution), count: views.length };
  });

  app.get(
    '/api/executions/:executionId',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      try {
        const view = await executions.get(owner(request), executionId);
        const report = await executions.report(owner(request), executionId);
        return { ...view, report };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/executions/:executionId/plan',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      try {
        const view = await executions.get(owner(request), executionId);
        return {
          plan: view.plan,
          revisions: view.execution.revisions,
          approvals: view.execution.approvals,
        };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Starts the tasks the plan says are ready, within the concurrency budget. */
  app.post(
    '/api/executions/:executionId/dispatch',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      try {
        return await executions.dispatch(owner(request), executionId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Reconciles progress, opens recovery for failed workers once, and saves. */
  app.post(
    '/api/executions/:executionId/sync',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      try {
        return await executions.sync(owner(request), executionId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/executions/:executionId/tasks/:taskId/review',
    {
      schema: {
        params: taskParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: {
            decision: { type: 'string', enum: ['accept', 'reject'] },
            note: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { executionId, taskId } = request.params as {
        executionId: string;
        taskId: string;
      };
      const body = request.body as { decision: 'accept' | 'reject'; note?: string };
      try {
        return await executions.review(
          owner(request),
          executionId,
          taskId,
          body.decision,
          body.note ?? '',
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/executions/:executionId/integrate',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      try {
        return await executions.integrate(owner(request), executionId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/executions/:executionId/revisions',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 8, maxLength: 2000 },
            remove: { type: 'array', items: { type: 'string', maxLength: 64 } },
            scopeChange: { type: 'string', minLength: 8, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      const body = request.body as { reason: string; remove?: string[]; scopeChange?: string };
      try {
        return await executions.revise(owner(request), executionId, {
          reason: body.reason,
          ...(body.remove === undefined ? {} : { remove: body.remove }),
          ...(body.scopeChange === undefined ? {} : { scopeChange: body.scopeChange }),
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/executions/:executionId/approvals/:approvalId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['executionId', 'approvalId'],
          properties: {
            executionId: { type: 'string', minLength: 1, maxLength: 64 },
            approvalId: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: {
            decision: { type: 'string', enum: ['approve', 'refuse'] },
            note: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { executionId, approvalId } = request.params as {
        executionId: string;
        approvalId: string;
      };
      const body = request.body as { decision: 'approve' | 'refuse'; note?: string };
      try {
        return await executions.decide(
          owner(request),
          executionId,
          approvalId,
          body.decision === 'approve' ? 'approved' : 'refused',
          body.note ?? '',
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/executions/:executionId/report',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      try {
        const report = await executions.report(owner(request), executionId);
        return { report };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/executions/:executionId/cancel',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      try {
        return await executions.cancel(owner(request), executionId, 'Cancelled by the owner.');
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/executions/errors', async () => ({
    codes: [
      'EXECUTION_NOT_FOUND',
      'EXECUTION_CLOSED',
      'EXECUTION_REQUEST_TOO_SHORT',
      'EXECUTION_PROJECT_UNAVAILABLE',
      'EXECUTION_EVIDENCE_REQUIRED',
      'EXECUTION_APPROVAL_REQUIRED',
      'EXECUTION_NOTHING_TO_INTEGRATE',
      'EXECUTION_REVISION_REASON_REQUIRED',
      'EXECUTION_TASK_NOT_FOUND',
    ].map((code) => ({ code, status: executionHttpStatus(code) })),
  }));
}
