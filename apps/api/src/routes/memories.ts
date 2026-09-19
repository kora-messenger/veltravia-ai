import type { FastifyInstance } from 'fastify';
import {
  isMemoryError,
  MEMORY_SORT_KEYS,
  MEMORY_TYPES,
  type CreateMemoryInput,
  type MemoryManager,
  type ProjectMemory,
} from '@veltravia/memory-core';
import { isProjectError, type ProjectEngine } from '@veltravia/project-core';
import { isGenerationError, type AppGenerationManager } from '@veltravia/generation-core';
import { isTestingError, type TestingManager } from '@veltravia/testing-core';
import {
  candidatesFromGenerationRun,
  candidatesFromTestingRun,
  getGenerationRun,
  getTestingRun,
  toMemoryResponse,
} from '../memory-service.js';

/**
 * Project memory routes (Step 15).
 *
 * Surface: per-project memory CRUD, search, lifecycle (archive/restore/
 * verification), candidate review (approve/reject), stats, and explicit
 * candidate extraction from COMPLETED generation/testing runs.
 *
 * Boundaries:
 * - every route is scoped to :projectId and validates the project exists
 *   (unknown project -> 404, never a silent empty namespace)
 * - manual creation is always user-sourced and `active`; extraction
 *   products are ALWAYS `candidate` records pending human approval - they
 *   never enter agent context unreviewed
 * - responses are safe normalized views; errors are typed and scrubbed
 * - raw run views are read only through the memory service, which maps
 *   narrow structural facts and rejects non-completed runs
 */

const MEMORY_ERROR_STATUS: Record<string, number> = {
  MEMORY_INVALID_REQUEST: 400,
  MEMORY_SEARCH_TOO_LARGE: 400,
  MEMORY_INVALID_CANDIDATE: 400,
  MEMORY_SECRET_REJECTED: 422,
  MEMORY_NOT_FOUND: 404,
  MEMORY_LIMIT_REACHED: 409,
  MEMORY_REVISION_CONFLICT: 409,
  MEMORY_INVALID_TRANSITION: 409,
  MEMORY_STORAGE_ERROR: 500,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isMemoryError(error)) {
    const status = MEMORY_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (isProjectError(error)) {
    const status =
      error.code === 'PROJECT_NOT_FOUND' || error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

export interface MemoryRoutesOptions {
  readonly memory: MemoryManager;
  readonly projectEngine: ProjectEngine;
  readonly generation?: AppGenerationManager;
  readonly testing?: TestingManager;
}

const createBodySchema = {
  type: 'object',
  required: ['title', 'content', 'type'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    content: { type: 'string', minLength: 1, maxLength: 4000 },
    type: { type: 'string', enum: [...MEMORY_TYPES] },
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

const updateBodySchema = {
  type: 'object',
  required: ['expectedRevision'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    content: { type: 'string', minLength: 1, maxLength: 4000 },
    type: { type: 'string', enum: [...MEMORY_TYPES] },
    expectedRevision: { type: 'integer', minimum: 1 },
  },
};

const searchBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 200 },
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    type: { type: 'string', enum: [...MEMORY_TYPES] },
    status: { type: 'string', enum: ['active', 'candidate', 'rejected', 'archived'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
};

const extractBodySchema = {
  type: 'object',
  required: ['kind', 'runId'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['generation_run', 'testing_run'] },
    runId: { type: 'string', minLength: 1, maxLength: 128 },
  },
};

export function registerMemoryRoutes(app: FastifyInstance, options: MemoryRoutesOptions): void {
  const { memory, projectEngine, generation, testing } = options;

  /** Validates the project exists (project-scoped memory namespace). */
  const requireProject = async (projectId: string): Promise<void> => {
    await projectEngine.projects.getProject(projectId);
  };

  app.get('/api/projects/:projectId/memories', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const query = request.query as Record<string, string | undefined>;
    try {
      await requireProject(projectId);
      const memories = await memory.list({
        projectId,
        ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
        ...(query.type !== undefined ? { type: query.type as CreateMemoryInput['type'] } : {}),
        ...(query.status !== undefined ? { status: query.status as ProjectMemory['status'] } : {}),
        ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
        ...(query.sort !== undefined && MEMORY_SORT_KEYS.includes(query.sort as never)
          ? { sort: query.sort as 'recent' }
          : {}),
      });
      return reply.send({ memories: memories.map(toMemoryResponse) });
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.get('/api/projects/:projectId/memories/stats', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      await requireProject(projectId);
      return reply.send(await memory.stats(projectId));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post(
    '/api/projects/:projectId/memories/search',
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as {
        text?: string;
        workspaceId?: string;
        type?: string;
        status?: string;
        limit?: number;
      };
      try {
        await requireProject(projectId);
        const memories = await memory.search({
          projectId,
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
          ...(body.type !== undefined ? { type: body.type as CreateMemoryInput['type'] } : {}),
          ...(body.status !== undefined ? { status: body.status as ProjectMemory['status'] } : {}),
          ...(body.limit !== undefined ? { limit: body.limit } : {}),
        });
        return reply.send({ memories: memories.map(toMemoryResponse) });
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.get('/api/projects/:projectId/memories/:memoryId', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
    try {
      await requireProject(projectId);
      return reply.send(toMemoryResponse(await memory.get(memoryId, projectId)));
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post(
    '/api/projects/:projectId/memories',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as {
        title: string;
        content: string;
        type: string;
        workspaceId?: string;
        confidence?: string;
      };
      try {
        await requireProject(projectId);
        const created = await memory.create({
          projectId,
          type: body.type as CreateMemoryInput['type'],
          title: body.title,
          content: body.content,
          // Human-typed memory: the source is the user, always.
          source: { kind: 'user' },
          ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
          ...(body.confidence !== undefined
            ? { confidence: body.confidence as CreateMemoryInput['confidence'] }
            : {}),
        });
        return reply.code(201).send(toMemoryResponse(created));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  app.patch(
    '/api/projects/:projectId/memories/:memoryId',
    { schema: { body: updateBodySchema } },
    async (request, reply) => {
      const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
      const body = request.body as {
        title?: string;
        content?: string;
        type?: string;
        expectedRevision: number;
      };
      try {
        await requireProject(projectId);
        const updated = await memory.update(memoryId, projectId, {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.content !== undefined ? { content: body.content } : {}),
          ...(body.type !== undefined ? { type: body.type as CreateMemoryInput['type'] } : {}),
          expectedRevision: body.expectedRevision,
        });
        return reply.send(toMemoryResponse(updated));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );

  const lifecycle = (
    path: string,
    action: (memoryId: string, projectId: string) => Promise<ProjectMemory>,
  ): void => {
    app.post(path, async (request, reply) => {
      const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
      try {
        await requireProject(projectId);
        return reply.send(toMemoryResponse(await action(memoryId, projectId)));
      } catch (error) {
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    });
  };

  lifecycle('/api/projects/:projectId/memories/:memoryId/archive', (id, project) =>
    memory.archive(id, project),
  );
  lifecycle('/api/projects/:projectId/memories/:memoryId/restore', (id, project) =>
    memory.restore(id, project),
  );
  lifecycle('/api/projects/:projectId/memories/:memoryId/verify', (id, project) =>
    memory.markVerified(id, project),
  );
  lifecycle('/api/projects/:projectId/memories/:memoryId/stale', (id, project) =>
    memory.markStale(id, project),
  );
  lifecycle('/api/projects/:projectId/memories/:memoryId/approve', (id, project) =>
    memory.approveCandidate(id, project),
  );
  lifecycle('/api/projects/:projectId/memories/:memoryId/reject', (id, project) =>
    memory.rejectCandidate(id, project),
  );

  app.delete('/api/projects/:projectId/memories/:memoryId', async (request, reply) => {
    const { projectId, memoryId } = request.params as { projectId: string; memoryId: string };
    try {
      await requireProject(projectId);
      await memory.delete(memoryId, projectId);
      return reply.code(204).send();
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  });

  app.post(
    '/api/projects/:projectId/memories/extract',
    { schema: { body: extractBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { kind: 'generation_run' | 'testing_run'; runId: string };
      try {
        await requireProject(projectId);
        if (body.kind === 'generation_run' && generation === undefined) {
          return reply.code(503).send({
            error: { code: 'MEMORY_INVALID_CANDIDATE', message: 'Generation engine unavailable.' },
          });
        }
        if (body.kind === 'testing_run' && testing === undefined) {
          return reply.code(503).send({
            error: { code: 'MEMORY_INVALID_CANDIDATE', message: 'Testing engine unavailable.' },
          });
        }
        const extracted =
          body.kind === 'generation_run'
            ? candidatesFromGenerationRun(getGenerationRun(generation!, body.runId))
            : candidatesFromTestingRun(getTestingRun(testing!, body.runId));

        // Authorization: a run that belongs to another project never
        // leaks facts into this project's memory namespace.
        for (const candidate of extracted) {
          if (candidate.input.projectId !== projectId) {
            return reply.code(404).send({
              error: {
                code: 'MEMORY_INVALID_CANDIDATE',
                message: 'Run does not belong to this project.',
              },
            });
          }
        }
        const stored = [];
        for (const candidate of extracted) {
          // Extraction products are ALWAYS candidates - never active memory.
          stored.push(toMemoryResponse(await memory.createCandidate(candidate.input)));
        }
        return reply.send({ candidates: stored, stored: stored.length });
      } catch (error) {
        if (isGenerationError(error) || isTestingError(error)) {
          // Unknown run ids surface as typed engine errors -> honest 404.
          return reply.code(404).send({
            error: { code: error.code, message: error.message },
          });
        }
        if (error instanceof Error && error.message === 'RUN_NOT_COMPLETED') {
          return reply.code(409).send({
            error: {
              code: 'MEMORY_INVALID_CANDIDATE',
              message: 'Only completed runs can be extracted into memory candidates.',
            },
          });
        }
        const { status, body } = toHttpError(error);
        return reply.code(status).send(body);
      }
    },
  );
}
