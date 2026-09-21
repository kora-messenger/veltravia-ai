import type { FastifyInstance } from 'fastify';
import { captureRunEnd, captureRunStart, type RunCaptureHooks } from '../run-captures.js';
import { isTestingError, type TestRunView, type TestingManager } from '@veltravia/testing-core';

/** Maps normalized testing error codes to HTTP status codes. */
const TESTING_ERROR_STATUS: Record<string, number> = {
  TESTING_INVALID_REQUEST: 400,
  TESTING_SECRET_REJECTED: 400,
  TESTING_UNSUPPORTED_PROJECT: 422,
  TESTING_INVALID_PLAN: 400,
  TESTING_PLAN_REJECTED: 409,
  TESTING_APPROVAL_REQUIRED: 409,
  TESTING_NOT_AWAITING_APPROVAL: 409,
  TESTING_RUN_NOT_FOUND: 404,
  TESTING_RUN_TERMINAL: 409,
  TESTING_INVALID_TRANSITION: 409,
  TESTING_COMMAND_LIMIT: 409,
  TESTING_REPAIR_LIMIT: 409,
  TESTING_REPAIR_REJECTED: 409,
  TESTING_REPAIR_FAILED: 409,
  TESTING_REVISION_CONFLICT: 409,
  TESTING_TEST_FAILED: 409,
  TESTING_INVALID_DIAGNOSIS: 500,
  TESTING_INVALID_REPAIR_PLAN: 500,
  TESTING_DEBUG_ERROR: 500,
  TESTING_CANCELLED: 409,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isTestingError(error)) {
    const status = TESTING_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

/**
 * The safe public shape of a run: exactly the TestRunView fields the manager
 * exposes - normalized plan/results/diagnosis views, bounded command
 * summaries, pending approval metadata, and honest failure codes. No file
 * contents, no secrets, no host paths.
 */
function toRunPayload(view: TestRunView): Record<string, unknown> {
  return {
    runId: view.runId,
    state: view.state,
    projectId: view.projectId,
    workspaceId: view.workspaceId,
    projectType: view.projectType,
    plan: view.plan,
    results: view.results,
    retestResults: view.retestResults,
    diagnosis: view.diagnosis,
    repairPlan: view.repairPlan,
    repairAttempts: view.repairAttempts,
    commandsExecuted: view.commandsExecuted,
    codingRunId: view.codingRunId,
    revisionConflict: view.revisionConflict,
    pendingApproval: view.pendingApproval,
    failure: view.failure,
    notes: view.notes,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

const runBodySchema = {
  type: 'object',
  required: ['projectId', 'workspaceId'],
  additionalProperties: false,
  properties: {
    runId: { type: 'string', minLength: 1, maxLength: 128 },
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

const approvalBodySchema = {
  type: 'object',
  required: ['decision'],
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approve', 'reject'] },
  },
} as const;

/**
 * Safe testing endpoints. Runs are bounded by server-side limits with hard
 * ceilings; every project read and sandbox command flows through the Tool
 * System; plans, repairs, and high-risk tool calls pause for HUMAN decisions
 * through these routes - never by the run itself. Responses carry safe
 * normalized state only: no secrets, no chain-of-thought, no host paths.
 */
export function registerTestingRoutes(
  app: FastifyInstance,
  manager: TestingManager,
  captures: RunCaptureHooks = {},
): void {
  app.post('/api/testing/runs', { schema: { body: runBodySchema } }, async (request, reply) => {
    try {
      const body = request.body as {
        projectId: string;
        workspaceId: string;
        runId?: string;
      };
      // Step 18: bracket the testing run (best-effort).
      await captureRunStart(captures, 'testing_before_repair', body.projectId, body.workspaceId);
      const view = await manager.startRun({
        projectId: body.projectId,
        workspaceId: body.workspaceId,
        ...(body.runId !== undefined ? { runId: body.runId } : {}),
      });
      await captureRunEnd(captures, 'testing_after', view.projectId, view.workspaceId, view.state);
      reply.code(200);
      return toRunPayload(view);
    } catch (error) {
      const { status, body } = toHttpError(error);
      reply.code(status);
      return body;
    }
  });

  app.get('/api/testing/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return toRunPayload(manager.getRun(runId));
    } catch (error) {
      const { status, body } = toHttpError(error);
      reply.code(status);
      return body;
    }
  });

  app.post(
    '/api/testing/runs/:runId/approval',
    { schema: { body: approvalBodySchema } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { decision } = request.body as { decision: 'approve' | 'reject' };
      try {
        const view = await manager.submitApproval(runId, decision);
        await captureRunEnd(
          captures,
          'testing_after',
          view.projectId,
          view.workspaceId,
          view.state,
        );
        reply.code(200);
        return toRunPayload(view);
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );

  app.post('/api/testing/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      const view = manager.cancelRun(runId);
      await captureRunEnd(captures, 'testing_after', view.projectId, view.workspaceId, view.state);
      reply.code(200);
      return toRunPayload(view);
    } catch (error) {
      const { status, body } = toHttpError(error);
      reply.code(status);
      return body;
    }
  });
}
