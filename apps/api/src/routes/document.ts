import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import {
  DocumentIntelligenceError,
  isDocumentIntelligenceError,
  DOCUMENT_ARTIFACT_KINDS,
  type DocumentIntelligenceManager,
  type DocumentProcessingJob,
  type DocumentSummaryMode,
} from '@veltravia/document-intelligence-core';
import {
  asFileAssetId,
  isFileIntelligenceError,
  FileIntelligenceError,
  type FilePrincipal,
} from '@veltravia/file-intelligence-core';

/** Document routes (Step 23). Every response is a safe normalized view: no
 *  provider credentials, no storage paths, no raw audit data. Extracted text
 *  and tables are UNTRUSTED DATA; reasoning output is ai_generated. */

const STATUS: Record<string, number> = {
  DOCUMENT_INVALID_REQUEST: 400,
  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_FORBIDDEN: 403,
  DOCUMENT_UNSUPPORTED_FORMAT: 415,
  DOCUMENT_NOT_PROCESSED: 409,
  DOCUMENT_JOB_NOT_FOUND: 404,
  DOCUMENT_LIMIT_EXCEEDED: 413,
  DOCUMENT_PROVIDER_ERROR: 502,
  DOCUMENT_FILE_ERROR: 502,
  DOCUMENT_SECRET_REJECTED: 400,
};

function err(error: unknown): { status: number; body: unknown } {
  if (isDocumentIntelligenceError(error)) {
    return {
      status: STATUS[error.code] ?? 500,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  if (isFileIntelligenceError(error)) {
    const map: Record<string, number> = {
      FILE_NOT_FOUND: 404,
      FILE_UNAUTHORIZED: 403,
      FILE_EXPIRED: 410,
      FILE_DELETED: 410,
      FILE_TYPE_REJECTED: 415,
      FILE_INTEGRITY_FAILURE: 409,
      FILE_INVALID_TRANSITION: 409,
      FILE_LIMIT_EXCEEDED: 413,
    };
    const code = (error as FileIntelligenceError).code;
    return { status: map[code] ?? 400, body: { error: (error as FileIntelligenceError).toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}

function principal(request: FastifyRequest): FilePrincipal {
  const ownerRef = readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
  const header = request.headers['x-veltravia-owner-ref'];
  if (header && header !== ownerRef) throw new DocumentIntelligenceError('DOCUMENT_FORBIDDEN');
  const projectId = request.headers['x-veltravia-project-id'];
  const workspaceId = request.headers['x-veltravia-workspace-id'];
  return {
    ownerRef,
    ...(typeof projectId === 'string' ? { allowedProjectIds: [projectId] } : {}),
    ...(typeof workspaceId === 'string' ? { allowedWorkspaceIds: [workspaceId] } : {}),
  };
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

const SUMMARY_MODES: readonly DocumentSummaryMode[] = ['brief', 'bullets', 'executive'];

export function registerDocumentRoutes(
  app: FastifyInstance,
  manager: DocumentIntelligenceManager,
): void {
  const file = (r: FastifyRequest) => asFileAssetId((r.params as { fileId: string }).fileId);
  const body = (r: FastifyRequest) => (r.body ?? {}) as Record<string, unknown>;
  const jobView = (job: DocumentProcessingJob) => ({ ...job });

  const run = async (
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    action: () => Promise<unknown>,
    status = 200,
  ): Promise<unknown> => {
    try {
      const value = await action();
      return reply.code(status).send(value);
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  };

  app.get('/api/documents/capabilities', async () => ({
    providerIsSimulation: manager.providerIsSimulation,
    capabilities: manager.capabilities(),
    artifactKinds: [...DOCUMENT_ARTIFACT_KINDS],
    summaryModes: [...SUMMARY_MODES],
  }));

  app.get('/api/documents/jobs', async (request, reply) =>
    run(reply, () => manager.listJobs(principal(request)).then((jobs) => jobs.map(jobView))),
  );

  app.get('/api/documents/jobs/:jobId', async (request, reply) =>
    run(reply, () =>
      manager.getJob((request.params as { jobId: string }).jobId, principal(request)).then(jobView),
    ),
  );

  app.post('/api/documents/jobs/:jobId/cancel', async (request, reply) =>
    run(reply, () =>
      manager
        .cancelJob((request.params as { jobId: string }).jobId, principal(request))
        .then(jobView),
    ),
  );

  app.get('/api/documents/:fileId/inspect', async (request, reply) =>
    run(reply, () => manager.inspect(file(request), principal(request))),
  );

  // Processing is bounded and completes inline; the terminal job is returned.
  app.post('/api/documents/:fileId/process', async (request, reply) =>
    run(reply, () => manager.process(file(request), principal(request)).then(jobView)),
  );

  app.get('/api/documents/:fileId/structure', async (request, reply) =>
    run(reply, () => manager.getStructure(file(request), principal(request))),
  );

  app.post('/api/documents/:fileId/search', async (request, reply) =>
    run(reply, () => {
      const query = boundedString(body(request).query, 500).trim();
      if (!query)
        throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'A query is required.');
      return manager.searchExact(file(request), query, principal(request));
    }),
  );

  app.post('/api/documents/:fileId/semantic-search', async (request, reply) =>
    run(reply, () => {
      const query = boundedString(body(request).query, 500).trim();
      if (!query)
        throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'A query is required.');
      return manager.semanticSearch(file(request), query, principal(request));
    }),
  );

  app.post(
    '/api/documents/:fileId/ask',
    {
      schema: {
        body: {
          type: 'object',
          required: ['question'],
          additionalProperties: false,
          properties: { question: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) =>
      run(reply, () =>
        manager.ask(file(request), boundedString(body(request).question, 2000), principal(request)),
      ),
  );

  app.post('/api/documents/:fileId/summary', async (request, reply) =>
    run(reply, () => {
      const mode = String(body(request).mode ?? 'brief') as DocumentSummaryMode;
      if (!SUMMARY_MODES.includes(mode))
        throw new DocumentIntelligenceError(
          'DOCUMENT_INVALID_REQUEST',
          'Summary mode must be brief, bullets or executive.',
        );
      return manager.summarize(file(request), mode, principal(request));
    }),
  );

  app.get('/api/documents/:fileId/entities', async (request, reply) =>
    run(reply, () => manager.extractEntities(file(request), principal(request))),
  );

  app.post('/api/documents/:fileId/compare', async (request, reply) =>
    run(reply, () => {
      const other = boundedString(body(request).otherFileId, 200);
      if (!other)
        throw new DocumentIntelligenceError(
          'DOCUMENT_INVALID_REQUEST',
          'A second document id is required.',
        );
      return manager.compare(file(request), asFileAssetId(other), principal(request));
    }),
  );

  app.post('/api/documents/:fileId/ocr', async (request, reply) =>
    run(reply, () => manager.ocr(file(request), principal(request))),
  );

  app.get('/api/documents/:fileId/spreadsheet', async (request, reply) =>
    run(reply, () => manager.spreadsheetView(file(request), principal(request))),
  );

  app.get('/api/documents/:fileId/presentation', async (request, reply) =>
    run(reply, () => manager.presentationView(file(request), principal(request))),
  );

  app.get('/api/documents/:fileId/memory-candidates', async (request, reply) =>
    run(reply, () => manager.memoryCandidates(file(request), principal(request))),
  );

  /** Publish a derived export through the Step 19 file system. */
  app.post('/api/documents/:fileId/artifact', async (request, reply) =>
    run(
      reply,
      () => {
        const payload = body(request);
        const kind = String(payload.kind ?? '');
        if (!(DOCUMENT_ARTIFACT_KINDS as readonly string[]).includes(kind))
          throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'Unknown artifact kind.');
        const mode = typeof payload.mode === 'string' ? payload.mode : undefined;
        if (mode !== undefined && !SUMMARY_MODES.includes(mode as DocumentSummaryMode))
          throw new DocumentIntelligenceError(
            'DOCUMENT_INVALID_REQUEST',
            'Summary mode must be brief, bullets or executive.',
          );
        return manager.saveArtifact(file(request), principal(request), {
          kind: kind as (typeof DOCUMENT_ARTIFACT_KINDS)[number],
          ...(mode ? { mode: mode as DocumentSummaryMode } : {}),
          ...(typeof payload.query === 'string' ? { query: payload.query.slice(0, 500) } : {}),
          ...(typeof payload.otherFileId === 'string'
            ? { otherFileId: asFileAssetId(payload.otherFileId.slice(0, 200)) }
            : {}),
        });
      },
      201,
    ),
  );
}
