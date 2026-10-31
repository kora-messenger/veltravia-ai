import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  invalidRequest,
  isIntelligenceError,
  isSourceProvider,
  isSourceType,
  type SourceProvider,
  type SourceType,
} from '@veltravia/intelligence-core';
import { readEnv } from '@veltravia/config';
import type { IntelligenceService } from '../intelligence-service.js';

/** Cross-source intelligence routes (Step 25).
 *
 * Owner-scoped and read-only with respect to the outside world: nothing here
 * writes to an uploaded file, a connected app or a project. Responses are safe
 * views; retrieved text is only ever returned as untrusted evidence with a
 * source reference, and the reasoning mode is always stated. */

const STATUS: Record<string, number> = {
  INTELLIGENCE_INVALID_REQUEST: 400,
  INTELLIGENCE_SOURCE_NOT_FOUND: 404,
  INTELLIGENCE_SOURCE_FORBIDDEN: 403,
  INTELLIGENCE_LIMIT_EXCEEDED: 413,
  INTELLIGENCE_TIMEOUT: 504,
  INTELLIGENCE_CANCELLED: 409,
  INTELLIGENCE_SECRET_REJECTED: 400,
  INTELLIGENCE_PROVIDER_UNAVAILABLE: 503,
  INTELLIGENCE_PROVIDER_ERROR: 502,
  INTELLIGENCE_JOB_NOT_FOUND: 404,
  INTELLIGENCE_JOB_STATE: 409,
};

function toError(error: unknown): { status: number; body: unknown } {
  if (isIntelligenceError(error))
    return {
      status: STATUS[error.code] ?? 500,
      body: { error: { code: error.code, message: error.message } },
    };
  return {
    status: 500,
    body: { error: { code: 'INTELLIGENCE_INTERNAL', message: 'Unexpected failure.' } },
  };
}

/**
 * Ownership: the demo build derives the owner from a header instead of real
 * authentication. The header is a stand-in for an authenticated identity, never
 * a credential - a real deployment reads the owner from the session and ignores
 * anything the client sends. `x-veltravia-owner-ref` is the convention the other
 * owner-scoped steps use, so intelligence sees exactly what documents, media and
 * files see; `x-veltravia-owner` remains accepted for compatibility.
 */
function ownerOf(request: FastifyRequest): { ownerRef: string } {
  const preferHeader = request.headers['x-veltravia-owner-ref'];
  const fallbackHeader = request.headers['x-veltravia-owner'];
  const raw =
    (Array.isArray(preferHeader) ? preferHeader[0] : preferHeader) ??
    (Array.isArray(fallbackHeader) ? fallbackHeader[0] : fallbackHeader);
  if (typeof raw === 'string' && raw.length > 0) return { ownerRef: raw.slice(0, 256) };
  return { ownerRef: readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user' };
}

interface QueryShape {
  q?: string;
  provider?: string;
  sourceType?: string;
  projectId?: string;
  workspaceId?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  limit?: string;
  cursor?: string;
}

function parseProviders(value: unknown): readonly SourceProvider[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const providers: SourceProvider[] = [];
  for (const entry of raw) {
    const cleaned = String(entry).trim();
    if (cleaned.length === 0) continue;
    if (!isSourceProvider(cleaned)) throw invalidRequest(`Unknown provider: ${cleaned}.`);
    providers.push(cleaned);
  }
  return providers.length > 0 ? providers : undefined;
}

function parseSourceTypes(value: unknown): readonly SourceType[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const types: SourceType[] = [];
  for (const entry of raw) {
    const cleaned = String(entry).trim();
    if (cleaned.length === 0) continue;
    if (!isSourceType(cleaned)) throw invalidRequest(`Unknown source type: ${cleaned}.`);
    types.push(cleaned);
  }
  return types.length > 0 ? types : undefined;
}

export function registerIntelligenceRoutes(
  app: FastifyInstance,
  service: IntelligenceService,
): void {
  app.get('/api/intelligence/capabilities', async () => ({
    reasoning: {
      mode: service.reasoningMode,
      simulated: service.reasoningSimulated,
      detail: service.engine.reasoning.detail,
    },
    limits: service.registry.limits,
  }));

  app.get('/api/intelligence/sources', async (request, reply) => {
    try {
      const query = request.query as QueryShape;
      const sources = await service.registry.discover(ownerOf(request), {
        providers: parseProviders(query.provider),
        sourceTypes: parseSourceTypes(query.sourceType),
        projectId: query.projectId ?? null,
        workspaceId: query.workspaceId ?? null,
        text: query.q ?? null,
        limit: query.limit ? Math.min(Number(query.limit) || 50, 200) : 50,
      });
      const availability = await service.registry.availability(ownerOf(request));
      return {
        sources: sources.map((source) => ({
          sourceId: source.sourceId,
          provider: source.provider,
          providerName: source.providerName,
          sourceType: source.sourceType,
          name: source.name,
          mimeType: source.mimeType,
          byteSize: source.byteSize,
          projectId: source.projectId,
          workspaceId: source.workspaceId,
          contentVersion: source.contentVersion,
          retrievedAt: source.retrievedAt,
          modifiedAt: source.modifiedAt,
          sourceUrl: source.sourceUrl,
          permissions: source.permissions,
          freshness: source.freshness,
          trustTag: source.trustTag,
        })),
        providers: availability,
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/intelligence/search', async (request, reply) => {
    try {
      const query = request.query as QueryShape;
      const response = await service.engine.search(ownerOf(request), {
        text: query.q ?? '',
        providers: parseProviders(query.provider),
        sourceTypes: parseSourceTypes(query.sourceType),
        projectId: query.projectId ?? null,
        workspaceId: query.workspaceId ?? null,
        modifiedAfter: query.modifiedAfter ?? null,
        modifiedBefore: query.modifiedBefore ?? null,
        limit: query.limit ? Math.min(Number(query.limit) || 10, 50) : 10,
        cursor: query.cursor ?? null,
      });
      return {
        totalMatched: response.totalMatched,
        duplicatesRemoved: response.duplicatesRemoved,
        sourcesScanned: response.sourcesScanned,
        nextCursor: response.nextCursor,
        truncated: response.truncated,
        searchedProviders: response.searchedProviders,
        unavailableProviders: response.unavailableProviders,
        hits: response.hits.map((hit) => ({
          source: {
            sourceId: hit.source.sourceId,
            provider: hit.source.provider,
            providerName: hit.source.providerName,
            sourceType: hit.source.sourceType,
            name: hit.source.name,
            projectId: hit.source.projectId,
            contentVersion: hit.source.contentVersion,
            retrievedAt: hit.source.retrievedAt,
            modifiedAt: hit.source.modifiedAt,
            sourceUrl: hit.source.sourceUrl,
            freshness: hit.source.freshness,
            trustTag: hit.source.trustTag,
          },
          score: hit.score,
          matchedTerms: hit.matchedTerms,
          snippet: hit.snippet,
          locator: hit.locator,
          reasons: hit.reasons,
        })),
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/intelligence/analyze', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        question?: string;
        provider?: string | string[];
        sourceType?: string | string[];
        projectId?: string;
        workspaceId?: string;
        sourceIds?: string[];
        reasoning?: string;
      };
      // Step 26: the caller may ask for reasoning on their OWN provider. The
      // evidence pipeline (search, re-verification, provenance, contradiction
      // detection) is identical; only the synthesis provider differs, and every
      // answer still carries its disclosure.
      let engine = service.engine;
      if (body.reasoning === 'gateway') {
        if (!service.gatewayEngine) {
          return reply.code(409).send({
            error: {
              code: 'GATEWAY_NO_PROVIDER_CONFIGURED',
              message: 'No AI provider is connected yet, so reasoning cannot run on your account.',
            },
          });
        }
        try {
          engine = await service.gatewayEngine(ownerOf(request).ownerRef, body.projectId);
        } catch (error) {
          const mapped = toError(error);
          return reply.code(mapped.status).send(mapped.body);
        }
      }
      const answer = await engine.synthesize(ownerOf(request), body.question ?? '', {
        providers: parseProviders(body.provider),
        sourceTypes: parseSourceTypes(body.sourceType),
        projectId: body.projectId ?? null,
        workspaceId: body.workspaceId ?? null,
        ...(Array.isArray(body.sourceIds) && body.sourceIds.length > 0
          ? { sourceIds: body.sourceIds.filter((id) => typeof id === 'string').slice(0, 10) }
          : {}),
      });
      return answer;
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/intelligence/compare', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { sourceIds?: string[] };
      const ids = Array.isArray(body.sourceIds)
        ? body.sourceIds.filter((id): id is string => typeof id === 'string')
        : [];
      return await service.engine.compare(ownerOf(request), ids);
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/intelligence/relationships/:sourceId', async (request, reply) => {
    try {
      const { sourceId } = request.params as { sourceId: string };
      const depth = Number((request.query as { depth?: string }).depth ?? '2');
      const answer = await service.engine.synthesize(ownerOf(request), 'related sources', {
        sourceIds: [sourceId],
      });
      return {
        sourceId,
        depth: Math.min(Math.max(depth, 1), 2),
        relationships: answer.relationships,
        sources: answer.sources,
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/intelligence/evidence/:evidenceSourceId', async (request, reply) => {
    try {
      const { evidenceSourceId } = request.params as { evidenceSourceId: string };
      const content = await service.registry.read(ownerOf(request), evidenceSourceId);
      const max = Math.min(Number((request.query as { limit?: string }).limit ?? '4'), 10);
      return {
        source: content.source,
        injectionRisk: content.injectionRisk,
        truncated: content.truncated,
        evidence: content.segments.slice(0, max).map((segment) => ({
          evidenceId: `ev:${content.source.sourceId}:${segment.segmentId}`,
          locator: segment.locator,
          excerpt: segment.text.slice(0, service.registry.limits.maxExcerptChars),
          revision: content.source.contentVersion,
          retrievedAt: content.source.retrievedAt,
          trustTag: content.trustTag,
          verified: true,
        })),
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/intelligence/jobs', async (request) => ({
    jobs: service.jobs.list(ownerOf(request).ownerRef),
  }));

  app.post('/api/intelligence/jobs', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        question?: string;
        provider?: string | string[];
        sourceType?: string | string[];
        projectId?: string;
      };
      const question = (body.question ?? '').trim();
      if (question.length === 0)
        return reply.code(400).send({
          error: { code: 'INTELLIGENCE_INVALID_REQUEST', message: 'A question is required.' },
        });
      const job = await service.jobs.create(ownerOf(request).ownerRef, question, {
        providers: parseProviders(body.provider),
        sourceTypes: parseSourceTypes(body.sourceType),
        projectId: body.projectId ?? null,
      });
      return reply.code(202).send(job);
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/intelligence/jobs/:jobId', async (request, reply) => {
    try {
      const { jobId } = request.params as { jobId: string };
      return service.jobs.get(ownerOf(request).ownerRef, jobId);
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/intelligence/jobs/:jobId/result', async (request, reply) => {
    try {
      const { jobId } = request.params as { jobId: string };
      const job = service.jobs.get(ownerOf(request).ownerRef, jobId);
      if (job.status !== 'completed')
        return reply.code(409).send({
          error: {
            code: 'INTELLIGENCE_JOB_STATE',
            message: `That analysis is ${job.status}.`,
          },
        });
      return job.result;
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/intelligence/jobs/:jobId/cancel', async (request, reply) => {
    try {
      const { jobId } = request.params as { jobId: string };
      return service.jobs.cancel(ownerOf(request).ownerRef, jobId);
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
}
