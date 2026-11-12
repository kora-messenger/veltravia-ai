import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { isAgentError, type AgentManager } from '@veltravia/agent-core';
import { isProjectError, type ProjectEngine } from '@veltravia/project-core';
import { buildMemoryContext, type MemoryManager } from '@veltravia/memory-core';
import { resolveAgentProjectContext } from '../agent-context.js';
import { isGatewayError, type AIProviderGateway } from '@veltravia/ai-gateway';
import { createGatewayAgentManager } from '../agents.js';
import type { BilledRunTracker } from '../billing-hooks.js';
import { billingErrorBody, type UnifiedBilling } from '../unified-billing.js';

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
  // Project Engine errors raised while resolving/validating the run's
  // project/workspace association (unknown project, unknown workspace,
  // mismatched pair, invalid request shape).
  if (isProjectError(error)) {
    const status =
      error.code === 'PROJECT_NOT_FOUND' || error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

function gatewayStatus(code: string): number {
  if (code === 'GATEWAY_NO_PROVIDER_CONFIGURED') return 409;
  if (code === 'GATEWAY_RATE_LIMITED') return 429;
  if (code === 'GATEWAY_DAILY_CEILING_REACHED') return 429;
  if (code === 'GATEWAY_MODEL_UNKNOWN') return 404;
  if (code === 'GATEWAY_CAPABILITY_UNSUPPORTED' || code === 'GATEWAY_INVALID_REQUEST') return 400;
  if (code === 'GATEWAY_TIMEOUT') return 504;
  if (code === 'GATEWAY_AUTH_FAILED') return 401;
  return 502;
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
    workspaceId: { type: 'string', maxLength: 128 },
    userId: { type: 'string', maxLength: 128 },
    toolFilter: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 } },
    metadata: { type: 'object', additionalProperties: true },
    /** 'gateway' runs the owner's own model instead of the scripted demo source. */
    reasoning: { type: 'string', enum: ['scripted', 'gateway'] },
    /** Explicit model id on the owner's connection (optional). */
    modelId: { type: 'string', minLength: 1, maxLength: 128 },
    /** Coming from the gateway owner scope; never trusted as identity. */
    ownerRef: { type: 'string', minLength: 1, maxLength: 256 },
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
export interface AgentRouteDeps {
  /** Step 26 provider gateway; absent means gateway runs are refused honestly. */
  readonly gateway?: {
    readonly gateway: AIProviderGateway | null;
    readonly blockedReason: string | null;
  };
  /** Step 57: the one billing gate, and the tracker that closes its holds. */
  readonly billing?: UnifiedBilling | undefined;
  readonly tracker?: BilledRunTracker | undefined;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  manager: AgentManager,
  projectEngine?: ProjectEngine,
  memory?: MemoryManager,
  deps: AgentRouteDeps = {},
): void {
  const gateway = deps.gateway;
  app.get('/api/agents', async () => ({
    agents: manager.listAgents().map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      description: agent.description,
    })),
  }));

  app.post('/api/agents/run', { schema: { body: runBodySchema } }, async (request, reply) => {
    /*
     * Declared outside the try so a failure after the hold still returns the
     * credit: a refused run must never leave a reservation behind.
     */
    let handle: Awaited<ReturnType<UnifiedBilling['open']>> | null = null;
    try {
      const body = request.body as {
        agentId: string;
        task: string;
        sessionId?: string;
        projectId?: string;
        workspaceId?: string;
        userId?: string;
        toolFilter?: string[];
        metadata?: Record<string, unknown>;
        limits?: Record<string, number>;
        reasoning?: 'scripted' | 'gateway';
        modelId?: string;
        ownerRef?: string;
      };
      // Server-authoritative project/workspace association (Step 11C-4):
      // the engine validates existence and ownership, and derives a
      // bounded safe context (metadata + tree structure, never file
      // contents). The browser's say-so is never trusted.
      const projectContext =
        projectEngine === undefined
          ? undefined
          : await resolveAgentProjectContext(projectEngine, {
              ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
              ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
            });
      // Project memory injection (Step 15): only APPROVED (active)
      // memories of the resolved project enter the run, as UNTRUSTED
      // REFERENCE DATA via the bounded Memory Context Builder. The
      // browser cannot supply or shape memory content - it is derived
      // server-side exclusively.
      let memoryContext: string | undefined;
      if (memory !== undefined && projectEngine !== undefined && body.projectId !== undefined) {
        try {
          const memories = await memory.search({
            projectId: body.projectId,
            status: 'active',
          });
          if (memories.length > 0) {
            memoryContext = buildMemoryContext({
              memories,
              totalMatched: memories.length,
            }).text;
          }
        } catch {
          // Memory is an ENHANCEMENT, never a gate: a memory failure
          // must not fail an otherwise valid run.
          memoryContext = undefined;
        }
      }
      // Step 26: when the caller asks for the gateway, the run executes on the
      // owner's own provider through a per-owner agent host. The same gates,
      // limits, confirmations and cancellation apply.
      let effectiveManager = manager;
      let agentId = body.agentId;
      if (body.reasoning === 'gateway') {
        if (!gateway || !gateway.gateway) {
          return reply.code(409).send({
            error: {
              code: 'GATEWAY_NO_PROVIDER_CONFIGURED',
              message:
                gateway?.blockedReason ??
                'No AI provider is connected yet. Connect one in Settings, then run the agent.',
            },
          });
        }
        // Owner scoping follows the SAME header convention as documents,
        // files and intelligence, so one caller sees their own provider
        // everywhere. The body cannot pick someone else's key.
        const headerOwner =
          (request.headers['x-veltravia-owner-ref'] as string | undefined) ??
          (request.headers['x-veltravia-owner'] as string | undefined);
        const ownerRef = headerOwner ?? body.ownerRef ?? body.userId ?? 'veltravia-dev-user';
        const core = await gateway.gateway.createCore(
          { ownerRef, ...(body.projectId ? { projectId: body.projectId } : {}) },
          body.projectId,
        );
        effectiveManager = await createGatewayAgentManager({
          core,
          ...(body.modelId ? { model: body.modelId } : {}),
        });
        agentId = 'agent.model';
      }
      /*
       * Step 57: an agent run is model work, so it is billed like one. The hold
       * is taken before the loop starts and closed from the status the loop
       * returned: a completed run settles from its own usage, a cancelled or
       * failed one gives the credit back.
       */
      const billingOwner =
        (request.headers['x-veltravia-owner-ref'] as string | undefined) ??
        (request.headers['x-veltravia-owner'] as string | undefined) ??
        body.ownerRef ??
        body.userId ??
        'veltravia-dev-user';
      if (deps.billing !== undefined) {
        try {
          handle = await deps.billing.open({
            ownerRef: billingOwner,
            kind: 'agent.run',
            operation: 'agent-run',
            operationId: randomUUID(),
            ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
            ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
          });
        } catch (error) {
          const mapped = billingErrorBody(error);
          return reply.code(mapped.status).send(mapped.body);
        }
      }

      const response = await effectiveManager.createRun(agentId, {
        task: body.task,
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
        ...(body.userId !== undefined ? { userId: body.userId } : {}),
        ...(body.toolFilter !== undefined ? { toolFilter: body.toolFilter } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        // The agent core treats the context as opaque, serializable data;
        // this one boundary adapts the typed view to that contract.
        ...(projectContext !== undefined
          ? { projectContext: { ...projectContext } as Readonly<Record<string, unknown>> }
          : {}),
        ...(memoryContext !== undefined ? { memoryContext } : {}),
        ...(body.limits !== undefined
          ? { limits: body.limits as { [K in keyof typeof body.limits]: number } }
          : {}),
      });
      if (handle !== null && deps.tracker !== undefined) {
        deps.tracker.track(response.runId, handle);
        await deps.tracker.settle(response.runId, {
          status: String(response.status),
          usage: {
            toolCalls: response.toolCallCount,
            ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
          },
        });
      }
      return reply.send(response);
    } catch (error) {
      if (handle !== null) {
        await handle.release('The agent run was refused before it started.').catch(() => undefined);
      }
      if (isGatewayError(error)) {
        return reply.code(gatewayStatus(error.code)).send({
          error: { code: error.code, message: error.message },
        });
      }
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
