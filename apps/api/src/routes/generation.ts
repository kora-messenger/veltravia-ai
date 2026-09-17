import type { FastifyInstance } from 'fastify';
import {
  isGenerationError,
  type AppGenerationManager,
  type GenerationPlanView,
  type GenerationResult,
  type GenerationRunView,
} from '@veltravia/generation-core';

/** Maps normalized generation error codes to HTTP status codes. */
const GENERATION_ERROR_STATUS: Record<string, number> = {
  GENERATION_INVALID_REQUEST: 400,
  GENERATION_SECRET_REJECTED: 400,
  GENERATION_INVALID_SPEC: 400,
  GENERATION_UNSUPPORTED_APP_TYPE: 400,
  GENERATION_UNSUPPORTED_TEMPLATE: 400,
  GENERATION_INVALID_PLAN: 400,
  GENERATION_PLAN_REJECTED: 409,
  GENERATION_APPROVAL_REQUIRED: 409,
  GENERATION_NOT_AWAITING_APPROVAL: 409,
  GENERATION_RUN_NOT_FOUND: 404,
  GENERATION_RUN_TERMINAL: 409,
  GENERATION_INVALID_TRANSITION: 409,
  GENERATION_FILE_LIMIT: 409,
  GENERATION_COMMAND_LIMIT: 409,
  GENERATION_REPAIR_LIMIT: 409,
  GENERATION_DURATION_LIMIT: 409,
  GENERATION_VALIDATION_FAILED: 422,
  GENERATION_TEST_FAILED: 422,
  GENERATION_PROJECT_CONFLICT: 409,
  GENERATION_CANCELLED: 409,
  GENERATION_PLANNER_ERROR: 422,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isGenerationError(error)) {
    const status = GENERATION_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

/** The safe public shape of a run: exactly the GenerationRunView fields. */
function toRunPayload(view: GenerationRunView): Record<string, unknown> {
  return {
    runId: view.runId,
    state: view.state,
    idea: view.idea,
    projectId: view.projectId,
    workspaceId: view.workspaceId,
    templateId: view.templateId,
    specName: view.specName,
    appType: view.appType,
    phases: view.phases,
    changedFiles: view.changedFiles,
    repairAttempts: view.repairAttempts,
    failure: view.failure,
    pendingApproval: view.pendingApproval,
    result: view.result,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

/** The safe plan payload: paths, sizes, dependencies, commands, risk - no file dumps. */
function toPlanPayload(plan: GenerationPlanView): Record<string, unknown> {
  return {
    version: plan.version,
    project: plan.project,
    templateId: plan.templateId,
    filesToCreate: plan.filesToCreate,
    filesToModify: plan.filesToModify,
    dependencies: plan.dependencies,
    commands: plan.commands,
    risk: plan.risk,
  };
}

/** The safe result payload: exactly the GenerationResult fields. */
function toResultPayload(result: GenerationResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    projectId: result.projectId,
    workspaceId: result.workspaceId,
    filesChanged: result.filesChanged,
    validation: result.validation,
    tests: result.tests,
    repairAttempts: result.repairAttempts,
    warnings: result.warnings,
    remainingIssues: result.remainingIssues,
    completedAt: result.completedAt,
  };
}

const startBodySchema = {
  type: 'object',
  required: ['idea'],
  additionalProperties: false,
  properties: {
    idea: { type: 'string', minLength: 10, maxLength: 4000 },
    runId: { type: 'string', minLength: 1, maxLength: 128 },
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
 * Safe app-generation endpoints. Every file mutation and sandbox command
 * flows through the Tool System; plan approvals and tool confirmations are
 * decided by HUMANS through these routes - never by the engine itself.
 * Responses carry safe normalized state only: no secrets, no host paths,
 * no file-content dumps (the plan view carries paths and sizes only).
 */
export function registerGenerationRoutes(
  app: FastifyInstance,
  manager: AppGenerationManager,
): void {
  app.post(
    '/api/app-generations',
    { schema: { body: startBodySchema } },
    async (request, reply) => {
      try {
        const body = request.body as { idea: string; runId?: string };
        const view = await manager.startRun({
          idea: body.idea,
          ...(body.runId !== undefined ? { runId: body.runId } : {}),
        });
        return reply.code(201).send(toRunPayload(view));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.get('/api/app-generations/:runId', async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      return reply.send(toRunPayload(manager.getRun(runId)));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/app-generations/:runId/plan', async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      return reply.send(toPlanPayload(manager.getPlan(runId)));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/app-generations/:runId/result', async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      return reply.send(toResultPayload(manager.getResult(runId)));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post(
    '/api/app-generations/:runId/approve',
    { schema: { body: approvalBodySchema } },
    async (request, reply) => {
      try {
        const { runId } = request.params as { runId: string };
        const body = request.body as { decision: 'approve' | 'reject' };
        const view = await manager.submitApproval(runId, body.decision);
        return reply.send(toRunPayload(view));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.post('/api/app-generations/:runId/cancel', async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      return reply.send(toRunPayload(await manager.cancelRun(runId)));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });
}
