import type { FastifyInstance } from 'fastify';
import { isAgentError, type AgentManager } from '@veltravia/agent-core';

/** Maps normalized agent error codes to HTTP status codes. */
const AGENT_ERROR_STATUS: Record<string, number> = {
  AGENT_INVALID_REQUEST: 400,
  AGENT_LIMITS_INVALID: 400,
  AGENT_INVALID_DECISION: 400,
  AGENT_NOT_FOUND: 404,
  AGENT_RUN_NOT_FOUND: 404,
  AGENT_DUPLICATE: 409,
  AGENT_INVALID_TRANSITION: 409,
  AGENT_RUN_TERMINAL: 409,
  AGENT_NOT_ALLOWED: 409,
  AGENT_MODEL_ERROR: 502,
  AGENT_CONSECUTIVE_FAILURES: 502,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isAgentError(error)) {
    const status = AGENT_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

const runBodySchema = {
  type: 'object',
  required: ['agentId', 'task'],
  additionalProperties: false,
  properties: {
    agentId: { type: 'string', minLength: 1, maxLength: 128 },
    task: { type: 'string', minLength: 1, maxLength: 4000 },
    sessionId: { type: 'string', maxLength: 128 },
    projectId: { type: 'string', maxLength: 128 },
    userId: { type: 'string', maxLength: 128 },
    toolFilter: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 } },
    metadata: { type: 'object', additionalProperties: true },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxIterations: { type: 'integer', minimum: 1 },
        maxToolCalls: { type: 'integer', minimum: 1 },
        maxDurationMs: { type: 'integer', minimum: 1 },
        maxConsecutiveFailures: { type: 'integer', minimum: 1 },
        maxOutputTokens: { type: 'integer', minimum: 0 },
      },
    },
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
 * Safe agent endpoints. None of them expose secrets or hidden
 * chain-of-thought (none is stored), bypass permissions, directly execute
 * connectors, or allow unlimited limits (caller limits are resolved against
 * hard ceilings server-side). Confirmations flow to the Step 5 mechanism -
 * callers can never self-approve from inside a run.
 */
export function registerAgentRoutes(app: FastifyInstance, manager: AgentManager): void {
  app.get('/api/agents', async () => ({
    agents: manager.listAgents().map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      description: agent.description,
    })),
  }));

  app.post('/api/agents/run', { schema: { body: runBodySchema } }, async (request, reply) => {
    try {
      const body = request.body as {
        agentId: string;
        task: string;
        sessionId?: string;
        projectId?: string;
        userId?: string;
        toolFilter?: string[];
        metadata?: Record<string, unknown>;
        limits?: Record<string, number>;
      };
      const response = await manager.createRun(body.agentId, {
        task: body.task,
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.userId !== undefined ? { userId: body.userId } : {}),
        ...(body.toolFilter !== undefined ? { toolFilter: body.toolFilter } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        ...(body.limits !== undefined
          ? { limits: body.limits as { [K in keyof typeof body.limits]: number } }
          : {}),
      });
      return reply.send(response);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/agents/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return reply.send(manager.getRun(runId));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post('/api/agents/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return reply.send(manager.cancelRun(runId));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post(
    '/api/agents/runs/:runId/confirmation',
    { schema: { body: confirmationBodySchema } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { decision } = request.body as { decision: 'approve' | 'reject' };
      try {
        return reply.send(await manager.submitConfirmationResult(runId, decision));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );
}
