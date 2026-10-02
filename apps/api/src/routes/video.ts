import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import {
  VideoIntelligenceError,
  isVideoIntelligenceError,
  VIDEO_ERROR_STATUS,
  type VideoIntelligenceManager,
  type VideoProcessingJob,
  type FrameRequestOptions,
  type VideoSummaryMode,
  type VideoArtifactKind,
} from '@veltravia/video-intelligence-core';
import { asFileAssetId, type FilePrincipal } from '@veltravia/file-intelligence-core';
function principal(r: FastifyRequest): FilePrincipal {
  const ownerRef = readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
  if (r.headers['x-veltravia-owner-ref'] && r.headers['x-veltravia-owner-ref'] !== ownerRef)
    throw new VideoIntelligenceError('VIDEO_UNAUTHORIZED');
  const p = r.headers['x-veltravia-project-id'],
    w = r.headers['x-veltravia-workspace-id'];
  return {
    ownerRef,
    ...(typeof p === 'string' ? { allowedProjectIds: [p] } : {}),
    ...(typeof w === 'string' ? { allowedWorkspaceIds: [w] } : {}),
  };
}
function jobView(j: VideoProcessingJob) {
  const { ownerRef: _owner, ...v } = j;
  void _owner;
  return v;
}
export function registerVideoRoutes(app: FastifyInstance, m: VideoIntelligenceManager): void {
  const file = (r: FastifyRequest) => asFileAssetId((r.params as { fileId: string }).fileId),
    body = (r: FastifyRequest) => (r.body ?? {}) as Record<string, unknown>;
  const schema = (properties: object, required: string[] = []) => ({
    body: { type: 'object', properties, required, additionalProperties: false },
  });
  const route = (
    method: 'GET' | 'POST',
    url: string,
    action: (r: FastifyRequest) => Promise<unknown> | unknown,
    s?: object,
  ) =>
    app.route({
      method,
      url,
      ...(s ? { schema: s } : {}),
      handler: async (r, reply) => {
        try {
          return await action(r);
        } catch (e) {
          return isVideoIntelligenceError(e)
            ? reply.code(VIDEO_ERROR_STATUS[e.code] ?? 500).send({ error: e.toJSON() })
            : reply
                .code(500)
                .send({ error: { code: 'INTERNAL', message: 'Video request failed.' } });
        }
      },
    });
  route('GET', '/api/video/capabilities', () => ({
    ...m.capabilities(),
    providerIsSimulation: m.providerIsSimulation,
  }));
  route('GET', '/api/video/jobs', (r) => m.listJobs(principal(r)).map(jobView));
  route('GET', '/api/video/jobs/:jobId', (r) =>
    jobView(m.getJob((r.params as { jobId: string }).jobId, principal(r))),
  );
  route('POST', '/api/video/jobs/:jobId/cancel', (r) =>
    jobView(m.cancelJob((r.params as { jobId: string }).jobId, principal(r))),
  );
  route('GET', '/api/video/:fileId/inspect', async (r) => {
    const { scope, ...v } = await m.inspect(file(r), principal(r));
    return { ...v, size: v.byteSize, projectId: scope.projectId, workspaceId: scope.workspaceId };
  });
  route('GET', '/api/video/:fileId/analysis', async (r) => ({
    ...(await m.analysis(file(r), principal(r))),
    providerIsSimulation: m.providerIsSimulation,
  }));
  app.post('/api/video/:fileId/process', async (r, reply) => {
    try {
      const p = principal(r),
        f = file(r),
        existing = new Set(m.listJobs(p).map((j) => j.id));
      let failure: unknown;
      const pending = m.process(f, p);
      pending.catch((e) => {
        failure = e;
      });
      for (let n = 0; n < 100; n++) {
        if (failure) throw failure;
        const j = m.listJobs(p).find((j) => j.fileId === f && !existing.has(j.id));
        if (j) return reply.code(202).send(jobView(j));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return reply.code(202).send(jobView(await pending));
    } catch (e) {
      return isVideoIntelligenceError(e)
        ? reply.code(VIDEO_ERROR_STATUS[e.code] ?? 500).send({ error: e.toJSON() })
        : reply
            .code(500)
            .send({ error: { code: 'INTERNAL', message: 'Video processing failed.' } });
    }
  });
  route(
    'POST',
    '/api/video/:fileId/frames',
    (r) => m.frames(file(r), body(r) as FrameRequestOptions, principal(r)),
    schema({
      strategy: {
        type: 'string',
        enum: ['first', 'last', 'timestamp', 'even', 'scene', 'keyframe'],
      },
      count: { type: 'integer', minimum: 1, maximum: 64 },
      atSeconds: { type: 'number', minimum: 0 },
      timestamps: { type: 'array', items: { type: 'number', minimum: 0 }, maxItems: 64 },
    }),
  );
  for (const op of ['scenes', 'transcript', 'ocr', 'timeline'] as const)
    route('POST', `/api/video/:fileId/${op}`, (r) => m[op](file(r), principal(r)), schema({}));
  route(
    'POST',
    '/api/video/:fileId/ask',
    (r) => m.ask(file(r), body(r).question as string, principal(r)),
    schema({ question: { type: 'string', minLength: 1, maxLength: 2000 } }, ['question']),
  );
  route(
    'POST',
    '/api/video/:fileId/summarize',
    (r) => m.summarize(file(r), (body(r).mode ?? 'general') as VideoSummaryMode, principal(r)),
    schema({
      mode: { type: 'string', enum: ['general', 'timeline', 'meeting', 'tutorial', 'bug_report'] },
    }),
  );
  route(
    'POST',
    '/api/video/:fileId/extract',
    (r) => m.extract(file(r), (body(r).fields ?? []) as string[], principal(r)),
    schema({ fields: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 20 } }),
  );
  route(
    'POST',
    '/api/video/:fileId/translate',
    (r) => m.translate(file(r), body(r).language as string, principal(r)),
    schema({ language: { type: 'string', minLength: 2, maxLength: 20 } }, ['language']),
  );
  route(
    'POST',
    '/api/video/:fileId/compare',
    (r) => m.compare(file(r), asFileAssetId(body(r).otherFileId as string), principal(r)),
    schema({ otherFileId: { type: 'string', minLength: 1, maxLength: 128 } }, ['otherFileId']),
  );
  route(
    'POST',
    '/api/video/:fileId/artifact',
    (r) => m.saveArtifact(file(r), principal(r), { kind: body(r).kind as VideoArtifactKind }),
    schema(
      {
        kind: {
          type: 'string',
          enum: [
            'video_metadata_json',
            'transcript_txt',
            'transcript_json',
            'video_summary_md',
            'timeline_md',
            'timeline_json',
            'scene_analysis_json',
            'ocr_json',
            'meeting_notes_md',
            'action_items_json',
            'translated_transcript_md',
            'video_comparison_json',
            'bug_analysis_md',
          ],
        },
      },
      ['kind'],
    ),
  );
  route(
    'POST',
    '/api/video/search',
    (r) => m.searchVideos(body(r).query as string, principal(r)),
    schema({ query: { type: 'string', minLength: 1, maxLength: 500 } }, ['query']),
  );
  route(
    'POST',
    '/api/video/:fileId/search',
    (r) => m.searchVideo(file(r), body(r).query as string, principal(r)),
    schema({ query: { type: 'string', minLength: 1, maxLength: 500 } }, ['query']),
  );
  app.get('/api/video/:fileId/media', async (r, reply) => {
    try {
      const v = await m.mediaBytes(file(r), principal(r));
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .type(v.mimeType)
        .send(Buffer.from(v.bytes));
    } catch (e) {
      return isVideoIntelligenceError(e)
        ? reply.code(VIDEO_ERROR_STATUS[e.code] ?? 500).send({ error: e.toJSON() })
        : reply.code(500).send({ error: { code: 'INTERNAL', message: 'Video unavailable.' } });
    }
  });
}
