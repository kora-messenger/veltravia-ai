import {
  createVideoIntelligenceTools,
  type VideoIntelligenceManager,
} from '@veltravia/video-intelligence-core';
import { ConnectorManager, type Connector } from '@veltravia/connector-core';
import type { ConnectorOperationExecutor } from '@veltravia/tool-core';
import { createMockConnector } from '@veltravia/connector-mock';
import type { SandboxManager } from '@veltravia/sandbox-core';
import { ToolManager } from '@veltravia/tool-core';
import { CrossSourceSearch, createIntelligenceTools } from '@veltravia/intelligence-core';
import type { IntelligenceService } from './intelligence-service.js';
import { createCodebaseTools, type CodebaseIntelligenceManager } from '@veltravia/codebase-core';
import { createVersionTools, type VersionControlManager } from '@veltravia/version-core';
import {
  createFileIntelligenceTools,
  type FileIntelligenceManager,
} from '@veltravia/file-intelligence-core';
import {
  createAudioIntelligenceTools,
  type AudioIntelligenceManager,
} from '@veltravia/audio-intelligence-core';
import {
  createImageIntelligenceTools,
  type ImageIntelligenceManager,
} from '@veltravia/image-intelligence-core';
import {
  createDocumentIntelligenceTools,
  type DocumentIntelligenceManager,
} from '@veltravia/document-intelligence-core';
import {
  createConnectorBackedMockTool,
  createMockPurgeTool,
  createMockSummarizeTool,
} from '@veltravia/tool-mock';
import { createSandboxTools } from './sandboxes.js';
import {
  APP_BUILDER_ACTION_TOOL_IDS,
  APP_BUILDER_TOOL_IDS,
  createAppBuilderActionTools,
  createAppBuilderTools,
} from './app-builder-tools.js';
import type { AppBuilderManager } from '@veltravia/app-builder-core';
import type { ProjectEngine } from '@veltravia/project-core';

/**
 * Builds the API's ToolManager.
 *
 * Step 5 registers only the offline mock tools, which exist to prove the
 * Tool System end to end: the executable summarizer and the connector-
 * backed reference tool (authorization-only - external execution is not
 * enabled). Real tools arrive with the future agent layer; each will declare
 * its permissions and route through the same controlled pipeline.
 *
 * Registration grants NOTHING: every registered tool starts with an empty
 * permission set, and the read-only API can neither execute tools nor
 * grant anything.
 */
/** Optional extra wiring for the agent-side Tool System (Step 12). */
export interface ExtraToolWiring {
  /** Connectors to register (operator grants ALL their declared permissions). */
  readonly connectors?: readonly Connector[];
  /** Step 10 connector execution seam (already-authorized tools only). */
  readonly connectorExecutor?: ConnectorOperationExecutor;
}

/**
 * The media tools the AI may call by default. Every one reads or analyses what
 * the owner already uploaded and changes nothing. Tools that create artifacts,
 * start processing (a `*.process` permission, such as image.analyze and
 * audio.transcribe), translate or delete are registered but NOT listed here,
 * so they stay ungranted until an operator enables them.
 */
export const READ_ONLY_DOCUMENT_TOOLS = [
  'document.inspect',
  'document.structure',
  'document.search',
  'document.semantic_search',
  'document.ask',
  'document.summarize',
  'document.entities',
  'document.compare',
  'document.get_job',
] as const;
export const READ_ONLY_IMAGE_TOOLS = [
  'image.inspect',
  'image.search',
  'image.describe',
  'image.ocr',
  'image.ask',
  'image.compare',
  'image.capabilities',
] as const;
export const READ_ONLY_AUDIO_TOOLS = ['audio.inspect', 'audio.search', 'audio.summarize'] as const;
export const READ_ONLY_VIDEO_TOOLS = [
  'video.inspect',
  'video.analyze',
  'video.search',
  'video.ask',
  'video.summarize',
  'video.timeline',
  'video.scenes',
  'video.transcribe',
] as const;

/** The owner used when a caller does not name one (development stand-in for auth). */
export const DEFAULT_OWNER_REF = 'veltravia-dev-user';

export function createToolManager(
  now: () => Date = () => new Date(),
  sandboxes?: SandboxManager,
  /** Existing ConnectorManager to share (e.g. the coding manager's own). */
  existingConnectors?: ConnectorManager,
  extra?: ExtraToolWiring,
  /** Codebase intelligence manager (Step 16): enables the read-only analysis tools. */
  codebase?: CodebaseIntelligenceManager,
  /** Version Control manager (Step 18): enables the version tools. */
  version?: VersionControlManager,
  /** File Intelligence (Step 19): bounded file metadata/extraction tools. */
  files?: FileIntelligenceManager,
  /** Audio Intelligence (Step 20): bounded audio understanding tools. */
  audio?: AudioIntelligenceManager,
  /** Image Intelligence (Step 21): bounded image understanding tools. */
  image?: ImageIntelligenceManager,
  video?: VideoIntelligenceManager,
  /** Cross-source Intelligence (Step 25): read-only search and synthesis tools. */
  intelligence?: IntelligenceService,
  /**
   * Step 27: the owner every owner-scoped tool binds to. Agent and reasoning
   * runs pass the caller's owner ref so one owner can never read another
   * owner's files, documents or intelligence sources through a tool.
   */
  ownerRef: string = DEFAULT_OWNER_REF,
  /** Document Intelligence (Step 23): bounded, read-only document understanding. */
  document?: DocumentIntelligenceManager,
  /** App Builder (Step 30): read-only technology lookup, spec checks and stack detection. */
  appBuilder?: { readonly manager: AppBuilderManager; readonly projects: ProjectEngine },
): ToolManager {
  const connectors = existingConnectors ?? new ConnectorManager({ now });
  if (existingConnectors === undefined) {
    connectors.register(createMockConnector({ now }));
    connectors.configure('mock');
  }

  const manager = new ToolManager({
    now,
    connectors,
    ...(extra?.connectorExecutor !== undefined
      ? { connectorExecutor: extra.connectorExecutor }
      : {}),
  });
  // Step 12: extra connectors (integration-backed). The Tool System's
  // authorization gate checks the ConnectorManager's granted permissions -
  // the API wiring acts as the operator and grants them explicitly, then
  // connects through the real lifecycle. Execution itself routes through
  // the connectorExecutor seam (the integration runtime), never locally.
  if (extra?.connectors !== undefined) {
    for (const connector of extra.connectors) {
      connectors.register(connector);
      for (const permission of connector.permissions) {
        connectors.grantPermission(connector.metadata.id, permission.id);
      }
      void connectors.connect(connector.metadata.id).catch(() => undefined);
    }
  }
  const summarize = createMockSummarizeTool();
  manager.register(summarize.definition);
  manager.registerImplementation(summarize.implementation);
  // The existing critical-risk mock tool (Step 5): its declaration says no
  // confirmation, but the framework must still demand one. Registered so
  // the demo confirmation agent can exercise the forced-confirmation flow.
  const purge = createMockPurgeTool();
  manager.register(purge.definition);
  manager.registerImplementation(purge.implementation);
  manager.register(createConnectorBackedMockTool());

  // Sandbox tools: declared through the same controlled pipeline - schemas,
  // permissions (empty until granted), risk levels, and forced confirmation
  // for sandbox.execute (high risk). Registration grants NOTHING.
  if (sandboxes) {
    const sandboxTools = createSandboxTools(sandboxes);
    for (const definition of sandboxTools.definitions) {
      manager.register(definition);
    }
    for (const implementation of sandboxTools.implementations) {
      manager.registerImplementation(implementation);
    }
  }
  // Step 16: codebase analysis tools - read-only, low-risk, permission-
  // gated (codebase.read). Registration grants NOTHING by itself; grants
  // are explicit below so agents can request analysis evidence. Analysis
  // can never become mutation: no codebase tool writes anything.
  if (codebase !== undefined) {
    const codebaseTools = createCodebaseTools(codebase);
    for (const definition of codebaseTools.definitions) {
      manager.register(definition);
    }
    for (const implementation of codebaseTools.implementations) {
      manager.registerImplementation(implementation);
    }
    for (const definition of codebaseTools.definitions) {
      manager.grantPermission(definition.id, 'codebase.read');
    }
  }
  // Step 18: version-control tools. Registration grants NOTHING by itself;
  // the API wiring acts as the operator and grants exactly the declared
  // permissions so the API routes can invoke them. Agents never receive
  // these unless an operator grants them explicitly. version.rollback is
  // CRITICAL risk: the Tool System always demands a human confirmation
  // bound to the exact input, and restores only through the manager.
  if (version !== undefined) {
    const versionTools = createVersionTools(version);
    for (const definition of versionTools.definitions) {
      manager.register(definition);
    }
    for (const implementation of versionTools.implementations) {
      manager.registerImplementation(implementation);
    }
    for (const definition of versionTools.definitions) {
      for (const permission of definition.requiredPermissions) {
        manager.grantPermission(definition.id, permission);
      }
    }
  }
  // Step 19: File Intelligence tools. The principal is server-bound, never
  // supplied by an agent. Read/extract are granted explicitly; destructive
  // delete and project publish remain unavailable until an operator grants
  // them and their forced human confirmation succeeds.
  if (files !== undefined) {
    const fileTools = createFileIntelligenceTools(files, { ownerRef });
    for (const definition of fileTools.definitions) manager.register(definition);
    for (const implementation of fileTools.implementations)
      manager.registerImplementation(implementation);
    for (const id of ['file.get-metadata', 'file.read-preview', 'file.extract']) {
      const definition = fileTools.definitions.find((item) => item.id === id);
      if (definition)
        for (const permission of definition.requiredPermissions)
          manager.grantPermission(id, permission);
    }
  }
  // Step 20 audio tools: registration grants NOTHING. The read-only inspect
  // and search tools are granted explicitly; transcription and reasoning
  // tools stay ungranted until an operator enables them.
  // Step 21 image tools: registration grants NOTHING. Read-only inspect,
  // search, describe, and ocr tools are granted explicitly; the processing
  // and artifact tools stay ungranted until an operator enables them.
  if (image !== undefined) {
    const imageTools = createImageIntelligenceTools(image, { ownerRef });
    for (const definition of imageTools.definitions) manager.register(definition);
    for (const implementation of imageTools.implementations)
      manager.registerImplementation(implementation);
    for (const id of READ_ONLY_IMAGE_TOOLS) {
      const definition = imageTools.definitions.find((item) => item.id === id);
      if (definition)
        for (const permission of definition.requiredPermissions)
          manager.grantPermission(id, permission);
    }
  }
  if (audio !== undefined) {
    const audioTools = createAudioIntelligenceTools(audio, { ownerRef });
    for (const definition of audioTools.definitions) manager.register(definition);
    for (const implementation of audioTools.implementations)
      manager.registerImplementation(implementation);
    for (const id of READ_ONLY_AUDIO_TOOLS) {
      const definition = audioTools.definitions.find((item) => item.id === id);
      if (definition)
        for (const permission of definition.requiredPermissions)
          manager.grantPermission(id, permission);
    }
  }
  if (video) {
    const t = createVideoIntelligenceTools(video, { ownerRef });
    for (const d of t.definitions) manager.register(d);
    for (const i of t.implementations) manager.registerImplementation(i);
    for (const id of READ_ONLY_VIDEO_TOOLS) {
      const d = t.definitions.find((v) => v.id === id);
      if (d) for (const p of d.requiredPermissions) manager.grantPermission(id, p);
    }
  }
  // Step 23: document tools. The principal is server-bound, never supplied by an
  // agent. Only the read-only tools are granted; document.process (which starts
  // a job) and document.memory_candidates stay ungranted until an operator
  // enables them.
  if (document !== undefined) {
    const documentTools = createDocumentIntelligenceTools(document, { ownerRef });
    for (const definition of documentTools.definitions) manager.register(definition);
    for (const implementation of documentTools.implementations)
      manager.registerImplementation(implementation);
    for (const id of READ_ONLY_DOCUMENT_TOOLS) {
      const definition = documentTools.definitions.find((item) => item.id === id);
      if (definition)
        for (const permission of definition.requiredPermissions)
          manager.grantPermission(id, permission);
    }
  }
  // Step 30: App Builder tools. The read-only group answers questions. The
  // acting group (plan, create a project, hand work to the coding agent, build,
  // preview, deploy) is granted too, because the Tool System pauses every one
  // that changes something until a person approves the exact input. The model
  // cannot approve its own request.
  if (appBuilder !== undefined) {
    const groups = [
      {
        tools: createAppBuilderTools(appBuilder.manager, appBuilder.projects, ownerRef),
        ids: APP_BUILDER_TOOL_IDS as readonly string[],
      },
      {
        tools: createAppBuilderActionTools(appBuilder.manager, appBuilder.projects, ownerRef),
        ids: APP_BUILDER_ACTION_TOOL_IDS as readonly string[],
      },
    ];
    for (const { tools: builderTools, ids } of groups) {
      for (const definition of builderTools.definitions) manager.register(definition);
      for (const implementation of builderTools.implementations)
        manager.registerImplementation(implementation);
      for (const id of ids) {
        const definition = builderTools.definitions.find((item) => item.id === id);
        if (definition)
          for (const permission of definition.requiredPermissions)
            manager.grantPermission(id, permission);
      }
    }
  }
  // Step 25: cross-source intelligence tools. Registration grants NOTHING; the
  // read-only tools are granted explicitly below. Every call still resolves
  // sources through the owner's own adapters, so a tool cannot widen access.
  if (intelligence !== undefined) {
    const t = createIntelligenceTools({
      engine: intelligence.engine,
      search: new CrossSourceSearch(intelligence.registry),
      collectorFor: () => null,
      ownerRef,
    });
    for (const d of t.definitions) manager.register(d);
    for (const i of t.implementations) manager.registerImplementation(i);
    for (const d of t.definitions)
      for (const p of d.requiredPermissions) manager.grantPermission(d.id, p);
  }
  return manager;
}
