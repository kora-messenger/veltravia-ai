import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  isCodebaseError,
  type CodebaseIntelligenceManager,
  type CodeSearchType,
  type StructuralQueryKind,
} from '@veltravia/codebase-core';
import { extractCandidatesFromCodebaseAnalysis, type MemoryManager } from '@veltravia/memory-core';
import { isProjectError, ProjectError, type ProjectEngine } from '@veltravia/project-core';
import { toCodebaseIndexResponse } from '../codebase-service.js';

/**
 * Codebase intelligence routes (Step 16).
 *
 * Surface: index build/status, bounded search (exact/symbol/file/
 * relationship/structural), file + symbol views, feature tracing, the
 * evidence-derived summary, cancellation, and explicit candidate
 * extraction into project memory (from a COMPLETED index only).
 *
 * Boundaries:
 * - every route is scoped to :projectId; the project must exist (404) and
 *   the workspace must belong to it (400) - exactly like the agent context
 * - responses are SAFE VIEWS: paths, symbols, ranges, and evidence only.
 *   Raw source content is never returned by these routes - the existing
 *   Project Engine file routes remain the only content pathway
 * - index data is UNTRUSTED PROJECT DATA: it can never act as an
 *   instruction, and nothing here ever executes project code
 * - analysis is read-only: no route mutates project files
 */

const CODEBASE_ERROR_STATUS: Record<string, number> = {
  CODEBASE_INVALID_REQUEST: 400,
  CODEBASE_PROJECT_NOT_FOUND: 404,
  CODEBASE_WORKSPACE_NOT_FOUND: 404,
  CODEBASE_WORKSPACE_MISMATCH: 400,
  CODEBASE_INDEX_NOT_FOUND: 404,
  CODEBASE_INDEX_STALE: 409,
  CODEBASE_INDEX_BUILD_IN_PROGRESS: 409,
  CODEBASE_INDEX_BUILD_FAILED: 500,
  CODEBASE_CANCELLED: 409,
  CODEBASE_LIMIT_EXCEEDED: 422,
  CODEBASE_SYMBOL_NOT_FOUND: 404,
  CODEBASE_FILE_NOT_FOUND: 404,
  CODEBASE_SOURCE_READ_FAILED: 500,
  CODEBASE_PARSE_ERROR: 500,
};

function toHttpError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isCodebaseError(error)) {
    const status = CODEBASE_ERROR_STATUS[error.code] ?? 500;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (isProjectError(error)) {
    const status =
      error.code === 'PROJECT_NOT_FOUND' ? 404 : error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400;
    return { status, body: { error: error.toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

export interface CodebaseRoutesOptions {
  readonly codebase: CodebaseIntelligenceManager;
  readonly projectEngine: ProjectEngine;
  readonly memory: MemoryManager;
}

const workspaceBodySchema = {
  type: 'object',
  required: ['workspaceId'],
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
};

const buildBodySchema = {
  type: 'object',
  required: ['workspaceId'],
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    incremental: { type: 'boolean' },
  },
};

const searchBodySchema = {
  type: 'object',
  required: ['workspaceId', 'query', 'searchType'],
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    query: { type: 'string', minLength: 0, maxLength: 200 },
    searchType: {
      type: 'string',
      enum: ['exact', 'symbol', 'file', 'relationship', 'structural'],
    },
    structuralKind: { type: 'string', enum: ['routes', 'entry_points', 'components', 'exports'] },
    symbolKind: { type: 'string' },
    filePattern: { type: 'string', maxLength: 200 },
    maxResults: { type: 'integer', minimum: 1, maximum: 50 },
    includeRelationships: { type: 'boolean' },
  },
};

const traceBodySchema = {
  type: 'object',
  required: ['workspaceId', 'feature'],
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    feature: { type: 'string', minLength: 2, maxLength: 200 },
    maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
  },
};

export function registerCodebaseRoutes(app: FastifyInstance, options: CodebaseRoutesOptions): void {
  const { codebase, projectEngine, memory } = options;

  const requireProject = async (projectId: string): Promise<void> => {
    await projectEngine.projects.getProject(projectId);
  };

  /** Workspace must exist AND belong to the project (agent-context parity). */
  const requireWorkspace = async (projectId: string, workspaceId: string): Promise<void> => {
    await requireProject(projectId);
    const workspace = await projectEngine.workspaces.getWorkspace(workspaceId);
    if (workspace.projectId !== projectId) {
      throw new ProjectError(
        'PROJECT_INVALID_REQUEST',
        'This workspace does not belong to the given project.',
      );
    }
  };

  const handle = async (reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await work();
    } catch (error) {
      const { status, body } = toHttpError(error);
      return reply.code(status).send(body);
    }
  };

  app.get('/api/projects/:projectId/codebase/index', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const query = request.query as { workspaceId?: string };
    if (query.workspaceId === undefined) {
      return reply.code(400).send({
        error: {
          code: 'CODEBASE_INVALID_REQUEST',
          message: 'workspaceId query parameter is required',
        },
      });
    }
    return handle(reply, async () => {
      await requireWorkspace(projectId, query.workspaceId as string);
      const index = await codebase.getIndex(projectId, query.workspaceId as string);
      return reply.send({ index: toCodebaseIndexResponse(index) });
    });
  });

  app.post(
    '/api/projects/:projectId/codebase/index',
    { schema: { body: buildBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { workspaceId: string; incremental?: boolean };
      return handle(reply, async () => {
        await requireWorkspace(projectId, body.workspaceId);
        const result = await codebase.buildIndex(projectId, body.workspaceId, {
          incremental: body.incremental ?? true,
        });
        return reply.send({
          index: toCodebaseIndexResponse(result.index),
          incremental: result.incremental,
          changedFiles: result.changedFiles,
        });
      });
    },
  );

  app.post(
    '/api/projects/:projectId/codebase/cancel',
    { schema: { body: workspaceBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { workspaceId: string };
      return handle(reply, async () => {
        await requireWorkspace(projectId, body.workspaceId);
        const cancelled = await codebase.cancelBuild(projectId, body.workspaceId);
        return reply.send({ cancelled });
      });
    },
  );

  app.post(
    '/api/projects/:projectId/codebase/search',
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as {
        workspaceId: string;
        query: string;
        searchType: CodeSearchType;
        structuralKind?: StructuralQueryKind;
        symbolKind?: string;
        filePattern?: string;
        maxResults?: number;
        includeRelationships?: boolean;
      };
      return handle(reply, async () => {
        await requireWorkspace(projectId, body.workspaceId);
        const results = await codebase.search(projectId, body.workspaceId, {
          query: body.query,
          searchType: body.searchType,
          ...(body.structuralKind !== undefined ? { structuralKind: body.structuralKind } : {}),
          ...(body.symbolKind !== undefined ? { symbolKind: body.symbolKind as 'function' } : {}),
          ...(body.filePattern !== undefined ? { filePattern: body.filePattern } : {}),
          ...(body.maxResults !== undefined ? { maxResults: body.maxResults } : {}),
          ...(body.includeRelationships !== undefined
            ? { includeRelationships: body.includeRelationships }
            : {}),
        });
        return reply.send({ results });
      });
    },
  );

  app.get('/api/projects/:projectId/codebase/summary', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const query = request.query as { workspaceId?: string };
    if (query.workspaceId === undefined) {
      return reply.code(400).send({
        error: {
          code: 'CODEBASE_INVALID_REQUEST',
          message: 'workspaceId query parameter is required',
        },
      });
    }
    return handle(reply, async () => {
      await requireWorkspace(projectId, query.workspaceId as string);
      return reply.send({
        summary: await codebase.getSummary(projectId, query.workspaceId as string),
      });
    });
  });

  app.post(
    '/api/projects/:projectId/codebase/trace',
    { schema: { body: traceBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { workspaceId: string; feature: string; maxDepth?: number };
      return handle(reply, async () => {
        await requireWorkspace(projectId, body.workspaceId);
        const trace = await codebase.traceFeature(projectId, body.workspaceId, {
          feature: body.feature,
          ...(body.maxDepth !== undefined ? { maxDepth: body.maxDepth } : {}),
        });
        return reply.send({ trace });
      });
    },
  );

  app.get('/api/projects/:projectId/codebase/files/*', async (request, reply) => {
    const { projectId } = request.params as { projectId: string; '*': string };
    const path = (request.params as { '*': string })['*'];
    const query = request.query as { workspaceId?: string };
    if (query.workspaceId === undefined) {
      return reply.code(400).send({
        error: {
          code: 'CODEBASE_INVALID_REQUEST',
          message: 'workspaceId query parameter is required',
        },
      });
    }
    return handle(reply, async () => {
      await requireWorkspace(projectId, query.workspaceId as string);
      const entry = await codebase.getFileEntry(projectId, query.workspaceId as string, path);
      const symbols = await codebase.getFileSymbols(projectId, query.workspaceId as string, path);
      // Safe view: file metadata + bounded symbols. NEVER the content.
      return reply.send({
        file: {
          path: entry.path,
          language: entry.language,
          size: entry.size,
          revision: entry.revision,
          parseStatus: entry.parseStatus,
          ...(entry.parseNote !== undefined ? { parseNote: entry.parseNote } : {}),
          flaggedSecrets: entry.flaggedSecrets,
          indexedAt: entry.indexedAt,
        },
        symbols: symbols.slice(0, 100),
      });
    });
  });

  app.get('/api/projects/:projectId/codebase/symbols/:symbolId', async (request, reply) => {
    const { projectId, symbolId } = request.params as { projectId: string; symbolId: string };
    const query = request.query as { workspaceId?: string };
    if (query.workspaceId === undefined) {
      return reply.code(400).send({
        error: {
          code: 'CODEBASE_INVALID_REQUEST',
          message: 'workspaceId query parameter is required',
        },
      });
    }
    return handle(reply, async () => {
      await requireWorkspace(projectId, query.workspaceId as string);
      const workspaceId = query.workspaceId as string;
      const symbol = await codebase.getSymbol(projectId, workspaceId, symbolId);
      const relationships = await codebase.getSymbolRelationships(projectId, workspaceId, symbolId);
      const callers = await codebase.findCallers(projectId, workspaceId, symbolId);
      const callees = await codebase.findCallees(projectId, workspaceId, symbolId);
      return reply.send({
        symbol,
        relationships: relationships.slice(0, 50),
        callers: callers.slice(0, 20),
        callees: callees.slice(0, 20),
      });
    });
  });

  app.post(
    '/api/projects/:projectId/codebase/memory-candidates',
    { schema: { body: workspaceBodySchema } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { workspaceId: string };
      return handle(reply, async () => {
        await requireWorkspace(projectId, body.workspaceId);
        const index = await codebase.getIndex(projectId, body.workspaceId);
        if (index.buildState !== 'completed') {
          return reply.code(409).send({
            error: {
              code: 'CODEBASE_INDEX_BUILD_FAILED',
              message: 'memory candidates can only be extracted from a completed index',
            },
          });
        }
        const inputs = extractCandidatesFromCodebaseAnalysis({
          indexId: index.indexId,
          projectId,
          workspaceId: body.workspaceId,
          languages: index.languages,
          frameworks: index.frameworks.map((framework) => ({
            id: framework.id,
            name: framework.name,
          })),
          entryPointPaths: index.entryPoints.map((entry) => entry.filePath),
          testFilePaths: index.files
            .filter(
              (file) =>
                file.path.includes('.test.') ||
                file.path.includes('.spec.') ||
                file.path.includes('__tests__'),
            )
            .map((file) => file.path),
          routeCount: index.routes.length,
          componentCount: index.components.length,
          flaggedSecretFileCount: index.files.filter((file) => file.flaggedSecrets).length,
        });
        const created = [];
        for (const input of inputs) {
          created.push(await memory.createCandidate(input));
        }
        return reply.code(201).send({ candidates: created.length, memories: created });
      });
    },
  );
}
