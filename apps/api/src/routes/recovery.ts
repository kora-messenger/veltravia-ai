/**
 * Recovery routes (Step 48).
 *
 * These endpoints decide nothing on their own: they assemble evidence that
 * already exists (a worker's record, stored verification runs, change sets and
 * integration conflicts), ask the recovery engine what should happen, and
 * report the decision. There is no field a caller can use to declare work
 * recovered, and no route writes to a project.
 *
 * Identity is the same caller resolution as every other route: the owner is
 * taken from the request context, never from the payload, so a case id from
 * another owner is a 404 exactly like a missing one.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  RECOVERY_CASE_STATUSES,
  RecoveryError,
  recoveryHttpStatus,
} from '@veltravia/recovery-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import type { RecoveryService } from '../recovery-service.js';

export interface RecoveryRouteDeps {
  readonly recovery: RecoveryService;
}

const caseParam = {
  type: 'object',
  required: ['caseId'],
  properties: { caseId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const owner = (request: { headers: Record<string, unknown> }): string =>
  resolveCallerOwnerRef(request as never);

export function registerRecoveryRoutes(app: FastifyInstance, deps: RecoveryRouteDeps): void {
  const { recovery } = deps;

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof RecoveryError) {
      return reply
        .status(error.status || recoveryHttpStatus(error.code))
        .send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({
      error: {
        code: 'RECOVERY_INTERNAL',
        message: 'The recovery request could not be completed.',
      },
    });
  };

  const notFound = (reply: FastifyReply): FastifyReply =>
    reply
      .status(404)
      .send({ error: { code: 'RECOVERY_CASE_NOT_FOUND', message: 'No such recovery case.' } });

  app.get('/api/recovery/capabilities', async () => {
    const capabilities = recovery.capabilities();
    return {
      capabilities: { ...capabilities, statuses: RECOVERY_CASE_STATUSES },
      storage: { kind: recovery.durability },
    };
  });

  app.get(
    '/api/recovery/cases',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 64 },
            taskId: { type: 'string', minLength: 1, maxLength: 64 },
            openOnly: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as {
        projectId?: string;
        taskId?: string;
        openOnly?: boolean;
        limit?: number;
      };
      const cases = await recovery.manager.list(owner(request), {
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
        ...(query.openOnly === undefined ? {} : { openOnly: query.openOnly }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      return { cases, storage: { kind: recovery.durability } };
    },
  );

  app.get(
    '/api/recovery/cases/:caseId',
    { schema: { params: caseParam } },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      try {
        const record = await recovery.manager.inspect(owner(request), caseId);
        const attempts = await recovery.manager.attempts(owner(request), caseId);
        const events = await recovery.manager.events(owner(request), caseId, 0, 200);
        return { case: record, attempts, events, storage: { kind: recovery.durability } };
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_CASE_NOT_FOUND') {
          return notFound(reply);
        }
        return fail(reply, error);
      }
    },
  );

  /**
   * Open a case for a worker that did not simply succeed. The evidence comes
   * from the worker's own record; this route accepts no claims about it.
   */
  app.post(
    '/api/recovery/cases',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['workerId'],
          properties: {
            workerId: { type: 'string', minLength: 1, maxLength: 64 },
            limits: {
              type: 'object',
              additionalProperties: false,
              properties: {
                maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
                maxTotalDurationMs: { type: 'integer', minimum: 1 },
                maxModelCalls: { type: 'integer', minimum: 1 },
                maxConcurrentRepairs: { type: 'integer', minimum: 1, maximum: 8 },
                backoffBaseMs: { type: 'integer', minimum: 1 },
                backoffCeilingMs: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        workerId: string;
        limits?: Record<string, number>;
      };
      try {
        const opened = await recovery.open({
          ownerRef: owner(request),
          workerId: body.workerId,
          ...(body.limits === undefined ? {} : { limits: body.limits }),
        });
        return reply.status(201).send({
          case: opened.record,
          diagnosis: opened.record.diagnosis,
          storage: { kind: recovery.durability },
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Plan, delegate and run one bounded repair attempt, then record its result. */
  app.post(
    '/api/recovery/cases/:caseId/repair',
    { schema: { params: caseParam } },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      try {
        const outcome = await recovery.repair(owner(request), caseId);
        return reply.send({
          case: outcome.record,
          attemptId: outcome.attemptId,
          repairWorker: outcome.repairWorker,
          recovered: outcome.recovered,
          reason: outcome.reason,
        });
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_CASE_NOT_FOUND') {
          return notFound(reply);
        }
        return fail(reply, error);
      }
    },
  );

  /**
   * Close a running attempt against stored evidence. A verification run id is
   * required; recovery is only concluded when that run executed, passed, and
   * the change set was integrated.
   */
  app.post(
    '/api/recovery/cases/:caseId/complete',
    {
      schema: {
        params: caseParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['verificationRunId'],
          properties: {
            verificationRunId: { type: 'string', minLength: 1, maxLength: 64 },
            changeSetId: { type: 'string', minLength: 1, maxLength: 64 },
            attemptId: { type: 'string', minLength: 1, maxLength: 64 },
            summary: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const body = request.body as {
        verificationRunId: string;
        changeSetId?: string;
        attemptId?: string;
        summary?: string;
      };
      try {
        const outcome = await recovery.complete({
          ownerRef: owner(request),
          caseId,
          verificationRunId: body.verificationRunId,
          ...(body.changeSetId === undefined ? {} : { changeSetId: body.changeSetId }),
          ...(body.attemptId === undefined ? {} : { attemptId: body.attemptId }),
          ...(body.summary === undefined ? {} : { summary: body.summary }),
        });
        return reply.send({
          case: outcome.record,
          recovered: outcome.recovered,
          reason: outcome.reason,
        });
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_CASE_NOT_FOUND') {
          return notFound(reply);
        }
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/recovery/cases/:caseId/escalate',
    {
      schema: {
        params: caseParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['message'],
          properties: {
            reason: {
              type: 'string',
              enum: [
                'budget_exhausted',
                'needs_human',
                'policy_refusal',
                'conflict_unresolved',
                'insufficient_evidence',
                'owner_decision',
              ],
            },
            message: { type: 'string', minLength: 1, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const body = request.body as { message: string; reason?: string };
      try {
        const record = await recovery.manager.escalate({
          ownerRef: owner(request),
          caseId,
          reason: (body.reason ?? 'needs_human') as never,
          message: body.message,
        });
        return reply.send({ case: record });
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_CASE_NOT_FOUND') {
          return notFound(reply);
        }
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/recovery/cases/:caseId/cancel',
    {
      schema: {
        params: caseParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string', maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const body = (request.body ?? {}) as { message?: string };
      try {
        const record = await recovery.manager.cancel(
          owner(request),
          caseId,
          body.message ?? 'Recovery cancelled by the owner.',
        );
        return reply.send({ case: record });
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_CASE_NOT_FOUND') {
          return notFound(reply);
        }
        return fail(reply, error);
      }
    },
  );

  /** Restart recovery: abandon what died with the process, revalidate the revision. */
  app.post(
    '/api/recovery/cases/:caseId/resume',
    { schema: { params: caseParam } },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      try {
        const record = await recovery.manager.resume({ ownerRef: owner(request), caseId });
        return reply.send({ case: record });
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_CASE_NOT_FOUND') {
          return notFound(reply);
        }
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/recovery/cases/:caseId/preserve',
    {
      schema: {
        params: caseParam,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['changeSetId'],
          properties: { changeSetId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      const body = request.body as { changeSetId: string };
      try {
        const record = await recovery.manager.preserve(owner(request), caseId, body.changeSetId);
        return reply.send({ case: record });
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_CASE_NOT_FOUND') {
          return notFound(reply);
        }
        return fail(reply, error);
      }
    },
  );

  /** Re-diagnose from the stored observation, e.g. after new evidence. */
  app.post(
    '/api/recovery/cases/:caseId/analyse',
    { schema: { params: caseParam } },
    async (request, reply) => {
      const { caseId } = request.params as { caseId: string };
      try {
        const record = await recovery.manager.reanalyse(owner(request), caseId);
        return reply.send({ case: record });
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_CASE_NOT_FOUND') {
          return notFound(reply);
        }
        return fail(reply, error);
      }
    },
  );
}
