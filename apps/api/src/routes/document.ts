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

export interface DocumentRouteDeps {
  /**
   * Step 26: returns the OWNER'S gateway-backed managerFor(request). Requests opt in with
   * `provider: 'gateway'` (body or `?provider=gateway`); the flag is part of the
   * request so a caller never silently reasons on someone else's key, and job
   * reads pass the same flag to find the job in the right stack.
   */
  readonly gatewayManagerFor?: (ownerRef: string) => DocumentIntelligenceManager;
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  manager: DocumentIntelligenceManager,
  deps: DocumentRouteDeps = {},
): void {
  /** Resolves the manager for THIS request only. */
  const managerFor = (request: FastifyRequest): DocumentIntelligenceManager => {
    const wantsGateway =
      (request.body as { provider?: unknown } | undefined)?.provider === 'gateway' ||
      (request.query as { provider?: unknown } | undefined)?.provider === 'gateway';
    if (!wantsGateway || !deps.gatewayManagerFor) return manager;
    try {
      return deps.gatewayManagerFor(principal(request).ownerRef);
    } catch (error) {
      // A MISSING encryption key or provider is a configuration outcome, not a
      // crash: report it through the document error envelope.
      throw new DocumentIntelligenceError(
        'DOCUMENT_PROVIDER_ERROR',
        error instanceof Error ? error.message : 'The gateway document provider is unavailable.',
      );
    }
  };
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
    gatewayAvailable: Boolean(deps.gatewayManagerFor),
    capabilities: manager.capabilities(),
    artifactKinds: [...DOCUMENT_ARTIFACT_KINDS],
    summaryModes: [...SUMMARY_MODES],
  }));

  app.get('/api/documents/jobs', async (request, reply) =>
    run(reply, () =>
      managerFor(request)
        .listJobs(principal(request))
        .then((jobs) => jobs.map(jobView)),
    ),
  );

  app.get('/api/documents/jobs/:jobId', async (request, reply) =>
    run(reply, () =>
      managerFor(request)
        .getJob((request.params as { jobId: string }).jobId, principal(request))
        .then(jobView),
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
    run(reply, () => managerFor(request).inspect(file(request), principal(request))),
  );

  // Processing is bounded and completes inline. A job that failed is reported
  // with the failure's own HTTP status, so a client can never read a rejected
  // document as a success.
  app.post('/api/documents/:fileId/process', async (request, reply) => {
    try {
      const job = await managerFor(request).process(file(request), principal(request));
      if (job.status === 'failed' && job.error) {
        return reply
          .code(STATUS[job.error.code] ?? 500)
          .send({ error: { code: job.error.code, message: job.error.message }, job: jobView(job) });
      }
      return reply.code(200).send(jobView(job));
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/documents/:fileId/structure', async (request, reply) =>
    run(reply, () => managerFor(request).getStructure(file(request), principal(request))),
  );

  app.post('/api/documents/:fileId/search', async (request, reply) =>
    run(reply, () => {
      const query = boundedString(body(request).query, 500).trim();
      if (!query)
        throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'A query is required.');
      return managerFor(request).searchExact(file(request), query, principal(request));
    }),
  );

  app.post('/api/documents/:fileId/semantic-search', async (request, reply) =>
    run(reply, () => {
      const query = boundedString(body(request).query, 500).trim();
      if (!query)
        throw new DocumentIntelligenceError('DOCUMENT_INVALID_REQUEST', 'A query is required.');
      return managerFor(request).semanticSearch(file(request), query, principal(request));
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
        managerFor(request).ask(
          file(request),
          boundedString(body(request).question, 2000),
          principal(request),
        ),
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
      return managerFor(request).summarize(file(request), mode, principal(request));
    }),
  );

  app.get('/api/documents/:fileId/entities', async (request, reply) =>
    run(reply, () => managerFor(request).extractEntities(file(request), principal(request))),
  );

  app.post('/api/documents/:fileId/compare', async (request, reply) =>
    run(reply, () => {
      const other = boundedString(body(request).otherFileId, 200);
      if (!other)
        throw new DocumentIntelligenceError(
          'DOCUMENT_INVALID_REQUEST',
          'A second document id is required.',
        );
      return managerFor(request).compare(file(request), asFileAssetId(other), principal(request));
    }),
  );

  app.post('/api/documents/:fileId/ocr', async (request, reply) =>
    run(reply, () => managerFor(request).ocr(file(request), principal(request))),
  );

  app.get('/api/documents/:fileId/spreadsheet', async (request, reply) =>
    run(reply, () => managerFor(request).spreadsheetView(file(request), principal(request))),
  );

  app.get('/api/documents/:fileId/presentation', async (request, reply) =>
    run(reply, () => managerFor(request).presentationView(file(request), principal(request))),
  );

  app.get('/api/documents/:fileId/memory-candidates', async (request, reply) =>
    run(reply, () => managerFor(request).memoryCandidates(file(request), principal(request))),
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
        return managerFor(request).saveArtifact(file(request), principal(request), {
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
