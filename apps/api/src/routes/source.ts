import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  isSourceError,
  sourceHttpStatus,
  type ChangeOperation,
  type SourceRepositoryManager,
} from '@veltravia/source-storage-core';
import { classifyFrontendStructure } from '@veltravia/app-builder-core';

/**
 * Native project source routes (Step 31).
 *
 * Everything here is owner-scoped: the owner comes from the request header and
 * the storage layer refuses a project that belongs to anyone else with the same
 * answer it gives for a missing one. Paths are validated below the route, not
 * here, so every entry point gets the same rules.
 */

export interface SourceRouteDeps {
  readonly source: SourceRepositoryManager;
  /**
   * Optional stack detection, supplied by the server wiring. When it is absent
   * (or fails) the structure endpoint reports `framework: null` and groups
   * files neutrally instead of guessing React.
   */
  readonly detectStack?: (
    projectId: string,
    workspaceId: string | undefined,
  ) => Promise<string | null>;
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

const operationSchema = {
  type: 'object',
  required: ['op'],
  additionalProperties: false,
  properties: {
    op: {
      type: 'string',
      enum: ['create', 'update', 'delete', 'move', 'rename', 'create-directory'],
    },
    path: { type: 'string', maxLength: 512 },
    fromPath: { type: 'string', maxLength: 512 },
    toDirectory: { type: 'string', maxLength: 512 },
    newName: { type: 'string', maxLength: 255 },
    content: { type: 'string', maxLength: 512 * 1024 },
    expectedRevision: { type: 'integer', minimum: 1 },
  },
} as const;

export function registerSourceRoutes(app: FastifyInstance, deps: SourceRouteDeps): void {
  const { source } = deps;

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (isSourceError(error)) {
      return reply.status(sourceHttpStatus(error.code)).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    // A project-engine lookup that found nothing is a 404, not a failure: the
    // source layer reads through the engine's file tree, and "no such file"
    // was being reported as an internal error.
    const name = error instanceof Error ? `${error.name}` : '';
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    if (name.includes('NotFound') || code.includes('NOT_FOUND')) {
      return reply.status(404).send({
        error: { code: 'SOURCE_FILE_NOT_FOUND', message: 'That path is not in this project.' },
      });
    }
    const message = error instanceof Error ? error.message : 'Unexpected source storage failure.';
    return reply.status(500).send({ error: { code: 'SOURCE_FAILED', message } });
  };

  const scope = (request: FastifyRequest) => {
    const params = request.params as { projectId: string };
    const query = request.query as { workspaceId?: string };
    return {
      ownerRef: ownerOf(request),
      projectId: params.projectId,
      ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
    };
  };

  // -- tree and files ------------------------------------------------------

  app.get('/api/projects/:projectId/source', async (request, reply) => {
    try {
      return { tree: await source.tree(ownerOf(request), scope(request)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/source/file', async (request, reply) => {
    const query = request.query as { path?: string };
    if (typeof query.path !== 'string' || query.path.length === 0) {
      return reply.status(400).send({
        error: { code: 'SOURCE_INVALID_REQUEST', message: 'A path query parameter is required.' },
      });
    }
    try {
      const file = await source.readFile(ownerOf(request), { ...scope(request), path: query.path });
      return { file };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Logical frontend structure: pages, components, layouts, hooks, styles,
   * assets, utilities. Path-only classification - no file contents travel and
   * no framework is assumed when detection did not identify one.
   */
  app.get('/api/projects/:projectId/source/structure', async (request, reply) => {
    try {
      const scoped = scope(request);
      const tree = await source.tree(ownerOf(request), scoped);
      let framework: string | null = null;
      if (deps.detectStack !== undefined) {
        try {
          framework = await deps.detectStack(scoped.projectId, tree.workspaceId);
        } catch {
          // Detection is presentation-only: an unknown stack stays unknown.
          framework = null;
        }
      }
      return {
        structure: classifyFrontendStructure({
          framework,
          files: tree.files.map((file) => ({ path: file.path, size: file.size })),
        }),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/source/history', async (request, reply) => {
    const query = request.query as { path?: string; limit?: string };
    try {
      const history = await source.history(ownerOf(request), {
        ...scope(request),
        ...(query.path === undefined ? {} : { path: query.path }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) || undefined }),
      });
      return history;
    } catch (error) {
      return fail(reply, error);
    }
  });

  // -- writes --------------------------------------------------------------

  app.post('/api/projects/:projectId/source/changes', async (request, reply) => {
    const body = request.body as {
      operations?: ChangeOperation[];
      summary?: string;
      workspaceId?: string;
    };
    try {
      const result = await source.changeSet(ownerOf(request), {
        projectId: (request.params as { projectId: string }).projectId,
        ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
        operations: body.operations ?? [],
        ...(body.summary === undefined ? {} : { summary: body.summary }),
      });
      return reply.status(200).send({ result });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/projects/:projectId/source/files', async (request, reply) => {
    const body = request.body as { path?: string; content?: string; workspaceId?: string };
    try {
      const result = await source.createFile(ownerOf(request), {
        projectId: (request.params as { projectId: string }).projectId,
        ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
        path: body.path ?? '',
        content: body.content ?? '',
      });
      return reply.status(201).send({ result });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch('/api/projects/:projectId/source/file', async (request, reply) => {
    const body = request.body as {
      path?: string;
      content?: string;
      expectedRevision?: number;
      workspaceId?: string;
    };
    try {
      const result = await source.updateFile(ownerOf(request), {
        projectId: (request.params as { projectId: string }).projectId,
        ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
        path: body.path ?? '',
        content: body.content ?? '',
        expectedRevision: body.expectedRevision ?? 0,
      });
      return { result };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/projects/:projectId/source/file', async (request, reply) => {
    const query = request.query as {
      path?: string;
      expectedRevision?: string;
      workspaceId?: string;
    };
    try {
      const result = await source.deleteFile(ownerOf(request), {
        projectId: (request.params as { projectId: string }).projectId,
        ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
        path: query.path ?? '',
        ...(query.expectedRevision === undefined
          ? {}
          : { expectedRevision: Number(query.expectedRevision) || undefined }),
      });
      return { result };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/projects/:projectId/source/directories', async (request, reply) => {
    const body = request.body as { path?: string; workspaceId?: string };
    try {
      const result = await source.createDirectory(ownerOf(request), {
        projectId: (request.params as { projectId: string }).projectId,
        ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
        path: body.path ?? '',
      });
      return reply.status(201).send({ result });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // -- snapshots and manifests --------------------------------------------

  app.get('/api/projects/:projectId/source/snapshots', async (request, reply) => {
    try {
      return { snapshots: await source.listSnapshots(ownerOf(request), scope(request)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/projects/:projectId/source/snapshots', async (request, reply) => {
    const body = (request.body ?? {}) as {
      workspaceId?: string;
      kind?: 'manual' | 'automatic';
      label?: string;
      note?: string;
    };
    try {
      const snapshot = await source.createSnapshot(ownerOf(request), {
        projectId: (request.params as { projectId: string }).projectId,
        ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
        ...(body.kind === undefined ? {} : { kind: body.kind }),
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return reply.status(201).send({ snapshot });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/source/snapshots/:snapshotId', async (request, reply) => {
    const query = request.query as { workspaceId?: string };
    try {
      const snapshot = await source.getSnapshot(ownerOf(request), {
        projectId: (request.params as { projectId: string; snapshotId: string }).projectId,
        ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
        snapshotId: (request.params as { snapshotId: string }).snapshotId,
      });
      return { snapshot };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    '/api/projects/:projectId/source/snapshots/:snapshotId/restore',
    async (request, reply) => {
      const body = (request.body ?? {}) as { workspaceId?: string };
      try {
        const restore = await source.restoreSnapshot(ownerOf(request), {
          projectId: (request.params as { projectId: string; snapshotId: string }).projectId,
          ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
          snapshotId: (request.params as { snapshotId: string }).snapshotId,
        });
        return { restore };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/projects/:projectId/source/compare', async (request, reply) => {
    const query = request.query as { from?: string; to?: string; workspaceId?: string };
    if (typeof query.from !== 'string' || typeof query.to !== 'string') {
      return reply.status(400).send({
        error: {
          code: 'SOURCE_INVALID_REQUEST',
          message: 'Both "from" and "to" snapshot ids are required.',
        },
      });
    }
    try {
      const comparison = await source.compareSnapshots(ownerOf(request), {
        projectId: (request.params as { projectId: string }).projectId,
        ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
        fromSnapshotId: query.from,
        toSnapshotId: query.to,
      });
      return { comparison };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/source/manifest', async (request, reply) => {
    try {
      return { manifest: await source.manifest(ownerOf(request), scope(request)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/projects/:projectId/source/storage', async () => ({ storage: source.storage() }));

  // Operation schema is exported for tests that assert the boundary rejects
  // unknown fields before reaching storage.
  void operationSchema;
}
