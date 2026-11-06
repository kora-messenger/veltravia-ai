import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  exportHttpStatus,
  isExportError,
  type ExportManager,
  type ExportView,
} from '@veltravia/export-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import { createRateLimiter, type RateLimiter } from '../rate-limit.js';

/**
 * Native export routes (Step 40, phase 2).
 *
 * Identity is the SAME caller resolution every other route uses; there is no
 * second authentication scheme. Missing and foreign exports answer identically.
 * Archive bytes leave only through the download route.
 */

export interface ExportRouteDeps {
  readonly exports: ExportManager;
  /** Injected so tests can use a tiny window; production uses the defaults. */
  readonly createLimiter?: RateLimiter;
  readonly downloadLimiter?: RateLimiter;
}

const idParam = {
  type: 'object',
  required: ['exportId'],
  properties: {
    exportId: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

const projectParam = {
  type: 'object',
  required: ['projectId'],
  properties: {
    projectId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string', enum: ['project', 'selection'] },
    paths: {
      type: 'array',
      maxItems: 100,
      items: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
} as const;

/** What the browser is allowed to see about an export. */
function toPayload(view: ExportView): ExportView {
  return view;
}

export function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps): void {
  const { exports: manager } = deps;
  const createLimiter = deps.createLimiter ?? createRateLimiter({ max: 20, windowMs: 60_000 });
  const downloadLimiter = deps.downloadLimiter ?? createRateLimiter({ max: 60, windowMs: 60_000 });

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (isExportError(error)) {
      return reply
        .status(exportHttpStatus(error.code))
        .send({ error: { code: error.code, message: error.message } });
    }
    // Anything else is a bug: say so without echoing the error, which could
    // carry a path or content.
    return reply
      .status(500)
      .send({ error: { code: 'EXPORT_INTERNAL', message: 'The export could not be completed.' } });
  };

  const limited = (reply: FastifyReply, seconds: number): FastifyReply =>
    reply
      .status(429)
      .header('retry-after', String(seconds))
      .send({
        error: {
          code: 'EXPORT_RATE_LIMITED',
          message: `Too many export requests. Try again in ${seconds} seconds.`,
        },
      });

  // Create. The central project guard has already refused a project the caller
  // does not own; the manager checks again.
  app.post(
    '/api/projects/:projectId/exports',
    {
      schema: { params: projectParam, body: createBody },
      // Fastify coerces values to the schema's type BEFORE validation, so a
      // string would become ["src"] and [1, 2] would become ["1", "2"]. Check
      // the raw body first and refuse anything that is not exactly the shape.
      preValidation: async (request, reply) => {
        const raw = request.body;
        if (raw === undefined || raw === null) return;
        const body = raw as { scope?: unknown; paths?: unknown };
        const badPaths =
          body.paths !== undefined &&
          (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== 'string'));
        const badScope = body.scope !== undefined && typeof body.scope !== 'string';
        // `paths` without `scope: "selection"` would silently export EVERYTHING.
        const orphanPaths = body.paths !== undefined && body.scope !== 'selection';
        if (badPaths || badScope || orphanPaths) {
          return reply.status(400).send({
            error: {
              code: 'EXPORT_INVALID_REQUEST',
              message:
                'paths must be an array of strings and is only valid with scope "selection".',
            },
          });
        }
      },
    },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      const wait = createLimiter.take(`create:${owner}`);
      if (wait > 0) return limited(reply, wait);
      try {
        const { projectId } = request.params as { projectId: string };
        const body = (request.body ?? {}) as { scope?: string; paths?: string[] };
        const view = await manager.createExport(owner, {
          projectId,
          ...(body.scope === undefined ? {} : { scope: body.scope }),
          ...(body.paths === undefined ? {} : { paths: body.paths }),
        });
        // 201 for a ready archive. A failed export is still a recorded result
        // the user can read, so it is returned with the reason, as a 200.
        return reply.status(view.status === 'ready' ? 201 : 200).send(toPayload(view));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/exports', async (request, reply) => {
    const owner = resolveCallerOwnerRef(request);
    const query = request.query as { projectId?: unknown };
    const projectId =
      typeof query.projectId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(query.projectId)
        ? query.projectId
        : undefined;
    return reply.send({ exports: manager.list(owner, projectId).map(toPayload) });
  });

  app.get('/api/exports/:exportId', { schema: { params: idParam } }, async (request, reply) => {
    try {
      const { exportId } = request.params as { exportId: string };
      return reply.send(toPayload(manager.status(resolveCallerOwnerRef(request), exportId)));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get(
    '/api/exports/:exportId/validate',
    { schema: { params: idParam } },
    async (request, reply) => {
      try {
        const { exportId } = request.params as { exportId: string };
        return reply.send(manager.validate(resolveCallerOwnerRef(request), exportId));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/exports/:exportId/download',
    { schema: { params: idParam } },
    async (request, reply) => {
      const owner = resolveCallerOwnerRef(request);
      const wait = downloadLimiter.take(`download:${owner}`);
      if (wait > 0) return limited(reply, wait);
      try {
        const { exportId } = request.params as { exportId: string };
        const archive = manager.download(owner, exportId);
        return (
          reply
            .status(200)
            .header('content-type', 'application/zip')
            // The name was built from a sanitised project name; quote it anyway.
            .header('content-disposition', `attachment; filename="${archive.fileName}"`)
            .header('content-length', String(archive.bytes.byteLength))
            .header('x-content-type-options', 'nosniff')
            .header('cache-control', 'no-store')
            .header('x-veltravia-archive-sha256', archive.sha256)
            .send(Buffer.from(archive.bytes))
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete('/api/exports/:exportId', { schema: { params: idParam } }, async (request, reply) => {
    try {
      const { exportId } = request.params as { exportId: string };
      manager.discard(resolveCallerOwnerRef(request), exportId);
      return reply.status(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}
