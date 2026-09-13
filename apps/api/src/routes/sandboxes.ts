import type { FastifyInstance } from 'fastify';
import { isProjectError, type ProjectEngine } from '@veltravia/project-core';
import {
  isSandboxError,
  validateWorkspaceRef,
  type SandboxExecutionRecord,
  type SandboxExecutionResult,
  type SandboxManager,
  type SandboxRecord,
} from '@veltravia/sandbox-core';
import { assertWorkspaceExists } from '../sandboxes.js';

/** Maps normalized sandbox error codes to HTTP status codes. */
const SANDBOX_ERROR_STATUS: Record<string, number> = {
  SANDBOX_INVALID_REQUEST: 400,
  SANDBOX_POLICY_REJECTED: 400,
  SANDBOX_COMMAND_NOT_ALLOWED: 400,
  SANDBOX_ENVIRONMENT_REJECTED: 400,
  SANDBOX_NETWORK_REJECTED: 400,
  SANDBOX_LIMITS_REJECTED: 400,
  SANDBOX_NOT_FOUND: 404,
  EXECUTION_NOT_FOUND: 404,
  SANDBOX_INVALID_TRANSITION: 409,
  SANDBOX_EXPIRED: 409,
  SANDBOX_NOT_READY: 409,
  SANDBOX_FAILED: 500,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isSandboxError(error)) {
    const status = SANDBOX_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

/** Safe sandbox response: state and policy summary only - no secrets. */
function sandboxResponse(sandbox: SandboxRecord): Record<string, unknown> {
  return {
    id: sandbox.id,
    workspaceRef: sandbox.workspaceRef,
    status: sandbox.status,
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
    expiresAt: sandbox.expiresAt,
    lastExecutionId: sandbox.lastExecutionId,
    profile: {
      commandPolicy: {
        allowedCommands: [...sandbox.profile.commandPolicy.allowedCommands],
        allowShellExecution: sandbox.profile.commandPolicy.allowShellExecution,
      },
      networkPolicy: {
        mode: sandbox.profile.networkPolicy.mode,
        allowedDestinations: [...sandbox.profile.networkPolicy.allowedDestinations],
      },
      defaultLimits: { ...sandbox.profile.defaultLimits },
      defaultEnvironmentNames: Object.keys(sandbox.profile.defaultEnvironment).sort(),
    },
  };
}

function executionResponse(execution: SandboxExecutionRecord): Record<string, unknown> {
  return {
    id: execution.id,
    sandboxId: execution.sandboxId,
    command: execution.command,
    argumentCount: execution.arguments.length,
    status: execution.status,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    result: execution.result === null ? null : resultResponse(execution.result),
  };
}

function resultResponse(result: SandboxExecutionResult): Record<string, unknown> {
  return {
    executionId: result.executionId,
    sandboxId: result.sandboxId,
    status: result.status,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    terminated: result.terminated,
    terminationReason: result.terminationReason,
    truncated: result.truncated,
    durationMs: result.resourceUsage.durationMs,
    resourceUsage: { ...result.resourceUsage },
    enforcement: { ...result.enforcement },
    scrubbedCount: result.scrubbedCount,
  };
}

const commandPolicySchema = {
  type: 'object',
  description: 'Command allowlist policy. Allowlist-only; the hard denylist always wins.',
  properties: {
    allowedCommands: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 64 },
      minItems: 1,
      maxItems: 64,
    },
    allowShellExecution: { type: 'boolean' },
  },
  required: ['allowedCommands'],
  additionalProperties: false,
} as const;

const networkPolicySchema = {
  type: 'object',
  description: 'Network policy: disabled by default; allowlist requires explicit destinations.',
  properties: {
    mode: { type: 'string', enum: ['disabled', 'allowlist'] },
    allowedDestinations: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          host: { type: 'string', minLength: 1, maxLength: 253 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
        },
        required: ['host'],
        additionalProperties: false,
      },
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

const limitsSchema = {
  type: 'object',
  description: 'Resource limits (positive integers, bounded by hard ceilings).',
  properties: {
    timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
    maxMemoryMb: { type: 'integer', minimum: 1, maximum: 2048 },
    maxCpuTimeMs: { type: 'integer', minimum: 1, maximum: 600000 },
    maxOutputBytes: { type: 'integer', minimum: 1, maximum: 10485760 },
    maxProcesses: { type: 'integer', minimum: 1, maximum: 64 },
    maxFileBytes: { type: 'integer', minimum: 1, maximum: 134217728 },
  },
  additionalProperties: false,
} as const;

const environmentSchema = {
  type: 'object',
  description: 'Explicit environment entries ONLY - the host environment is never inherited.',
  maxProperties: 32,
  additionalProperties: { type: 'string', maxLength: 2048 },
} as const;

/**
 * Registers the sandbox routes.
 *
 * Only safe inspection/lifecycle endpoints exist here. There is no
 * unrestricted `/api/exec` or `/api/shell`: the only execution endpoint is
 * the per-sandbox one below, and it accepts structured command + arguments
 * only. The API process never executes commands itself - everything flows
 * through the SandboxManager into the SandboxRuntime behind the isolation
 * boundary.
 */
export function registerSandboxRoutes(
  app: FastifyInstance,
  manager: SandboxManager,
  projectEngine: ProjectEngine,
): void {
  app.post(
    '/api/sandboxes',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            workspaceRef: { type: 'string', minLength: 1, maxLength: 128 },
            commandPolicy: commandPolicySchema,
            networkPolicy: networkPolicySchema,
            defaultLimits: limitsSchema,
            defaultEnvironment: environmentSchema,
            ttlMs: { type: 'integer', minimum: 1, maximum: 86400000 },
          },
          required: ['workspaceRef'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      // Shape first: a path-like or malformed workspace reference is a 400
      // before the engine is even consulted.
      try {
        validateWorkspaceRef(body.workspaceRef as string);
      } catch (error) {
        const { status, body: errorBody } = toHttpError(error);
        return reply.code(status).send(errorBody);
      }
      try {
        // Project Engine integration: the workspace must exist. The sandbox
        // references it; it can never bypass the engine's rules.
        await assertWorkspaceExists(projectEngine, body.workspaceRef as string);
      } catch (error) {
        if (isProjectError(error)) {
          const status = error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400;
          return reply.code(status).send({ error: error.toJSON() });
        }
        return reply.code(400).send({
          error: { code: 'SANDBOX_INVALID_REQUEST', message: 'unknown workspace' },
        });
      }
      try {
        const sandbox = await manager.createSandbox({
          workspaceRef: body.workspaceRef as string,
          ...(body.commandPolicy !== undefined
            ? {
                commandPolicy: body.commandPolicy as {
                  allowedCommands: string[];
                  allowShellExecution?: boolean;
                },
              }
            : {}),
          ...(body.networkPolicy !== undefined
            ? { networkPolicy: body.networkPolicy as never }
            : {}),
          ...(body.defaultLimits !== undefined
            ? { defaultLimits: body.defaultLimits as never }
            : {}),
          ...(body.defaultEnvironment !== undefined
            ? { defaultEnvironment: body.defaultEnvironment as Record<string, string> }
            : {}),
          ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs as number } : {}),
        });
        return reply.code(201).send(sandboxResponse(sandbox));
      } catch (error) {
        const { status, body: errorBody } = toHttpError(error);
        return reply.code(status).send(errorBody);
      }
    },
  );

  app.get('/api/sandboxes', async () => {
    const sandboxes = await manager.listSandboxes();
    return { sandboxes: sandboxes.map(sandboxResponse) };
  });

  app.get('/api/sandboxes/:sandboxId', async (request, reply) => {
    const { sandboxId } = request.params as { sandboxId: string };
    try {
      const sandbox = await manager.getSandbox(sandboxId);
      return reply.send(sandboxResponse(sandbox));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post('/api/sandboxes/:sandboxId/stop', async (request, reply) => {
    const { sandboxId } = request.params as { sandboxId: string };
    try {
      const sandbox = await manager.stopSandbox(sandboxId);
      return reply.send(sandboxResponse(sandbox));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post('/api/sandboxes/:sandboxId/destroy', async (request, reply) => {
    const { sandboxId } = request.params as { sandboxId: string };
    try {
      const sandbox = await manager.destroySandbox(sandboxId);
      return reply.send(sandboxResponse(sandbox));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  /**
   * The ONLY execution endpoint. Structured command + arguments (no shell),
   * validated against the sandbox profile, explicit bounded limits, runtime
   * execution behind the isolation boundary - never in the API process,
   * never with inherited environment, never with host paths.
   */
  app.post(
    '/api/sandboxes/:sandboxId/executions',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            command: { type: 'string', minLength: 1, maxLength: 64 },
            arguments: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', maxLength: 4096 },
            },
            workingDirectory: { type: 'string', maxLength: 512 },
            environment: environmentSchema,
            limits: limitsSchema,
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { sandboxId } = request.params as { sandboxId: string };
      const body = request.body as Record<string, unknown>;
      try {
        const result = await manager.startExecution(sandboxId, {
          command: body.command as string,
          arguments: (body.arguments as string[] | undefined) ?? [],
          ...(body.workingDirectory !== undefined
            ? { workingDirectory: body.workingDirectory as string }
            : {}),
          ...(body.environment !== undefined
            ? { environment: body.environment as Record<string, string> }
            : {}),
          ...(body.limits !== undefined ? { limits: body.limits as never } : {}),
        });
        return reply.send(resultResponse(result));
      } catch (error) {
        const { status, body: errorBody } = toHttpError(error);
        return reply.code(status).send(errorBody);
      }
    },
  );

  app.get('/api/sandboxes/:sandboxId/executions/:executionId', async (request, reply) => {
    const { sandboxId, executionId } = request.params as {
      sandboxId: string;
      executionId: string;
    };
    try {
      const execution = await manager.getExecution(sandboxId, executionId);
      return reply.send(executionResponse(execution));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post('/api/sandboxes/:sandboxId/executions/:executionId/cancel', async (request, reply) => {
    const { sandboxId, executionId } = request.params as {
      sandboxId: string;
      executionId: string;
    };
    try {
      const execution = await manager.cancelExecution(sandboxId, executionId);
      return reply.send(executionResponse(execution));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });
}
