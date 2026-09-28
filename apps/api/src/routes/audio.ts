import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import {
  AudioIntelligenceError,
  isAudioIntelligenceError,
  type AudioAnalysis,
  type AudioArtifactKind,
  type AudioIntelligenceManager,
  type AudioProcessingJob,
  type AudioSummary,
  type AudioTranslation,
} from '@veltravia/audio-intelligence-core';
import {
  asFileAssetId,
  isFileIntelligenceError,
  FileIntelligenceError,
  type Artifact,
  type FilePrincipal,
  type FileScope,
} from '@veltravia/file-intelligence-core';
import type { ProjectEngine } from '@veltravia/project-core';
import { isProjectError } from '@veltravia/project-core';
import type { MemoryManager, CreateMemoryInput } from '@veltravia/memory-core';

/** Audio routes (Step 20). Every response is a safe normalized view: no
 *  provider credentials, no internal storage paths, no raw audit data.
 *  Transcript content is UNTRUSTED DATA; reasoning output is ai_generated. */

function err(error: unknown) {
  if (isAudioIntelligenceError(error)) {
    const status = STATUS[error.code] ?? 500;
    return { status, body: { error: error.toJSON() } };
  }
  if (isFileIntelligenceError(error)) {
    const map: Record<string, number> = {
      FILE_NOT_FOUND: 404,
      FILE_UNAUTHORIZED: 403,
      FILE_EXPIRED: 410,
      FILE_DELETED: 410,
      FILE_TYPE_REJECTED: 415,
      FILE_INTEGRITY_FAILURE: 409,
      ARTIFACT_NOT_FOUND: 404,
      ARTIFACT_NOT_READY: 409,
      ARTIFACT_INTEGRITY_FAILURE: 409,
      ARTIFACT_EXPIRED: 410,
      FILE_INVALID_TRANSITION: 409,
      FILE_LIMIT_EXCEEDED: 413,
    };
    const code = (error as FileIntelligenceError).code;
    return { status: map[code] ?? 400, body: { error: (error as FileIntelligenceError).toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}
const STATUS: Record<string, number> = {
  AUDIO_INVALID_REQUEST: 400,
  AUDIO_FILE_NOT_FOUND: 404,
  AUDIO_UNAUTHORIZED: 403,
  AUDIO_UNSUPPORTED_FORMAT: 415,
  AUDIO_CAPABILITY_UNSUPPORTED: 422,
  AUDIO_LIMIT_EXCEEDED: 413,
  AUDIO_JOB_NOT_FOUND: 404,
  AUDIO_JOB_TERMINAL: 409,
  AUDIO_PROVIDER_ERROR: 502,
  AUDIO_PROVIDER_TIMEOUT: 504,
  AUDIO_PROCESSING_CANCELLED: 409,
  AUDIO_NOT_PROCESSED: 409,
  AUDIO_INVALID_TRANSITION: 409,
  AUDIO_EXPIRED: 410,
  AUDIO_ARTIFACT_INVALID: 400,
};

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
function principal(request: FastifyRequest): FilePrincipal {
  const ownerRef = readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user';
  if (
    header(request, 'x-veltravia-owner-ref') &&
    header(request, 'x-veltravia-owner-ref') !== ownerRef
  )
    throw new AudioIntelligenceError(
      'AUDIO_UNAUTHORIZED',
      'Client-supplied owner identity is not accepted.',
    );
  const project = header(request, 'x-veltravia-project-id');
  const workspace = header(request, 'x-veltravia-workspace-id');
  return {
    ownerRef,
    ...(project ? { allowedProjectIds: [project] } : {}),
    ...(workspace ? { allowedWorkspaceIds: [workspace] } : {}),
  };
}

function jobView(j: AudioProcessingJob) {
  return {
    id: j.id,
    fileId: j.fileId,
    status: j.status,
    stage: j.stage,
    requestedLanguage: j.requestedLanguage,
    detectedLanguage: j.detectedLanguage,
    projectId: j.projectId,
    workspaceId: j.workspaceId,
    chunks: j.chunks,
    completedChunks: j.completedChunks,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    expiresAt: j.expiresAt,
  };
}

function artifactView(a: Artifact) {
  return {
    id: a.id,
    type: a.type,
    filename: a.metadata.filename,
    mimeType: a.metadata.mimeType,
    size: a.metadata.byteSize,
    checksum: a.metadata.checksum,
    status: a.status,
    projectId: a.scope.projectId,
    workspaceId: a.scope.workspaceId,
    sourceOperation: a.sourceOperation,
    provenance: a.provenance,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
}

function segmentViews(
  segments: readonly {
    id: string;
    startSeconds: number | null;
    endSeconds: number | null;
    speaker: string | null;
    confidence: number | null;
    text: string;
  }[],
) {
  return segments.map((s) => ({
    id: s.id,
    startSeconds: s.startSeconds,
    endSeconds: s.endSeconds,
    speaker: s.speaker,
    confidence: s.confidence,
    text: s.text,
  }));
}

function summaryView(s: AudioSummary) {
  return {
    style: s.style,
    text: s.text,
    keyPoints: s.keyPoints,
    attendees: s.attendees,
    unresolvedQuestions: s.unresolvedQuestions,
    followUps: s.followUps,
    providerId: s.providerId,
    trust: s.trust,
  };
}

function analysisView(a: AudioAnalysis) {
  return {
    summary: a.summary ? summaryView(a.summary) : null,
    actionItems: a.actionItems,
    decisions: a.decisions,
    entities: a.entities,
    trust: a.trust,
  };
}

function translationView(t: AudioTranslation) {
  return {
    targetLanguage: t.targetLanguage,
    scope: t.scope,
    segmentId: t.segmentId,
    translatedText: t.translatedText,
    originalPreserved: t.originalPreserved,
    providerId: t.providerId,
    trust: t.trust,
  };
}

export interface AudioRouteOptions {
  readonly memory: MemoryManager;
  readonly projectEngine: ProjectEngine;
}

export function registerAudioRoutes(
  app: FastifyInstance,
  manager: AudioIntelligenceManager,
  options: AudioRouteOptions,
): void {
  /** Declared capability surface - honest, including simulation status. */
  app.get('/api/audio/capabilities', async () => ({
    provider: manager.providerCapabilities(),
    providerIsSimulation: manager.providerIsSimulation,
    limits: manager.limits,
  }));

  app.get('/api/audio/jobs', async (request) =>
    (await manager.listJobs(principal(request))).map(jobView),
  );

  app.get('/api/audio/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return jobView(await manager.getJob(jobId, principal(request)));
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/audio/jobs/:jobId/cancel', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return jobView(await manager.cancelJob(jobId, principal(request)));
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  /** Start processing. Returns 202 with the job; the pipeline runs bounded. */
  app.post('/api/audio/:fileId/process', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const body = (request.body ?? {}) as { language?: unknown };
    const language = typeof body.language === 'string' ? body.language : null;
    try {
      const file = asFileAssetId(fileId);
      const principalRef = principal(request);
      // Snapshot the jobs that already exist for this file so the poll below
      // cannot mistake a previous job for the newly started one.
      const existing = new Set((await manager.listJobs(principalRef, { fileId })).map((j) => j.id));
      const jobPromise = manager.process(file, principalRef, { language });
      jobPromise.catch(() => undefined);
      // 202 + early job snapshot: the bounded pipeline continues in-process.
      // The manager registers the job after its async validation reads the
      // file, so poll briefly for the new record to appear.
      const deadline = Date.now() + 500;
      for (;;) {
        const jobs = await manager.listJobs(principalRef, { fileId });
        const job = jobs.find((j) => !existing.has(j.id));
        if (job) return reply.code(202).send(jobView(job));
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      // No record appeared: either the run already finished (fast provider)
      // or validation rejected the request - awaiting surfaces both honestly.
      return reply.code(202).send(jobView(await jobPromise));
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/audio/:fileId/inspect', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const meta = await manager.inspect(asFileAssetId(fileId), principal(request));
      return {
        fileId: meta.fileId,
        filename: meta.filename,
        mimeType: meta.mimeType,
        format: meta.format,
        size: meta.byteSize,
        checksum: meta.checksum,
        durationSeconds: meta.durationSeconds,
        sampleRateHz: meta.sampleRateHz,
        channels: meta.channels,
        codec: meta.codec,
        createdAt: meta.createdAt,
        projectId: meta.scope.projectId,
        workspaceId: meta.scope.workspaceId,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/audio/:fileId/transcript', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const view = (await manager.getTranscript(asFileAssetId(fileId), principal(request))) as {
        segments: ReturnType<typeof segmentViews>;
        language: string | null;
        languageAutoDetected: boolean;
        providerId: string;
        timestampsAvailable: boolean;
        speakersAvailable: boolean;
        confidence: number | null;
        chunkCount: number;
        text: string;
        trust: string;
      };
      return {
        fileId,
        language: view.language,
        languageAutoDetected: view.languageAutoDetected,
        providerId: view.providerId,
        providerIsSimulation: manager.providerIsSimulation,
        timestampsAvailable: view.timestampsAvailable,
        speakersAvailable: view.speakersAvailable,
        confidence: view.confidence,
        chunkCount: view.chunkCount,
        segments: view.segments,
        text: view.text,
        trust: view.trust,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/audio/:fileId/analysis', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      return analysisView(await manager.analyze(asFileAssetId(fileId), principal(request)));
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post(
    '/api/audio/:fileId/query',
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
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const { question } = request.body as { question: string };
      try {
        const result = await manager.query(asFileAssetId(fileId), principal(request), question);
        return {
          question: result.question,
          answer: result.answer,
          supportingSegments: segmentViews(result.supportingSegments),
          providerId: result.providerId,
          providerIsSimulation: manager.providerIsSimulation,
          trust: result.trust,
        };
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  app.post(
    '/api/audio/:fileId/search',
    {
      schema: {
        body: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const { query } = request.body as { query: string };
      try {
        const result = await manager.search(asFileAssetId(fileId), principal(request), query);
        return {
          query: result.query,
          truncated: result.truncated,
          matches: result.matches.map((m) => ({
            segment: m.segment,
            context: m.context,
          })),
          trust: 'untrusted_data',
        };
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  app.post(
    '/api/audio/:fileId/summarize',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            style: {
              type: 'string',
              enum: ['short', 'detailed', 'meeting', 'executive', 'key_points', 'chronological'],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const { style } = (request.body ?? {}) as { style?: string };
      try {
        const summary = await manager.summarize(
          asFileAssetId(fileId),
          principal(request),
          (
            ['short', 'detailed', 'meeting', 'executive', 'key_points', 'chronological'] as const
          ).includes(style as never)
            ? (style as never)
            : 'short',
        );
        return { ...summaryView(summary), providerIsSimulation: manager.providerIsSimulation };
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  app.post(
    '/api/audio/:fileId/extract',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fields: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const { fields } = (request.body ?? {}) as { fields?: string[] };
      try {
        return analysisView(
          await manager.extract(
            asFileAssetId(fileId),
            principal(request),
            fields && fields.length ? fields : undefined,
          ),
        );
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  app.post(
    '/api/audio/:fileId/translate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['targetLanguage'],
          additionalProperties: false,
          properties: {
            targetLanguage: { type: 'string', minLength: 2, maxLength: 16 },
            scope: { type: 'string', enum: ['transcript', 'segment', 'summary'] },
            segmentId: { type: 'string', maxLength: 64 },
            summaryText: { type: 'string', maxLength: 20000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const body = request.body as {
        targetLanguage: string;
        scope?: string;
        segmentId?: string;
        summaryText?: string;
      };
      try {
        const translation = await manager.translate(asFileAssetId(fileId), principal(request), {
          targetLanguage: body.targetLanguage,
          scope: body.scope === 'segment' || body.scope === 'summary' ? body.scope : 'transcript',
          segmentId: body.segmentId ?? null,
          summaryText: body.summaryText ?? null,
        });
        return {
          ...translationView(translation),
          providerIsSimulation: manager.providerIsSimulation,
        };
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  /** Persist a derived artifact through the Step 19 artifact system. */
  app.post(
    '/api/audio/:fileId/artifacts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: [
                'transcript_txt',
                'transcript_md',
                'transcript_json',
                'summary_md',
                'action_items_json',
                'meeting_notes_md',
                'translation_md',
                'analysis_json',
              ],
            },
            filename: { type: 'string', maxLength: 128 },
            translation: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const body = request.body as {
        kind: AudioArtifactKind;
        filename?: string;
        translation?: AudioTranslation;
      };
      try {
        const artifact = await manager.saveArtifact(asFileAssetId(fileId), principal(request), {
          kind: body.kind,
          filename: body.filename,
          translation: body.translation,
        });
        return reply.code(201).send(artifactView(artifact));
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  /** Audio playback bytes. Authorization + integrity on every request. */
  app.get('/api/audio/:fileId/media', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const audio = await manager
        .mediaBytes(asFileAssetId(fileId), principal(request))
        .catch(() => null);
      if (!audio) {
        const mapped = err(
          new AudioIntelligenceError('AUDIO_FILE_NOT_FOUND', 'Audio file was not found.'),
        );
        return reply.code(mapped.status).send(mapped.body);
      }
      reply.header('Content-Type', audio.mimeType);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'no-store');
      reply.header('Content-Disposition', 'inline');
      return reply.send(audio.bytes);
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  /** Memory candidates from audio analysis - human-approval model (Step 15). */
  app.post(
    '/api/audio/:fileId/memory-candidates',
    {
      schema: {
        body: {
          type: 'object',
          required: ['projectId'],
          additionalProperties: false,
          properties: { projectId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const { projectId } = request.body as { projectId: string };
      try {
        let file: { scope: FileScope };
        try {
          await options.projectEngine.projects.getProject(projectId);
        } catch (error) {
          if (isProjectError(error))
            return reply.code(404).send({ error: { code: error.code, message: error.message } });
          throw error;
        }
        try {
          file = {
            scope: (await manager.inspect(asFileAssetId(fileId), principal(request))).scope,
          };
        } catch (error) {
          const mapped = err(error);
          return reply.code(mapped.status).send(mapped.body);
        }
        if (file.scope.projectId !== projectId)
          return reply.code(400).send({
            error: {
              code: 'AUDIO_INVALID_REQUEST',
              message: 'Audio file is not scoped to this project.',
            },
          });
        const analysis = await manager.analyze(asFileAssetId(fileId), principal(request));
        const inputs: CreateMemoryInput[] = [];
        const provenance = { kind: 'system_derived' as const, referenceId: fileId };
        for (const decision of analysis.decisions.slice(0, 5))
          inputs.push({
            projectId,
            type: 'design_decision',
            title: 'Possible decision (from audio analysis)',
            content: `Audio analysis detected a possible decision: ${decision.statement} (certainty: ${decision.certainty}).`,
            source: provenance,
            confidence: decision.certainty === 'stated' ? 'medium' : 'low',
          });
        for (const action of analysis.actionItems.slice(0, 5))
          inputs.push({
            projectId,
            type: 'requirement',
            title: 'Possible action item (from audio analysis)',
            content: `Audio analysis detected a possible action item: ${action.description}${action.assignedTo ? ` (assigned to ${action.assignedTo})` : ''}${action.deadline ? ` by ${action.deadline}` : ''}.`,
            source: provenance,
            confidence: action.certainty === 'stated' ? 'medium' : 'low',
          });
        const created: { id: string; title: string; status: string }[] = [];
        for (const input of inputs.slice(0, 10)) {
          const candidate = await options.memory.createCandidate(input);
          created.push({ id: candidate.id, title: candidate.title, status: candidate.status });
        }
        return reply.code(201).send({
          created,
          note: 'Candidates carry no authority until a human approves them.',
        });
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
}
