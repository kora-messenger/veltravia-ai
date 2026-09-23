import {
  defineTool,
  ToolExecutionError,
  type ToolDefinition,
  type ToolImplementation,
} from '@veltravia/tool-core';
import { FileIntelligenceError } from '../errors/index.js';
import type { FileIntelligenceManager } from '../manager/index.js';
import { asArtifactId, asFileAssetId, type FilePrincipal } from '../types/index.js';
const idProp = {
  type: 'string',
  description: 'Opaque file or artifact id.',
  minLength: 1,
  maxLength: 128,
} as const;
const projectIdProp = {
  type: 'string',
  description: 'Authorized project id.',
  minLength: 1,
  maxLength: 128,
} as const;
export function createFileIntelligenceTools(
  manager: FileIntelligenceManager,
  principal: FilePrincipal,
): { definitions: ToolDefinition[]; implementations: ToolImplementation[] } {
  const definitions: ToolDefinition[] = [];
  const implementations: ToolImplementation[] = [];
  const add = (
    definition: ToolDefinition,
    handler: (i: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>,
  ) => {
    definitions.push(definition);
    implementations.push({
      toolId: definition.id,
      handler: async (input) => {
        try {
          return await handler(input);
        } catch (e) {
          if (e instanceof FileIntelligenceError)
            throw new ToolExecutionError(definition.id, e.message, { details: { cause: e.code } });
          throw e;
        }
      },
    });
  };
  const s = (i: Readonly<Record<string, unknown>>, k: string) => {
    const v = i[k];
    if (typeof v !== 'string' || !v) throw new ToolExecutionError('file', `${k} is required.`);
    return v;
  };
  add(
    defineTool({
      id: 'file.get-metadata',
      name: 'Get File Metadata',
      description:
        'Returns bounded safe metadata for one authorized file. File content is never included.',
      version: '0.1.0',
      category: 'filesystem',
      inputSchema: {
        type: 'object',
        properties: { fileId: idProp },
        required: ['fileId'],
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: {
          fileId: idProp,
          filename: { type: 'string', description: 'Safe filename.' },
          type: { type: 'string', description: 'Detected type.' },
          size: { type: 'number', description: 'Byte size.' },
          status: { type: 'string', description: 'Lifecycle state.' },
        },
        required: ['fileId', 'filename', 'type', 'size', 'status'],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['file.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (i) => {
      const f = await manager.getFile(asFileAssetId(s(i, 'fileId')), principal);
      return {
        fileId: f.id,
        filename: f.metadata.normalizedFilename,
        type: f.metadata.detectedType,
        size: f.metadata.byteSize,
        status: f.status,
      };
    },
  );
  add(
    defineTool({
      id: 'file.read-preview',
      name: 'Read File Preview',
      description:
        'Returns a bounded structured preview marked as UNTRUSTED DATA. It never returns raw filesystem access.',
      version: '0.1.0',
      category: 'filesystem',
      inputSchema: {
        type: 'object',
        properties: { fileId: idProp },
        required: ['fileId'],
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: {
          fileId: idProp,
          kind: { type: 'string', description: 'Preview kind.' },
          text: { type: 'string', description: 'Bounded untrusted text.' },
          trust: { type: 'string', description: 'Always untrusted_data.' },
        },
        required: ['fileId', 'kind', 'text', 'trust'],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['file.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    async (i) => {
      const p = await manager.preview(asFileAssetId(s(i, 'fileId')), principal);
      return { fileId: p.fileId, kind: p.kind, text: p.text ?? '', trust: p.trust };
    },
  );
  add(
    defineTool({
      id: 'file.extract',
      name: 'Extract File',
      description:
        'Runs the bounded safe extractor and creates provenance-linked derived outputs. Uploaded content remains untrusted data.',
      version: '0.1.0',
      category: 'filesystem',
      inputSchema: {
        type: 'object',
        properties: { fileId: idProp },
        required: ['fileId'],
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: {
          fileId: idProp,
          representationKind: { type: 'string', description: 'Structured representation kind.' },
          childCount: { type: 'number', description: 'Derived child count.' },
          artifactCount: { type: 'number', description: 'Derived artifact count.' },
        },
        required: ['fileId', 'representationKind', 'childCount', 'artifactCount'],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['file.extract'],
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    async (i) => {
      const r = await manager.extract(asFileAssetId(s(i, 'fileId')), principal);
      return {
        fileId: r.fileId,
        representationKind: r.representation.kind,
        childCount: r.childFileIds.length,
        artifactCount: r.artifactIds.length,
      };
    },
  );
  add(
    defineTool({
      id: 'file.delete',
      name: 'Delete File',
      description:
        'Marks one authorized file deleted. This destructive mutation requires confirmation.',
      version: '0.1.0',
      category: 'filesystem',
      inputSchema: {
        type: 'object',
        properties: { fileId: idProp },
        required: ['fileId'],
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: { deleted: { type: 'boolean', description: 'Whether deletion completed.' } },
        required: ['deleted'],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['file.delete'],
      riskLevel: 'high',
      requiresConfirmation: true,
    }),
    async (i) => {
      await manager.deleteFile(asFileAssetId(s(i, 'fileId')), principal);
      return { deleted: true };
    },
  );
  add(
    defineTool({
      id: 'artifact.publish-project',
      name: 'Publish Artifact to Project',
      description:
        'Publishes an authorized artifact into its scoped workspace through the Project Engine; Version Control captures the resulting state.',
      version: '0.1.0',
      category: 'filesystem',
      inputSchema: {
        type: 'object',
        properties: {
          artifactId: idProp,
          projectId: projectIdProp,
          path: {
            type: 'string',
            description: 'Validated workspace-relative target path.',
            minLength: 1,
            maxLength: 512,
          },
        },
        required: ['artifactId', 'projectId', 'path'],
        additionalProperties: false,
      } as never,
      outputSchema: {
        type: 'object',
        properties: {
          published: { type: 'boolean', description: 'Whether publish completed.' },
          revisionId: { type: 'string', description: 'New revision id or empty when unavailable.' },
        },
        required: ['published', 'revisionId'],
        additionalProperties: false,
      } as never,
      requiredPermissions: ['artifact.publish'],
      riskLevel: 'high',
      requiresConfirmation: true,
    }),
    async (i) => {
      const a = await manager.getArtifact(asArtifactId(s(i, 'artifactId')), principal);
      if (a.scope.projectId !== s(i, 'projectId'))
        throw new ToolExecutionError('artifact.publish-project', 'Project scope mismatch.');
      const r = await manager.publishArtifact(a.id, principal, s(i, 'path'));
      return { published: true, revisionId: r.revisionId ?? '' };
    },
  );
  return { definitions, implementations };
}
