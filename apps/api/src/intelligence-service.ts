import {
  IntelligenceEngine,
  SourceRegistry,
  SynthesisJobManager,
  createMockReasoningProvider,
  createStructuralSynthesisProvider,
  type RawSource,
  type OwnerScope,
  type SourceAdapter,
  type SourceListOptions,
  type ProviderAvailability,
} from '@veltravia/intelligence-core';
import {
  DEFAULT_DOCUMENT_LIMITS,
  inspectDocumentFormat,
  parseDocument,
} from '@veltravia/document-intelligence-core';
import { asFileAssetId, type FileIntelligenceManager } from '@veltravia/file-intelligence-core';
import { createGatewaySynthesisProvider, type AIProviderGateway } from '@veltravia/ai-gateway';
import type { ConnectedAppManager } from '@veltravia/connected-apps-core';
import type { ProjectEngine } from '@veltravia/project-core';

export interface IntelligenceService {
  readonly registry: SourceRegistry;
  readonly engine: IntelligenceEngine;
  readonly jobs: SynthesisJobManager;
  readonly reasoningMode: string;
  readonly reasoningSimulated: boolean;
  /**
   * Step 26 (BYOK): an engine whose synthesis runs on the OWNER'S provider
   * through the AI gateway. Same registry, same evidence re-verification, same
   * provenance and contradiction rules; only the reasoning provider changes and
   * its disclosure says so. Absent when no gateway is configured.
   */
  readonly gatewayEngine?: (ownerRef: string, projectId?: string) => Promise<IntelligenceEngine>;
}

export interface IntelligenceServiceOptions {
  readonly files: FileIntelligenceManager;
  readonly connected: ConnectedAppManager | null;
  readonly projectEngine: ProjectEngine;
  readonly now?: () => Date;
  /** Step 26 provider gateway; enables owner-keyed reasoning. */
  readonly gateway?: AIProviderGateway;
  readonly onAudit?: (event: {
    readonly type: string;
    readonly ownerRef: string;
    readonly detail: string | null;
    readonly count: number | null;
  }) => void;
}

const TEXT_MIME_PATTERN = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript))/i;

/** Turns document bytes into canonical text with real format detection. Parsing
 *  is genuine (DOCX/XLSX/PPTX/PDF/CSV/MD/HTML/JSON/XML/TXT via Step 23); when a
 *  format is not supported the bytes are decoded as text only if they are text. */
function extractText(bytes: Uint8Array, mimeType: string): string | null {
  const detected = inspectDocumentFormat(bytes);
  if (detected.format !== 'unknown') {
    const structure = parseDocument(detected.format, bytes, 'intelligence-source', {
      maxFileBytes: DEFAULT_DOCUMENT_LIMITS.maxFileBytes,
      maxElements: 2000,
      maxSections: DEFAULT_DOCUMENT_LIMITS.maxSections,
      maxTables: 50,
      maxTableRows: 100,
      maxSheetRows: 200,
      maxSlides: 100,
    });
    const parts: string[] = [];
    for (const element of structure.elements) {
      if (element.type === 'heading') parts.push(`## ${element.text}`);
      else if (element.type === 'paragraph') parts.push(element.text);
    }
    for (const table of structure.tables.slice(0, 10)) {
      if (table.headers.length > 0) parts.push(table.headers.join(' | '));
      for (const row of table.rows.slice(0, 50)) parts.push(row.join(' | '));
    }
    const text = parts.join('\n').trim();
    return text.length > 0 ? text : null;
  }
  if (!TEXT_MIME_PATTERN.test(mimeType)) return null;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return decoded.includes('\u0000') ? null : decoded;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Uploaded documents and text files (Step 19/23). Document text comes from the
 *  real parsers, never from a filename guess. */
function createFilesAdapter(files: FileIntelligenceManager): SourceAdapter {
  return {
    provider: 'files',
    providerName: 'Uploaded files',
    sourceType: 'uploaded_document',
    availability: async (): Promise<ProviderAvailability> => ({
      provider: 'files',
      available: true,
      detail: 'Uploaded files are searched through the document parsers.',
    }),
    list: async (owner: OwnerScope, options: SourceListOptions): Promise<readonly RawSource[]> => {
      const all = await files.listFiles(
        {
          ownerRef: owner.ownerRef,
          ...(owner.allowedProjectIds ? { allowedProjectIds: owner.allowedProjectIds } : {}),
        },
        { projectId: options.projectId ?? undefined },
      );
      return all
        .filter(
          (asset) => asset.metadata.category !== 'image' && asset.metadata.category !== 'archive',
        )
        .slice(0, options.limit)
        .map((asset) => ({
          resourceId: asset.id,
          name: asset.metadata.normalizedFilename,
          sourceType: 'uploaded_document' as const,
          mimeType: asset.metadata.detectedMimeType,
          text: '',
          byteSize: asset.metadata.byteSize,
          projectId: asset.scope.projectId ?? null,
          workspaceId: asset.scope.workspaceId ?? null,
          contentVersion: asset.metadata.checksum,
          modifiedAt: asset.updatedAt,
          permissions: ['files.read'],
        }));
    },
    read: async (owner: OwnerScope, resourceId: string): Promise<RawSource> => {
      const principal = {
        ownerRef: owner.ownerRef,
        ...(owner.allowedProjectIds ? { allowedProjectIds: owner.allowedProjectIds } : {}),
      };
      const fileId = asFileAssetId(resourceId);
      const asset = await files.getFile(fileId, principal);
      const { bytes, mimeType } = await files.documentBytes(fileId, principal);
      const text = extractText(bytes, mimeType);
      if (text === null) throw new Error('That file has no extractable text.');
      return {
        resourceId,
        name: asset.metadata.normalizedFilename,
        sourceType: 'uploaded_document',
        mimeType,
        text,
        byteSize: asset.metadata.byteSize,
        projectId: asset.scope.projectId ?? null,
        workspaceId: asset.scope.workspaceId ?? null,
        contentVersion: asset.metadata.checksum,
        modifiedAt: asset.updatedAt,
        permissions: ['files.read'],
      };
    },
  };
}

/** Connected-app resources (Step 24). One adapter per provider so provider
 *  filters and honest per-provider availability work exactly as they do there. */
function createConnectedAdapter(
  manager: ConnectedAppManager,
  providerId: 'github' | 'google_drive' | 'notion',
  providerName: string,
): SourceAdapter {
  return {
    provider: providerId,
    providerName,
    sourceType: 'connected_resource',
    availability: async (owner: OwnerScope): Promise<ProviderAvailability> => {
      const connection = manager
        .listConnections({ ownerRef: owner.ownerRef })
        .find((entry) => entry.providerId === providerId);
      if (!connection)
        return {
          provider: providerId,
          available: false,
          detail: `${providerName} is not connected.`,
        };
      if (connection.status !== 'connected')
        return {
          provider: providerId,
          available: false,
          detail: `${providerName} is ${connection.status}.`,
        };
      return { provider: providerId, available: true, detail: `${providerName} is connected.` };
    },
    list: async (owner: OwnerScope, options: SourceListOptions): Promise<readonly RawSource[]> => {
      const connected = manager
        .listConnections({ ownerRef: owner.ownerRef })
        .find((entry) => entry.providerId === providerId);
      if (!connected) return [];
      const page = await manager.resources({ ownerRef: owner.ownerRef }, providerId, {
        query: options.text ?? null,
      });
      return page.resources
        .filter((resource) => resource.kind !== 'directory')
        .slice(0, options.limit)
        .map((resource) => ({
          resourceId: resource.resourceId,
          name: resource.name,
          sourceType: 'connected_resource' as const,
          mimeType: resource.mimeType,
          text: '',
          byteSize: resource.byteSize,
          projectId: null,
          workspaceId: null,
          contentVersion: resource.revision ?? resource.resourceId,
          modifiedAt: resource.modifiedAt,
          sourceUrl: resource.url,
          permissions: [...connected.grantedScopes],
        }));
    },
    read: async (owner: OwnerScope, resourceId: string): Promise<RawSource> => {
      const content = await manager.content({ ownerRef: owner.ownerRef }, providerId, resourceId);
      const text = extractText(content.bytes, content.mimeType);
      if (text === null) throw new Error('That resource has no extractable text.');
      return {
        resourceId,
        name: content.resource.name,
        sourceType: 'connected_resource',
        mimeType: content.mimeType,
        text,
        byteSize: content.bytes.byteLength,
        projectId: null,
        workspaceId: null,
        contentVersion: content.provenance.revision ?? content.resource.resourceId,
        modifiedAt: content.resource.modifiedAt,
        sourceUrl: content.resource.url,
        permissions: [],
      };
    },
  };
}

const WORKSPACE_TEXT_EXTENSIONS = new Set([
  'md',
  'txt',
  'json',
  'yml',
  'yaml',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'html',
  'sql',
  'toml',
  'env',
]);

/** Project workspace files (Step 7). Only text-like files are indexed, and the
 *  content is read through the engine so owner checks still apply. */
function createWorkspaceAdapter(engine: ProjectEngine): SourceAdapter {
  return {
    provider: 'workspace',
    providerName: 'Project workspace',
    sourceType: 'project_file',
    availability: async (): Promise<ProviderAvailability> => ({
      provider: 'workspace',
      available: true,
      detail: 'Project workspace files are searchable through the project engine.',
    }),
    list: async (owner: OwnerScope, options: SourceListOptions): Promise<readonly RawSource[]> => {
      const projects = await engine.projects.listProjects({ ownerRef: owner.ownerRef });
      const wanted = options.projectId
        ? projects.filter((project) => project.id === options.projectId)
        : projects;
      const out: RawSource[] = [];
      for (const project of wanted) {
        const workspaces = await engine.workspaces.listWorkspaces(project.id);
        for (const workspace of workspaces) {
          const nodes = await engine.files.listAll(workspace.id);
          for (const node of nodes) {
            if (node.type !== 'file') continue;
            const extension = node.name.split('.').pop()?.toLowerCase() ?? '';
            if (!WORKSPACE_TEXT_EXTENSIONS.has(extension)) continue;
            out.push({
              resourceId: `${workspace.id}/${node.path}`,
              name: node.name,
              sourceType: 'project_file',
              mimeType: extension === 'md' ? 'text/markdown' : 'text/plain',
              text: '',
              byteSize: node.size,
              projectId: project.id,
              workspaceId: workspace.id,
              contentVersion: String(node.revision),
              modifiedAt: node.updatedAt,
              permissions: ['project.read'],
            });
            if (out.length >= options.limit) break;
          }
          if (out.length >= options.limit) break;
        }
        if (out.length >= options.limit) break;
      }
      return out;
    },
    read: async (_owner: OwnerScope, resourceId: string): Promise<RawSource> => {
      const [workspaceId, ...rest] = resourceId.split('/');
      const path = rest.join('/');
      if (!workspaceId || !path) throw new Error('Unknown workspace file.');
      const workspace = await engine.workspaces.getWorkspace(workspaceId);
      const { node, content } = await engine.files.readFile(workspaceId, path);
      return {
        resourceId,
        name: node.name,
        sourceType: 'project_file',
        mimeType: node.name.endsWith('.md') ? 'text/markdown' : 'text/plain',
        text: content,
        byteSize: utf8Bytes(content),
        projectId: workspace.projectId,
        workspaceId,
        contentVersion: String(node.revision),
        modifiedAt: node.updatedAt,
        permissions: ['project.read'],
      };
    },
  };
}

/**
 * Builds the cross-source intelligence service.
 *
 * REASONING MODE (honest limitation, Step 25): no language model is called.
 * Nothing here requires a paid model credential, and CI runs fully offline. The
 * engine can run either provider; both disclose themselves in every answer.
 */
export function createIntelligenceService(
  options: IntelligenceServiceOptions,
): IntelligenceService {
  const registry = new SourceRegistry({
    ...(options.now ? { now: options.now } : {}),
  });
  registry.register(createFilesAdapter(options.files));
  registry.register(createWorkspaceAdapter(options.projectEngine));
  if (options.connected) {
    registry.register(createConnectedAdapter(options.connected, 'github', 'GitHub'));
    registry.register(createConnectedAdapter(options.connected, 'google_drive', 'Google Drive'));
    registry.register(createConnectedAdapter(options.connected, 'notion', 'Notion'));
  }
  const reasoningProviderName = (
    process.env.INTELLIGENCE_REASONING_PROVIDER ?? 'mock'
  ).toLowerCase();
  const reasoning =
    reasoningProviderName === 'structural'
      ? createStructuralSynthesisProvider()
      : createMockReasoningProvider();
  const buildEngine = (provider: typeof reasoning): IntelligenceEngine =>
    new IntelligenceEngine({
      registry,
      reasoning: provider,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onAudit ? { audit: options.onAudit } : {}),
    });
  const engine = buildEngine(reasoning);
  const jobs = new SynthesisJobManager({
    runner: async ({
      ownerRef,
      question,
      filters,
    }: {
      readonly ownerRef: string;
      readonly question: string;
      readonly filters: Record<string, unknown>;
    }) => engine.synthesize({ ownerRef }, question, filters),
    ...(options.now ? { now: options.now } : {}),
  });
  const disclosure = reasoning.disclosure();
  const gateway = options.gateway;
  return {
    registry,
    engine,
    jobs,
    reasoningMode: disclosure.mode,
    reasoningSimulated: disclosure.simulated,
    ...(gateway
      ? {
          gatewayEngine: async (
            ownerRef: string,
            projectId?: string,
          ): Promise<IntelligenceEngine> => {
            const provider = createGatewaySynthesisProvider({
              gateway,
              scope: { ownerRef, ...(projectId ? { projectId } : {}) },
              ...(projectId ? { projectId } : {}),
            });
            return buildEngine(provider as unknown as typeof reasoning);
          },
        }
      : {}),
  };
}
