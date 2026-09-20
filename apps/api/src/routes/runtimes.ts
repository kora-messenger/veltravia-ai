import type { FastifyInstance, FastifyReply } from 'fastify';
import { isRuntimeError } from '@veltravia/runtime-core';
import type { RuntimeManager } from '@veltravia/runtime-core';
import { isProjectError, type ProjectEngine } from '@veltravia/project-core';

/**
 * Preview / App Runtime routes (Step 17).
 *
 * Surface: create (evidence-based plan detection, validated), start, stop,
 * cancel, restart, explicit expire, health, logs, list, and the
 * platform-controlled preview page.
 *
 * Boundaries:
 * - every route is scoped to :projectId; ownership is resolved server-side
 *   through the Project Engine gateway - the browser NEVER supplies
 *   commands, ports, limits, or environment values
 * - runtime logs are UNTRUSTED PROJECT DATA: display only, never executed
 * - the preview page is served through the platform-controlled
 *   /preview/:runtimeId URL with sandboxing headers; the executor decides
 *   what renders (the mock shows an explicitly-labeled SIMULATED page)
 * - the API server is NEVER the runtime: every build/start operation flows
 *   through the RuntimeExecutor isolation boundary
 */

const RUNTIME_ERROR_STATUS: Record<string, number> = {
  RUNTIME_INVALID_REQUEST: 400,
  RUNTIME_PLAN_REJECTED: 422,
  RUNTIME_ENV_REJECTED: 422,
  RUNTIME_TYPE_UNSUPPORTED: 422,
  RUNTIME_NOT_FOUND: 404,
  RUNTIME_INVALID_TRANSITION: 409,
  RUNTIME_REVISION_MISMATCH: 409,
  RUNTIME_START_FAILED: 500,
  RUNTIME_EXPIRED: 410,
  RUNTIME_LIMIT_EXCEEDED: 429,
  RUNTIME_CANCELLED: 409,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isRuntimeError(error)) {
    const status = RUNTIME_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  if (isProjectError(error)) {
    const status =
      error.code === 'PROJECT_NOT_FOUND' || error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

export interface RuntimeRoutesOptions {
  readonly runtimeManager: RuntimeManager;
  readonly projectEngine: ProjectEngine;
}

const createBodySchema = {
  type: 'object',
  required: ['workspaceId'],
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    // Declared-but-inactive types pass the schema and fail with the honest
    // typed RUNTIME_TYPE_UNSUPPORTED (422) from the manager - never a silent
    // generic schema rejection.
    runtimeType: { type: 'string', enum: ['web', 'fullstack', 'backend', 'mobile-preview'] },
    scenario: {
      type: 'string',
      enum: [
        'ok',
        'build-failure',
        'missing-dependency',
        'start-failure',
        'port-conflict',
        'health-failure',
        'resource-limit',
        'flaky-then-healthy',
      ],
    },
  },
};

const PREVIEW_SANDBOX_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function registerRuntimeRoutes(app: FastifyInstance, options: RuntimeRoutesOptions): void {
  const { runtimeManager, projectEngine } = options;

  /** Resolves the project or sends the typed 404 - every route begins with it. */
  async function requireProject(projectId: string, reply: FastifyReply): Promise<boolean> {
    try {
      await projectEngine.projects.getProject(projectId);
      return true;
    } catch (error) {
      if (isProjectError(error)) {
        await reply.code(error.code === 'PROJECT_NOT_FOUND' ? 404 : 400).send({
          error: error.toJSON(),
        });
        return false;
      }
      throw error;
    }
  }

  app.post(
    '/api/projects/:projectId/runtimes',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      try {
        const projectId = (request.params as { projectId: string }).projectId;
        if (!(await requireProject(projectId, reply))) {
          return reply;
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const view = await runtimeManager.create({
          projectId,
          workspaceId: String(body.workspaceId ?? ''),
          ...(body.runtimeType !== undefined
            ? {
                runtimeType: body.runtimeType as 'web' | 'fullstack' | 'backend' | 'mobile-preview',
              }
            : {}),
          ...(body.scenario !== undefined ? { scenario: String(body.scenario) } : {}),
        });
        return await reply.code(201).send(view);
      } catch (error) {
        const { status, body } = toHttpError(error);
        return await reply.code(status).send(body);
      }
    },
  );

  app.get('/api/projects/:projectId/runtimes', async (request, reply) => {
    try {
      const projectId = (request.params as { projectId: string }).projectId;
      if (!(await requireProject(projectId, reply))) {
        return reply;
      }
      const query = request.query as { workspaceId?: string };
      const views = await runtimeManager.list({
        projectId,
        ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
      });
      return await reply.send({ runtimes: views });
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  app.get('/api/projects/:projectId/runtimes/:runtimeId', async (request, reply) => {
    try {
      const params = request.params as { projectId: string; runtimeId: string };
      const view = await runtimeManager.get(params.runtimeId);
      if (view.projectId !== params.projectId) {
        return await reply.code(404).send({
          error: { code: 'RUNTIME_NOT_FOUND', message: 'runtime belongs to another project' },
        });
      }
      return await reply.send(view);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  app.get('/api/projects/:projectId/runtimes/:runtimeId/logs', async (request, reply) => {
    try {
      const params = request.params as { projectId: string; runtimeId: string };
      const view = await runtimeManager.get(params.runtimeId);
      if (view.projectId !== params.projectId) {
        return await reply.code(404).send({
          error: { code: 'RUNTIME_NOT_FOUND', message: 'runtime belongs to another project' },
        });
      }
      const logs = await runtimeManager.logs(params.runtimeId);
      return await reply.send(logs);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  app.post('/api/projects/:projectId/runtimes/:runtimeId/start', async (request, reply) => {
    try {
      const params = request.params as { projectId: string; runtimeId: string };
      const view = await runtimeManager.get(params.runtimeId);
      if (view.projectId !== params.projectId) {
        return await reply.code(404).send({
          error: { code: 'RUNTIME_NOT_FOUND', message: 'runtime belongs to another project' },
        });
      }
      const started = await runtimeManager.start(params.runtimeId);
      return await reply.send(started);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  app.post('/api/projects/:projectId/runtimes/:runtimeId/stop', async (request, reply) => {
    try {
      const params = request.params as { projectId: string; runtimeId: string };
      const view = await runtimeManager.get(params.runtimeId);
      if (view.projectId !== params.projectId) {
        return await reply.code(404).send({
          error: { code: 'RUNTIME_NOT_FOUND', message: 'runtime belongs to another project' },
        });
      }
      const stopped = await runtimeManager.stop(params.runtimeId);
      return await reply.send(stopped);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  app.post('/api/projects/:projectId/runtimes/:runtimeId/cancel', async (request, reply) => {
    try {
      const params = request.params as { projectId: string; runtimeId: string };
      const view = await runtimeManager.get(params.runtimeId);
      if (view.projectId !== params.projectId) {
        return await reply.code(404).send({
          error: { code: 'RUNTIME_NOT_FOUND', message: 'runtime belongs to another project' },
        });
      }
      const cancelled = await runtimeManager.cancel(params.runtimeId);
      return await reply.send(cancelled);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  app.post('/api/projects/:projectId/runtimes/:runtimeId/restart', async (request, reply) => {
    try {
      const params = request.params as { projectId: string; runtimeId: string };
      const view = await runtimeManager.get(params.runtimeId);
      if (view.projectId !== params.projectId) {
        return await reply.code(404).send({
          error: { code: 'RUNTIME_NOT_FOUND', message: 'runtime belongs to another project' },
        });
      }
      const result = await runtimeManager.restart(params.runtimeId);
      return await reply.send(result);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  app.post('/api/projects/:projectId/runtimes/:runtimeId/expire', async (request, reply) => {
    try {
      const params = request.params as { projectId: string; runtimeId: string };
      const view = await runtimeManager.get(params.runtimeId);
      if (view.projectId !== params.projectId) {
        return await reply.code(404).send({
          error: { code: 'RUNTIME_NOT_FOUND', message: 'runtime belongs to another project' },
        });
      }
      const expired = await runtimeManager.expire(params.runtimeId);
      return await reply.send(expired);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  app.get('/api/projects/:projectId/runtimes/:runtimeId/health', async (request, reply) => {
    try {
      const params = request.params as { projectId: string; runtimeId: string };
      const view = await runtimeManager.get(params.runtimeId);
      if (view.projectId !== params.projectId) {
        return await reply.code(404).send({
          error: { code: 'RUNTIME_NOT_FOUND', message: 'runtime belongs to another project' },
        });
      }
      const health = await runtimeManager.health(params.runtimeId);
      return await reply.send(health);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });

  // The platform-controlled preview URL. The executor decides what renders;
  // for the mock executor this is an explicitly-labeled SIMULATED page.
  app.get('/preview/:runtimeId', async (request, reply) => {
    try {
      const runtimeId = (request.params as { runtimeId: string }).runtimeId;
      const content = await runtimeManager.renderPreview(runtimeId);
      Object.entries(PREVIEW_SANDBOX_HEADERS).forEach(([key, value]) => reply.header(key, value));
      return await reply.code(200).send(content);
    } catch (error) {
      const { status, body } = toHttpError(error);
      return await reply.code(status).send(body);
    }
  });
}
