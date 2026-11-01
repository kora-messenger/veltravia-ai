import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isSourceError, sourceHttpStatus } from '@veltravia/source-storage-core';
import type { BackendReport } from '@veltravia/app-builder-core';

import { scanBackend, type BackendScanDeps } from '../backend-scan.js';

/**
 * Backend Builder routes (Step 33).
 *
 * Read-only views over what a project's own files say, plus an explicit
 * capability statement so the UI can label what is not implemented. There is no
 * route here that executes code, opens a database connection, reads a secret or
 * writes a file: mutations stay with the coding-agent run flow, which enforces
 * its own approval and revision rules.
 */

export interface BackendRouteDeps {
  readonly scan: BackendScanDeps;
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

/** What this release genuinely does, and what it explicitly does not. */
const CAPABILITIES = {
  readOnly: true,
  sections: {
    overview: 'implemented',
    routes: 'implemented',
    database: 'inspection-only',
    models: 'implemented',
    functions: 'inspection-only',
    auth: 'inspection-only',
    environment: 'names-only',
    logs: 'unavailable',
  },
  extraction: {
    frameworks: [
      'express-http',
      'fastify-http',
      'next-app-router',
      'next-pages-api',
      'python-decorators',
      'django-urlconf',
    ],
    modelFormats: ['prisma', 'sql'],
    environmentValues: 'never-read',
    logSources: 'none-connected',
  },
  unavailable: [
    'database connections',
    'migrations',
    'function execution',
    'shell or command execution',
    'log streaming',
    'secret values',
  ],
  writes: 'coding-agent-run-with-human-approval',
} as const;

export function registerBackendRoutes(app: FastifyInstance, deps: BackendRouteDeps): void {
  /**
   * Project and workspace resolution happens below the source layer, so its
   * typed errors arrive here too. A foreign project and a missing one already
   * look identical; an unknown workspace must not become a 500.
   */
  const PROJECT_ERROR_STATUS: Record<string, number> = {
    PROJECT_NOT_FOUND: 404,
    PROJECT_ARCHIVED: 409,
    WORKSPACE_NOT_FOUND: 404,
    WORKSPACE_NOT_ACTIVE: 409,
  };

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
    const message = error instanceof Error ? error.message : 'Unexpected backend analysis failure.';
    return reply.status(500).send({ error: { code: 'BACKEND_SCAN_FAILED', message } });
  };

  const report = async (request: FastifyRequest): Promise<BackendReport> => {
    const params = request.params as { projectId: string };
    const query = request.query as { workspaceId?: string };
    return scanBackend(deps.scan, {
      ownerRef: ownerOf(request),
      projectId: params.projectId,
      ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
    });
  };

  app.get('/api/backend/capabilities', async () => CAPABILITIES);

  /** The whole report: what the overview and every section read from. */
  app.get('/api/projects/:projectId/backend', async (request, reply) => {
    try {
      return { report: await report(request) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/backend/routes', async (request, reply) => {
    try {
      const full = await report(request);
      return { routes: full.routes, scanned: full.scanned, warnings: full.warnings };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/backend/models', async (request, reply) => {
    try {
      const full = await report(request);
      return { models: full.models, database: full.database, warnings: full.warnings };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/backend/functions', async (request, reply) => {
    try {
      const full = await report(request);
      return { functions: full.functions, warnings: full.warnings };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Names only. A value has no path out of the analyser. */
  app.get('/api/projects/:projectId/backend/environment', async (request, reply) => {
    try {
      const full = await report(request);
      return { environment: full.environment, values: 'never-read', warnings: full.warnings };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/backend/database', async (request, reply) => {
    try {
      const full = await report(request);
      return { database: full.database, models: full.models, warnings: full.warnings };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/backend/auth', async (request, reply) => {
    try {
      const full = await report(request);
      return { auth: full.auth, warnings: full.warnings };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/backend/logs', async (request, reply) => {
    try {
      const full = await report(request);
      return { logs: full.logs };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
