import type { FastifyInstance } from 'fastify';
import {
  isCodingError,
  type CodingAgentManager,
  type CodingRunView,
} from '@veltravia/coding-agent-core';

/** Maps normalized coding error codes to HTTP status codes. */
const CODING_ERROR_STATUS: Record<string, number> = {
  CODING_INVALID_REQUEST: 400,
  CODING_SECRET_REJECTED: 400,
  CODING_INVALID_PLAN: 400,
  CODING_PLAN_REJECTED: 400,
  CODING_INVALID_DECISION: 400,
  CODING_STALE_REVISION: 409,
  CODING_PROJECT_NOT_FOUND: 404,
  CODING_WORKSPACE_NOT_FOUND: 404,
  CODING_PROJECT_NOT_ACTIVE: 409,
  CODING_RUN_NOT_FOUND: 404,
  CODING_RUN_TERMINAL: 409,
  CODING_NOT_AWAITING_APPROVAL: 409,
  CODING_INVALID_TRANSITION: 409,
  CODING_TOOL_CALL_LIMIT: 409,
  CODING_ITERATION_LIMIT: 409,
  CODING_DURATION_LIMIT: 409,
  CODING_CONSECUTIVE_FAILURES: 409,
  CODING_CANCELLED: 409,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isCodingError(error)) {
    const status = CODING_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

/** The safe public shape of a run: exactly the CodingRunView fields. */
function toRunPayload(view: CodingRunView): Record<string, unknown> {
  return {
    runId: view.runId,
    projectId: view.projectId,
    workspaceId: view.workspaceId,
    state: view.state,
    summary: view.summary,
    changedFiles: view.changedFiles,
    validationResults: view.validationResults,
    iterations: view.iterations,
    toolCalls: view.toolCalls,
    startedAt: view.startedAt,
    updatedAt: view.updatedAt,
    pendingApproval: view.pendingApproval,
    failure: view.failure,
  };
}

const runBodySchema = {
  type: 'object',
  required: ['projectId', 'workspaceId', 'userRequirement'],
  additionalProperties: false,
  properties: {
    runId: { type: 'string', minLength: 1, maxLength: 128 },
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    userRequirement: { type: 'string', minLength: 1, maxLength: 4000 },
    targetFiles: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4000 } },
    constraints: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4000 } },
    acceptanceCriteria: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4000 } },
  },
} as const;

const confirmationBodySchema = {
  type: 'object',
  required: ['decision'],
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approve', 'reject'] },
  },
} as const;

/**
 * Safe coding-agent endpoints. Runs are bounded by server-side limits with
 * hard ceilings; every file mutation and validation flows through the Tool
 * System; plan approvals and tool confirmations are decided by HUMANS through
 * these routes - never by the agent itself. Responses carry safe normalized
 * state only: no secrets, no chain-of-thought, no host paths.
 */
export function registerCodingRoutes(app: FastifyInstance, manager: CodingAgentManager): void {
  app.post('/api/coding/runs', { schema: { body: runBodySchema } }, async (request, reply) => {
    try {
      const body = request.body as {
        projectId: string;
        workspaceId: string;
        userRequirement: string;
        runId?: string;
        targetFiles?: string[];
        constraints?: string[];
        acceptanceCriteria?: string[];
      };
      const view = await manager.startRun({
        projectId: body.projectId,
        workspaceId: body.workspaceId,
        userRequirement: body.userRequirement,
        ...(body.runId !== undefined ? { runId: body.runId } : {}),
        ...(body.targetFiles !== undefined ? { targetFiles: body.targetFiles } : {}),
        ...(body.constraints !== undefined ? { constraints: body.constraints } : {}),
        ...(body.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: body.acceptanceCriteria }
          : {}),
      });
      reply.code(200);
      return toRunPayload(view);
    } catch (error) {
      const { status, body } = toHttpError(error);
      reply.code(status);
      return body;
    }
  });

  app.get('/api/coding/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      reply.code(200);
      return toRunPayload(manager.getRun(runId));
    } catch (error) {
      const { status, body } = toHttpError(error);
      reply.code(status);
      return body;
    }
  });

  app.post('/api/coding/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      reply.code(200);
      return toRunPayload(manager.cancelRun(runId));
    } catch (error) {
      const { status, body } = toHttpError(error);
      reply.code(status);
      return body;
    }
  });

  app.post(
    '/api/coding/runs/:runId/confirmation',
    { schema: { body: confirmationBodySchema } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { decision } = request.body as { decision: 'approve' | 'reject' };
      try {
        const view = await manager.submitApproval(runId, decision);
        reply.code(200);
        return toRunPayload(view);
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );
}
