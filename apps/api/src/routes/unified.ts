import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { groupForPath, isBackendSourceFile } from '@veltravia/app-builder-core';
import { isSourceError, sourceHttpStatus } from '@veltravia/source-storage-core';

import { UNIFIED_CAPABILITIES, loadUnifiedApp, type UnifiedDeps } from '../unified-service.js';

/**
 * Unified application workspace routes (Step 34).
 *
 * Every route is a GET except the path grouper, which only classifies the paths
 * it is given (used by the change-review panel). Nothing here writes a file,
 * starts a runtime, opens a database or calls a model: the AI panel keeps using
 * the coding-agent routes, with their approvals and revision rules.
 */

export interface UnifiedRouteDeps {
  readonly unified: UnifiedDeps;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function ownerOf(request: FastifyRequest): string {
  const header = request.headers['x-veltravia-owner-ref'] ?? request.headers['x-veltravia-owner'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.length > 0) return raw.slice(0, 256);
  return readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
}

const PROJECT_ERROR_STATUS: Record<string, number> = {
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_NOT_ACTIVE: 409,
};

export function registerUnifiedRoutes(app: FastifyInstance, deps: UnifiedRouteDeps): void {
  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (isSourceError(error)) {
      return reply.status(sourceHttpStatus(error.code)).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    const projectCode = (error as { code?: unknown }).code;
    if (typeof projectCode === 'string' && projectCode in PROJECT_ERROR_STATUS) {
      return reply.status(PROJECT_ERROR_STATUS[projectCode] ?? 400).send({
        error: {
          code: projectCode,
          message: error instanceof Error ? error.message : 'Project lookup failed.',
        },
      });
    }
    const message =
      error instanceof Error ? error.message : 'Unexpected unified workspace failure.';
    return reply.status(500).send({ error: { code: 'UNIFIED_APP_FAILED', message } });
  };

  const load = (request: FastifyRequest) => {
    const params = request.params as { projectId: string };
    const query = request.query as { workspaceId?: string };
    return loadUnifiedApp(deps.unified, {
      ownerRef: ownerOf(request),
      projectId: params.projectId,
      ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
    });
  };

  app.get('/api/app-builder/unified', async () => UNIFIED_CAPABILITIES);

  /** Everything the workspace needs for its first paint, in one bounded pass. */
  app.get('/api/projects/:projectId/app', async (request, reply) => {
    try {
      const view = await load(request);
      return {
        project: view.project,
        workspace: view.workspace,
        source: view.source,
        overview: view.overview,
        health: view.health,
        files: view.files,
        links: view.links,
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/app/overview', async (request, reply) => {
    try {
      const view = await load(request);
      return { overview: view.overview, source: view.source, workspace: view.workspace };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/app/files', async (request, reply) => {
    try {
      const view = await load(request);
      return { files: view.files, source: view.source };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/app/links', async (request, reply) => {
    try {
      const view = await load(request);
      return { links: view.links };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/app/health', async (request, reply) => {
    try {
      const view = await load(request);
      return { health: view.health };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Classifies the paths a change set would touch, so the review panel can split
   * a plan into frontend, backend and configuration without guessing client-side.
   * Pure: nothing is read, written or approved.
   */
  app.post('/api/projects/:projectId/app/group', async (request, reply) => {
    const body = request.body as { paths?: unknown } | undefined;
    const paths = body?.paths;
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string')) {
      return reply.status(400).send({
        error: { code: 'PATHS_REQUIRED', message: 'Send { paths: string[] }.' },
      });
    }
    if (paths.length > 500) {
      return reply.status(400).send({
        error: { code: 'TOO_MANY_PATHS', message: 'At most 500 paths per request.' },
      });
    }
    // Ownership is still checked: a foreign project must not reveal anything,
    // even a path classification.
    try {
      const view = await load(request);
      const groups: Record<string, string> = {};
      for (const path of paths as string[]) {
        groups[path] = view.files.byPath[path] ?? groupForPath(path);
      }
      return {
        groups,
        backendSource: (paths as string[]).filter((path) => isBackendSourceFile(path)).length,
      };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
