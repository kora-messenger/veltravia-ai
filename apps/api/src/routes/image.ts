import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import {
  ImageIntelligenceError,
  isImageIntelligenceError,
  type ImageArtifactKind,
  type ImageDescription,
  type ImageIntelligenceManager,
  type ImageProcessingJob,
  type OcrResult,
} from '@veltravia/image-intelligence-core';
import {
  asFileAssetId,
  isFileIntelligenceError,
  FileIntelligenceError,
  type FilePrincipal,
} from '@veltravia/file-intelligence-core';

/** Image routes (Step 21). Every response is a safe normalized view: no
 *  provider credentials, no internal storage paths, no raw audit data.
 *  OCR content is UNTRUSTED DATA; reasoning output is ai_generated. */

function err(error: unknown) {
  if (isImageIntelligenceError(error)) {
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
      FILE_INVALID_TRANSITION: 409,
      FILE_LIMIT_EXCEEDED: 413,
    };
    const code = (error as FileIntelligenceError).code;
    return { status: map[code] ?? 400, body: { error: (error as FileIntelligenceError).toJSON() } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}
const STATUS: Record<string, number> = {
  IMAGE_INVALID_REQUEST: 400,
  IMAGE_FILE_NOT_FOUND: 404,
  IMAGE_UNAUTHORIZED: 403,
  IMAGE_UNSUPPORTED_FORMAT: 415,
  IMAGE_CAPABILITY_UNSUPPORTED: 422,
  IMAGE_LIMIT_EXCEEDED: 413,
  IMAGE_JOB_NOT_FOUND: 404,
  IMAGE_JOB_TERMINAL: 409,
  IMAGE_PROVIDER_ERROR: 502,
  IMAGE_PROVIDER_TIMEOUT: 504,
  IMAGE_PROCESSING_CANCELLED: 409,
  IMAGE_NOT_PROCESSED: 409,
  IMAGE_INVALID_TRANSITION: 409,
  IMAGE_EXPIRED: 410,
  IMAGE_ARTIFACT_INVALID: 400,
  IMAGE_UNSAFE_IMAGE: 422,
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
    throw new ImageIntelligenceError(
      'IMAGE_UNAUTHORIZED',
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

function jobView(j: ImageProcessingJob) {
  return {
    id: j.id,
    fileId: j.fileId,
    status: j.status,
    stage: j.stage,
    projectId: j.projectId,
    workspaceId: j.workspaceId,
    operations: j.operations,
    completedOperations: j.completedOperations,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    expiresAt: j.expiresAt,
  };
}

function descriptionView(d: ImageDescription) {
  return {
    summary: d.summary,
    observed: d.observed,
    inferences: d.inferences,
    providerId: d.providerId,
    trust: d.trust,
  };
}

function ocrView(o: OcrResult) {
  return {
    text: o.text,
    regions: o.regions.map((r) => ({
      id: r.id,
      text: r.text,
      readingOrder: r.readingOrder,
      confidence: r.confidence,
    })),
    regionsAvailable: o.regionsAvailable,
    confidenceAvailable: o.confidenceAvailable,
    providerId: o.providerId,
    createdAt: o.createdAt,
    trust: o.trust,
  };
}

export function registerImageRoutes(app: FastifyInstance, manager: ImageIntelligenceManager): void {
  /** Declared capability surface - honest, including simulation status. */
  app.get('/api/image/capabilities', async () => {
    const caps = manager.capabilities();
    return {
      providers: caps.providers,
      providerIsSimulation: manager.providerIsSimulation,
      operations: caps.operations,
      limits: caps.limits,
    };
  });

  app.get('/api/image/jobs', async (request) =>
    (await manager.listJobs(principal(request))).map(jobView),
  );

  app.get('/api/image/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return jobView(manager.getJob(jobId, principal(request)));
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/image/jobs/:jobId/cancel', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return jobView(manager.cancelJob(jobId, principal(request)));
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  /** Start processing. Returns 202 with the job; the pipeline runs bounded. */
  app.post('/api/image/:fileId/process', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const file = asFileAssetId(fileId);
      const principalRef = principal(request);
      // Snapshot existing jobs for this file so the poll below cannot mistake
      // a previous job for the newly started one.
      const existing = new Set(
        (await manager.listJobs(principalRef))
          .filter((j) => String(j.fileId) === fileId)
          .map((j) => j.id),
      );
      const jobPromise = manager.process(file, principalRef);
      jobPromise.catch(() => undefined);
      const deadline = Date.now() + 500;
      for (;;) {
        const jobs = (await manager.listJobs(principalRef)).filter(
          (j) => String(j.fileId) === fileId,
        );
        const job = jobs.find((j) => !existing.has(j.id));
        if (job) return reply.code(202).send(jobView(job));
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      return reply.code(202).send(jobView(await jobPromise));
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/image/:fileId/inspect', async (request, reply) => {
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
        width: meta.width,
        height: meta.height,
        colorInfo: meta.colorInfo,
        animated: meta.animated,
        frameCount: meta.frameCount,
        createdAt: meta.createdAt,
        projectId: meta.scope.projectId,
        workspaceId: meta.scope.workspaceId,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  /** Stored description + OCR. OCR text is UNTRUSTED DATA, labeled as such. */
  app.get('/api/image/:fileId/analysis', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const analysis = await manager.analysis(asFileAssetId(fileId), principal(request));
      return {
        description: analysis.description ? descriptionView(analysis.description) : null,
        ocr: analysis.ocr ? ocrView(analysis.ocr) : null,
        jobId: analysis.jobId,
        providerIsSimulation: manager.providerIsSimulation,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post(
    '/api/image/:fileId/query',
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
        const result = await manager.query(asFileAssetId(fileId), question, principal(request));
        return {
          question: result.question,
          answer: result.answer,
          insufficientEvidence: result.insufficientEvidence,
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

  /** Screenshot issue findings. ai_generated; region refs are manager-owned. */
  app.post('/api/image/:fileId/screenshot', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const analysis = await manager.screenshot(asFileAssetId(fileId), principal(request));
      return {
        issues: analysis.issues.map((i) => ({
          id: i.id,
          kind: i.kind,
          statement: i.statement,
          basis: i.basis,
          regionId: i.regionId,
        })),
        providerId: analysis.providerId,
        providerIsSimulation: manager.providerIsSimulation,
        trust: analysis.trust,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  /** Inferred UI structure. A visual interpretation, not the original DOM. */
  app.post('/api/image/:fileId/ui-structure', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const structure = await manager.uiStructure(asFileAssetId(fileId), principal(request));
      return {
        elements: structure.elements.map((e) => ({
          id: e.id,
          kind: e.kind,
          label: e.label,
          regionId: e.regionId,
        })),
        notes: structure.notes,
        providerId: structure.providerId,
        providerIsSimulation: manager.providerIsSimulation,
        trust: structure.trust,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/image/:fileId/chart', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const chart = await manager.chart(asFileAssetId(fileId), principal(request));
      return {
        chartType: chart.chartType,
        title: chart.title,
        observed: chart.observed,
        inferences: chart.inferences,
        values: chart.values,
        providerId: chart.providerId,
        providerIsSimulation: manager.providerIsSimulation,
        trust: chart.trust,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/image/:fileId/diagram', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const diagram = await manager.diagram(asFileAssetId(fileId), principal(request));
      return {
        nodes: diagram.nodes,
        relationships: diagram.relationships,
        providerId: diagram.providerId,
        providerIsSimulation: manager.providerIsSimulation,
        trust: diagram.trust,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post(
    '/api/image/:fileId/extract',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fields: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const { fields } = (request.body ?? {}) as { fields?: string[] };
      try {
        const extraction = await manager.extract(
          asFileAssetId(fileId),
          fields && fields.length ? fields : [],
          principal(request),
        );
        return {
          fields: extraction.fields,
          providerId: extraction.providerId,
          providerIsSimulation: manager.providerIsSimulation,
          trust: extraction.trust,
        };
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  app.post(
    '/api/image/:fileId/compare',
    {
      schema: {
        body: {
          type: 'object',
          required: ['otherFileId'],
          additionalProperties: false,
          properties: { otherFileId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const { otherFileId } = request.body as { otherFileId: string };
      try {
        const result = await manager.compare(
          asFileAssetId(fileId),
          asFileAssetId(otherFileId),
          principal(request),
        );
        return {
          fileAId: result.fileAId,
          fileBId: result.fileBId,
          summary: result.summary,
          differences: result.differences,
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

  /** Search within one image's stored (untrusted) text. */
  app.get('/api/image/:fileId/search', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const q = (request.query as { q?: string }).q ?? '';
    try {
      const result = await manager.searchImage(asFileAssetId(fileId), q, principal(request));
      return {
        query: result.query,
        truncated: result.truncated,
        matches: result.matches,
        trust: result.trust,
      };
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  /** Search across the principal's processed images (bounded). */
  app.post(
    '/api/image/search',
    {
      schema: {
        body: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 500 },
            projectId: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { query, projectId } = request.body as { query: string; projectId?: string };
      try {
        const result = await manager.searchImages(query, principal(request), {
          projectId: projectId ?? undefined,
        });
        return {
          query: result.query,
          truncated: result.truncated,
          matches: result.matches,
          trust: result.trust,
        };
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  /** Persist a derived artifact through the Step 19 file system. */
  app.post(
    '/api/image/:fileId/artifact',
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
                'image_analysis_json',
                'image_description_md',
                'ocr_txt',
                'screenshot_analysis_md',
                'ui_structure_json',
                'image_comparison_json',
                'chart_analysis_json',
                'diagram_analysis_json',
              ] as const satisfies readonly ImageArtifactKind[],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const { kind } = request.body as { kind: ImageArtifactKind };
      try {
        const view = await manager.saveArtifact(asFileAssetId(fileId), principal(request), {
          kind,
        });
        return reply.code(201).send(view);
      } catch (error) {
        const mapped = err(error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );

  /** Image bytes for display. Authorization + integrity on every request. */
  app.get('/api/image/:fileId/media', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    try {
      const image = await manager
        .mediaBytes(asFileAssetId(fileId), principal(request))
        .catch(() => null);
      if (!image) {
        const mapped = err(
          new ImageIntelligenceError('IMAGE_FILE_NOT_FOUND', 'Image file was not found.'),
        );
        return reply.code(mapped.status).send(mapped.body);
      }
      reply.header('Content-Type', image.mimeType);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'no-store');
      reply.header('Content-Disposition', 'inline');
      return reply.send(image.bytes);
    } catch (error) {
      const mapped = err(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });
}
