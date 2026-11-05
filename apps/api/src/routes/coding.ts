import { resolveCallerOwnerRef } from '../project-access.js';
import { RunAccessError, type RunOwnership } from '../run-ownership.js';
import type { FastifyInstance } from 'fastify';
import { captureRunEnd, captureRunStart, type RunCaptureHooks } from '../run-captures.js';
import {
  CODING_PHASES,
  isCodingError,
  type CodingAgentManager,
  type CodingRunView,
} from '@veltravia/coding-agent-core';

import type { ApiCodingDecisionSource } from '../coding-model.js';

/** Maps normalized coding error codes to HTTP status codes. */
const CODING_ERROR_STATUS: Record<string, number> = {
  CODING_INVALID_REQUEST: 400,
  CODING_SECRET_REJECTED: 400,
  CODING_INVALID_PLAN: 400,
  CODING_PLAN_REJECTED: 400,
  CODING_INVALID_DECISION: 400,
  CODING_CHECKPOINT_FAILED: 409,
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
  // Model-powered planning: a missing provider is a fixable state (409), an
  // unreadable answer is the caller's model misbehaving (422), and an upstream
  // outage is not this service's fault (502).
  CODING_MODEL_UNAVAILABLE: 409,
  CODING_MODEL_INVALID_OUTPUT: 422,
  CODING_MODEL_PROVIDER_ERROR: 502,
  CODING_MODEL_CANCELLED: 409,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof RunAccessError) {
    // One status and body for "not yours" and "does not exist".
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: error.message } } };
  }
  if (isCodingError(error)) {
    const status = CODING_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

const ownerOf = resolveCallerOwnerRef;

/**
 * The safe public shape of a run: exactly the CodingRunView fields, plus the
 * model that actually answered (ids only - never a credential) and the real
 * phase the run has reached.
 */
function toRunPayload(
  view: CodingRunView,
  decisionSource?: ApiCodingDecisionSource,
): Record<string, unknown> {
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
    // The validated plan is safe by construction (goal/steps/paths only) and is
    // what makes an approval decision reviewable before anything is written.
    plan: view.plan,
    failure: view.failure,
    phase: view.phase,
    // What was (or was not) checkpointed before the approved changes.
    checkpoint: view.checkpoint,
    ...(decisionSource !== undefined
      ? {
          model: (() => {
            const exchanges = decisionSource.exchangesFor(view.runId);
            const last = exchanges[exchanges.length - 1];
            return {
              used: exchanges.length > 0,
              providerId: last?.providerId ?? null,
              providerName: last?.providerName ?? null,
              modelId: last?.modelId ?? null,
              live: last?.live ?? false,
              decisions: exchanges.length,
            };
          })(),
        }
      : {}),
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

/** What the API's coding agent is actually able to do in this build. */
export interface CodingAgentInfo {
  /** 'scripted-demo' means no model is called; the script decides. */
  readonly decisionSource: 'scripted-demo' | 'injected' | 'model' | 'unavailable';
  readonly planApprovalRequired: boolean;
}

export interface CodingRouteDeps {
  /** Owner of each run; start, read, cancel and approve are all checked against it. */
  readonly runs: RunOwnership;
  /** Present when the API runs the model-powered source. */
  readonly decisionSource?: ApiCodingDecisionSource;
}

/**
 * Safe coding-agent endpoints. Runs are bounded by server-side limits with
 * hard ceilings; every file mutation and validation flows through the Tool
 * System; plan approvals and tool confirmations are decided by HUMANS through
 * these routes - never by the agent itself. Responses carry safe normalized
 * state only: no secrets, no chain-of-thought, no host paths.
 */
export function registerCodingRoutes(
  app: FastifyInstance,
  manager: CodingAgentManager,
  captures: RunCaptureHooks = {},
  info: CodingAgentInfo = { decisionSource: 'scripted-demo', planApprovalRequired: true },
  deps: CodingRouteDeps,
): void {
  /**
   * Capability truth, so the builder UI can say what it is talking to instead
   * of implying a language model is behind every plan.
   */
  app.get('/api/coding/capabilities', async (request) => {
    // Honest per-caller capability: a provider connected by SOMEONE ELSE is not
    // a provider this caller can plan with.
    const described =
      deps.decisionSource !== undefined
        ? await deps.decisionSource.describe(ownerOf(request))
        : null;
    return {
      capabilities: {
        decisionSource: described?.mode ?? info.decisionSource,
        providerName: described?.providerName ?? null,
        unavailableReason: described?.reason ?? null,
        planApprovalRequired: info.planApprovalRequired,
        toolConfirmationsRequired: true,
        phases: CODING_PHASES,
        states: [
          'idle',
          'analyzing',
          'planning',
          'awaiting_approval',
          'inspecting',
          'editing',
          'validating',
          'iterating',
          'completed',
          'failed',
          'cancelled',
        ],
      },
    };
  });

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
      if (deps.decisionSource !== undefined) {
        const described = await deps.decisionSource.describe(ownerOf(request));
        if (described.mode === 'unavailable') {
          reply.code(409);
          return {
            error: {
              code: 'CODING_MODEL_UNAVAILABLE',
              message:
                described.reason ??
                'No AI provider is connected, so no model can plan this change yet.',
            },
          };
        }
      }
      // The caller must own the project, and the workspace must belong to it.
      // The ids are in the BODY, so the parameter guard never sees them.
      await deps.runs.assertCanStart(ownerOf(request), body.projectId, body.workspaceId);
      // Step 18: bracket the run - capture BEFORE the run starts (best-effort).
      await captureRunStart(captures, 'coding_before', body.projectId, body.workspaceId);
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
      deps.runs.record(view.runId, {
        ownerRef: ownerOf(request),
        projectId: body.projectId,
        workspaceId: body.workspaceId,
      });
      reply.code(200);
      return toRunPayload(view, deps.decisionSource);
    } catch (error) {
      const { status, body } = toHttpError(error);
      reply.code(status);
      return body;
    }
  });

  app.get('/api/coding/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      deps.runs.require(ownerOf(request), runId);
      reply.code(200);
      return toRunPayload(manager.getRun(runId), deps.decisionSource);
    } catch (error) {
      const { status, body } = toHttpError(error);
      reply.code(status);
      return body;
    }
  });

  app.post('/api/coding/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      deps.runs.require(ownerOf(request), runId);
      const view = manager.cancelRun(runId);
      // Abort the model call itself: cancelling should stop the spend, not
      // just make the answer unread.
      deps.decisionSource?.abortRun(runId);
      await captureRunEnd(captures, 'coding_after', view.projectId, view.workspaceId, view.state);
      reply.code(200);
      return toRunPayload(view, deps.decisionSource);
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
        deps.runs.require(ownerOf(request), runId);
        const view = await manager.submitApproval(runId, decision);
        await captureRunEnd(captures, 'coding_after', view.projectId, view.workspaceId, view.state);
        reply.code(200);
        return toRunPayload(view, deps.decisionSource);
      } catch (error) {
        const { status, body } = toHttpError(error);
        reply.code(status);
        return body;
      }
    },
  );
}
