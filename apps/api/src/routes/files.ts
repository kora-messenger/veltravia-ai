import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import {
  asArtifactId,
  asFileAssetId,
  FileIntelligenceError,
  isFileIntelligenceError,
  type Artifact,
  type FileAsset,
  type FileIntelligenceManager,
  type FilePrincipal,
} from '@veltravia/file-intelligence-core';

const STATUS: Record<string, number> = {
  FILE_INVALID_REQUEST: 400,
  FILE_TOO_LARGE: 413,
  FILE_TYPE_REJECTED: 415,
  FILE_PATH_UNSAFE: 400,
  FILE_ARCHIVE_REJECTED: 422,
  FILE_EXTRACTION_FAILED: 422,
  FILE_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  FILE_UNAUTHORIZED: 403,
  FILE_EXPIRED: 410,
  FILE_DELETED: 410,
  ARTIFACT_EXPIRED: 410,
  ARTIFACT_NOT_READY: 409,
  ARTIFACT_INTEGRITY_FAILURE: 409,
  FILE_INTEGRITY_FAILURE: 409,
  FILE_INVALID_TRANSITION: 409,
  FILE_LIMIT_EXCEEDED: 413,
};
function err(error: unknown) {
  if (isFileIntelligenceError(error))
    return { status: STATUS[error.code] ?? 500, body: { error: error.toJSON() } };
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'unexpected failure' } } };
}
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
    throw new FileIntelligenceError(
      'FILE_UNAUTHORIZED',
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
function scopeFrom(body: Record<string, unknown>, request: FastifyRequest) {
  return {
    ownerRef: principal(request).ownerRef,
    projectId: typeof body.projectId === 'string' ? body.projectId : null,
    workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : null,
  };
}
function fileView(f: FileAsset) {
  return {
    id: f.id,
    filename: f.metadata.normalizedFilename,
    mimeType: f.metadata.detectedMimeType,
    declaredMimeType: f.metadata.declaredMimeType,
    detectedType: f.metadata.detectedType,
    category: f.metadata.category,
    size: f.metadata.byteSize,
    checksum: f.metadata.checksum,
    extensionMismatch: f.metadata.extensionMismatch,
    mimeMismatch: f.metadata.mimeMismatch,
    encoding: f.metadata.encoding,
    lineCount: f.metadata.lineCount,
    language: f.metadata.language,
    width: f.metadata.width,
    height: f.metadata.height,
    durationSeconds: f.metadata.durationSeconds,
    source: f.source,
    status: f.status,
    projectId: f.scope.projectId,
    workspaceId: f.scope.workspaceId,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    expiresAt: f.expiresAt,
    parentFileId: f.parentFileId,
    parentArtifactId: f.parentArtifactId,
    sourceOperation: f.sourceOperation,
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
    updatedAt: a.updatedAt,
    expiresAt: a.expiresAt,
  };
}
const uploadJsonSchema = {
  type: 'object',
  required: ['filename', 'contentBase64', 'source'],
  additionalProperties: false,
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: 1024 },
    contentBase64: { type: 'string', minLength: 0 },
    mimeType: { type: 'string', maxLength: 256 },
    source: {
      type: 'string',
      enum: [
        'user_upload',
        'generated_artifact',
        'project_file',
        'connected_app_reference',
        'imported_archive',
        'derived_extraction',
      ],
    },
    projectId: { type: ['string', 'null'] },
    workspaceId: { type: ['string', 'null'] },
    expiresAt: { type: ['string', 'null'] },
  },
};
export function registerFileRoutes(app: FastifyInstance, manager: FileIntelligenceManager): void {
  app.post(
    '/api/files',
    { bodyLimit: 36 * 1024 * 1024, schema: { body: uploadJsonSchema } },
    async (request, reply) => {
      try {
        const b = request.body as Record<string, unknown>;
        if (b.source !== 'user_upload')
          throw new FileIntelligenceError(
            'FILE_INVALID_REQUEST',
            'This endpoint accepts user uploads only.',
          );
        if (String(b.contentBase64).length > 34 * 1024 * 1024)
          throw new FileIntelligenceError('FILE_TOO_LARGE', 'File exceeds the upload limit.');
        let bytes: Buffer;
        try {
          bytes = Buffer.from(String(b.contentBase64), 'base64');
          if (
            bytes.toString('base64').replace(/=+$/, '') !==
            String(b.contentBase64).replace(/=+$/, '')
          )
            throw new Error();
        } catch {
          throw new FileIntelligenceError(
            'FILE_INVALID_REQUEST',
            'contentBase64 must be valid base64.',
          );
        }
        const file = await manager.registerFile({
          filename: String(b.filename),
          declaredMimeType: typeof b.mimeType === 'string' ? b.mimeType : undefined,
          bytes,
          source: b.source as never,
          scope: scopeFrom(b, request),
          expiresAt: typeof b.expiresAt === 'string' ? b.expiresAt : null,
        });
        return reply.code(201).send(fileView(file));
      } catch (e) {
        const x = err(e);
        return reply.code(x.status).send(x.body);
      }
    },
  );
  app.get('/api/files', async (request, reply) => {
    try {
      const q = request.query as Record<string, unknown>;
      const files = await manager.listFiles(principal(request), {
        projectId: typeof q.projectId === 'string' ? q.projectId : undefined,
        workspaceId: typeof q.workspaceId === 'string' ? q.workspaceId : undefined,
        type: typeof q.type === 'string' ? q.type : undefined,
        status: typeof q.status === 'string' ? q.status : undefined,
        search: typeof q.search === 'string' ? q.search : undefined,
      });
      return reply.send({ files: files.map(fileView) });
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.get('/api/files/:fileId', async (request, reply) => {
    try {
      const { fileId } = request.params as { fileId: string };
      return reply.send(fileView(await manager.getFile(asFileAssetId(fileId), principal(request))));
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.get('/api/files/:fileId/preview', async (request, reply) => {
    try {
      const { fileId } = request.params as { fileId: string };
      return reply.send(await manager.preview(asFileAssetId(fileId), principal(request)));
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.get('/api/files/:fileId/image', async (request, reply) => {
    try {
      const { fileId } = request.params as { fileId: string };
      const image = await manager.imageBytes(asFileAssetId(fileId), principal(request));
      return reply
        .header('content-type', image.mimeType)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(image.bytes));
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.post('/api/files/:fileId/extract', async (request, reply) => {
    try {
      const { fileId } = request.params as { fileId: string };
      return reply.send(await manager.extract(asFileAssetId(fileId), principal(request)));
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.get('/api/files/:fileId/children', async (request, reply) => {
    try {
      const { fileId } = request.params as { fileId: string };
      return reply.send({
        files: (await manager.getChildren(asFileAssetId(fileId), principal(request))).map(fileView),
      });
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.delete('/api/files/:fileId', async (request, reply) => {
    try {
      const { fileId } = request.params as { fileId: string };
      await manager.deleteFile(asFileAssetId(fileId), principal(request));
      return reply.code(204).send();
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.get('/api/artifacts', async (request, reply) => {
    try {
      const q = request.query as Record<string, unknown>;
      const a = await manager.listArtifacts(principal(request), {
        projectId: typeof q.projectId === 'string' ? q.projectId : undefined,
        workspaceId: typeof q.workspaceId === 'string' ? q.workspaceId : undefined,
        search: typeof q.search === 'string' ? q.search : undefined,
      });
      return reply.send({ artifacts: a.map(artifactView) });
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.get('/api/artifacts/:artifactId', async (request, reply) => {
    try {
      const { artifactId } = request.params as { artifactId: string };
      return reply.send(
        artifactView(await manager.getArtifact(asArtifactId(artifactId), principal(request))),
      );
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.get('/api/artifacts/:artifactId/preview', async (request, reply) => {
    try {
      const { artifactId } = request.params as { artifactId: string };
      return reply.send(
        await manager.artifactPreview(asArtifactId(artifactId), principal(request)),
      );
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.get('/api/artifacts/:artifactId/download', async (request, reply) => {
    try {
      const { artifactId } = request.params as { artifactId: string };
      const q = request.query as { token?: string };
      if (!q.token) {
        const ref = await manager.createDownloadReference(
          asArtifactId(artifactId),
          principal(request),
        );
        return reply.send({
          downloadUrl: `/api/artifacts/${artifactId}/download?token=${encodeURIComponent(ref.token)}`,
          expiresAt: ref.expiresAt,
        });
      }
      const out = await manager.resolveDownload(
        asArtifactId(artifactId),
        q.token,
        principal(request),
      );
      return reply
        .header('content-type', out.artifact.metadata.mimeType)
        .header('content-disposition', `attachment; filename="${out.filename}"`)
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(out.bytes));
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.delete('/api/artifacts/:artifactId', async (request, reply) => {
    try {
      const { artifactId } = request.params as { artifactId: string };
      await manager.deleteArtifact(asArtifactId(artifactId), principal(request));
      return reply.code(204).send();
    } catch (e) {
      const x = err(e);
      return reply.code(x.status).send(x.body);
    }
  });
  app.post(
    '/api/artifacts/:artifactId/publish',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: { path: { type: 'string', minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (request, reply) => {
      try {
        const { artifactId } = request.params as { artifactId: string };
        const { path } = request.body as { path: string };
        return reply.send(
          await manager.publishArtifact(asArtifactId(artifactId), principal(request), path),
        );
      } catch (e) {
        const x = err(e);
        return reply.code(x.status).send(x.body);
      }
    },
  );
}
