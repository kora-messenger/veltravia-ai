import { registerVideoRoutes } from './routes/video.js';
import { registerDocumentRoutes } from './routes/document.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerAiGatewayRoutes } from './routes/ai-gateway.js';
import { registerModelRouterRoutes } from './routes/model-router.js';
import {
  SERVICE_CATEGORIES,
  createModelRouterService,
  type ModelRouterService,
} from './model-router-service.js';
import { createGatewayService, type GatewayService } from './ai-gateway-service.js';
import { registerIntelligenceRoutes } from './routes/intelligence.js';
import { registerAiExecutionRoutes } from './routes/ai-execution.js';
import { registerAppBuilderRoutes } from './routes/app-builder.js';
import { registerSourceRoutes } from './routes/source.js';
import { registerBackendRoutes } from './routes/backend.js';
import { registerUnifiedRoutes } from './routes/unified.js';
import { createSourceService } from './source-service.js';
import { createAppBuilderManager } from './app-builder-service.js';
import type { RouteSelectorRequest } from '@veltravia/ai-gateway';
import { createAiExecutionService } from './ai-execution-service.js';
import type { AiExecutionService } from './ai-execution-service.js';
import { registerReasoningRoutes } from './routes/reasoning.js';
import { ReasoningService } from './reasoning-service.js';
import { createIntelligenceService } from './intelligence-service.js';
import { createVideoIntelligenceService } from './video-service.js';
import type { VideoIntelligenceManager } from '@veltravia/video-intelligence-core';
import type { AppBuilderManager } from '@veltravia/app-builder-core';
import type { SourceRepositoryManager } from '@veltravia/source-storage-core';
import type { DocumentIntelligenceManager } from '@veltravia/document-intelligence-core';
import {
  createDocumentIntelligenceService,
  createGatewayDocumentManager,
} from './document-service.js';
import { createConnectionService } from './connections-service.js';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AICore } from '@veltravia/ai-core';
import type { ConnectorManager } from '@veltravia/connector-core';
import type { AgentManager } from '@veltravia/agent-core';
import type { CodingAgentManager } from '@veltravia/coding-agent-core';
import type { TestingManager } from '@veltravia/testing-core';
import type { AppGenerationManager } from '@veltravia/generation-core';
import type { ToolManager } from '@veltravia/tool-core';
import type { ProjectEngine } from '@veltravia/project-core';
import type { SandboxManager } from '@veltravia/sandbox-core';
import { MemoryManager } from '@veltravia/memory-core';
import { InMemoryMemoryRepository } from '@veltravia/memory-mock';
import type { CodebaseIntelligenceManager } from '@veltravia/codebase-core';
import type { RuntimeManager } from '@veltravia/runtime-core';
import type { VersionControlManager } from '@veltravia/version-core';
import type { FileIntelligenceManager } from '@veltravia/file-intelligence-core';
import { formatTimestamp } from '@veltravia/shared';
import { VELTRAVIA_NAME, VELTRAVIA_VERSION, type HealthCheckResponse } from '@veltravia/types';
import { createAICore } from './ai.js';
import { createConnectorManager } from './connectors.js';
import { createAgentManager } from './agents.js';
import { createEngine } from './projects.js';
import { createToolManager } from './tools.js';
import { createSandboxManager } from './sandboxes.js';
import { registerSandboxRoutes } from './routes/sandboxes.js';
import { registerAIRoutes } from './routes/ai-generate.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerCodingRoutes } from './routes/coding.js';
import { registerTestingRoutes } from './routes/testing.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerCodebaseRoutes } from './routes/codebase.js';
import { registerRuntimeRoutes } from './routes/runtimes.js';
import { registerVersionRoutes } from './routes/versions.js';
import { createVersionControlService } from './version-service.js';
import { createFileIntelligenceService } from './file-service.js';
import { registerFileRoutes } from './routes/files.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerImageRoutes } from './routes/image.js';
import { createAudioIntelligenceService } from './audio-service.js';
import { createImageIntelligenceService } from './image-service.js';
import type { AudioIntelligenceManager } from '@veltravia/audio-intelligence-core';
import type { ImageIntelligenceManager } from '@veltravia/image-intelligence-core';
import { createRuntimeManager } from './runtime-service.js';
import { createCodebaseManager } from './codebase-service.js';
import { registerGenerationRoutes } from './routes/generation.js';
import { createCodingManager } from './coding.js';
import { createTestingManager } from './testing.js';
import { createGenerationManager } from './generation.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { createIntegrationSystem, type ApiIntegrationSystem } from './integrations.js';
import { createGitHubApiConnector } from './github.js';

export interface BuildAppOptions {
  /** Pre-built AICore (tests inject one); defaults to the mock-backed core. */
  readonly aiCore?: AICore;
  /** Pre-built ConnectorManager (tests inject one); defaults to the mock connector. */
  readonly connectors?: ConnectorManager;
  /** Pre-built ToolManager (tests inject one); defaults to the mock tools. */
  readonly tools?: ToolManager;
  /** Pre-built AgentManager (tests inject one); defaults to the demo agents. */
  readonly agents?: AgentManager;
  /** Pre-built Project Engine (tests inject one); defaults to the in-memory engine. */
  readonly projectEngine?: ProjectEngine;
  /** Pre-built SandboxManager (tests inject one); defaults to the mock runtime. */
  readonly sandboxes?: SandboxManager;
  /** Pre-built CodingAgentManager (tests inject one); defaults to the demo coding agent. */
  readonly coding?: CodingAgentManager;
  /** Pre-built AppGenerationManager (tests inject one); defaults to the demo generation engine. */
  readonly generation?: AppGenerationManager;
  /** Pre-built integration system (tests inject one); defaults to the demo system. */
  readonly integrations?: ApiIntegrationSystem;
  /** Pre-built real-model execution service (tests inject one). */
  readonly aiExecution?: AiExecutionService;
  /** Pre-built App Builder manager (tests inject one). */
  readonly appBuilder?: AppBuilderManager;
  /** Pre-built native source storage manager (tests inject one). */
  readonly sourceStorage?: SourceRepositoryManager;
  /** Pre-built TestingManager (tests inject one); defaults to the demo testing engine. */
  readonly testing?: TestingManager;
  /** Project memory (Step 15). Defaults to an in-process manager. */
  readonly memory?: MemoryManager;
  /** Codebase intelligence (Step 16). Defaults to an in-process manager. */
  readonly codebase?: CodebaseIntelligenceManager;
  /** Preview runtime manager (Step 17). Defaults to the mock-executor-backed manager. */
  readonly runtimeManager?: RuntimeManager;
  /** Version Control manager (Step 18). Defaults to an in-process manager. */
  readonly versionManager?: VersionControlManager;
  /** File Intelligence manager (Step 19). Defaults to process-local mock storage. */
  readonly fileManager?: FileIntelligenceManager;
  /** Audio Intelligence manager (Step 20). Defaults to the mock provider. */
  readonly audioManager?: AudioIntelligenceManager;
  readonly imageManager?: ImageIntelligenceManager;
  readonly videoManager?: VideoIntelligenceManager;
  readonly documentManager?: DocumentIntelligenceManager;
  /** AI provider gateway (Step 26). Defaults to an env-keyed encrypted service. */
  readonly aiGateway?: GatewayService;
  /** Reasoning engine (Step 27). Defaults to a gateway-backed service. */
  readonly reasoning?: ReasoningService;
  /** Model router (Step 28). Defaults to the gateway-backed router. */
  readonly modelRouter?: ModelRouterService;
}

/**
 * Builds the Fastify instance without starting it.
 * Tests use this entry point via fastify.inject(); main.ts starts the listener.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Strict validation: unknown properties are rejected (400), not silently
    // stripped - the API contract stays exact.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.get('/health', async (): Promise<HealthCheckResponse> => ({
    status: 'ok',
    service: `${VELTRAVIA_NAME} API`,
    version: VELTRAVIA_VERSION,
    timestamp: formatTimestamp(),
  }));

  const aiCore = options.aiCore ?? createAICore();
  registerAIRoutes(app, aiCore);

  // Read-only connector surface: metadata, capabilities, permissions, status.
  const connectors = options.connectors ?? createConnectorManager();
  registerConnectorRoutes(app, connectors);

  // Sandbox engine: sandboxes, structured execution, cancellation. All
  // execution flows through the SandboxManager into the runtime behind the
  // isolation boundary - never in the API process, never with inherited
  // environment, never unrestricted.
  const projectEngine = options.projectEngine ?? createEngine();
  const sandboxes = options.sandboxes ?? createSandboxManager();
  registerSandboxRoutes(app, sandboxes, projectEngine);

  // Read-only tool surface: definitions, permissions, risk, availability.
  // Execution is deliberately NOT exposed - the agent layer owns invocation.
  // Sandbox tools ride the same controlled pipeline (Step 5 gates apply).
  // Version Control (Step 18): immutable revisions, checkpoints, diffs, and
  // Tool-System-gated rollback over the SAME Project Engine. Created BEFORE
  // the tool manager so its tools can ride the controlled pipeline.
  const versionManager =
    options.versionManager ??
    createVersionControlService({
      projectEngine,
    }).manager;
  const fileManager =
    options.fileManager ?? createFileIntelligenceService({ projectEngine, versionManager });
  const audioManager =
    options.audioManager ?? createAudioIntelligenceService({ files: fileManager });
  const imageManager =
    options.imageManager ?? createImageIntelligenceService({ files: fileManager });
  const videoManager =
    options.videoManager ?? createVideoIntelligenceService({ files: fileManager });
  const documentManager =
    options.documentManager ?? createDocumentIntelligenceService({ files: fileManager });

  // Step 24: connected-app intelligence. GitHub is live-capable when a token and
  // repository allowlist are configured; Google Drive and Notion run the
  // deterministic simulation (see connections-service.ts). Every response
  // reports which mode is active. All operations are read-only.
  const connections = createConnectionService({});

  // Step 26: the AI provider gateway (BYOK). Credentials are encrypted with a
  // versioned AES-256-GCM key from the environment; when no key is configured
  // the service reports `ready: false` and refuses to store anything rather
  // than falling back to plaintext.
  const aiGateway = options.aiGateway ?? createGatewayService({});

  // Step 28: one model-selection seam for the whole platform. The router reads
  // the owner's connections from the same gateway that will make the call, so a
  // decision can never name a provider or model the caller cannot use.
  const modelRouter =
    options.modelRouter ?? createModelRouterService({ gateway: aiGateway.gateway ?? null });

  // One selection seam for every feature: the gateway asks the router whenever a
  // caller has not named a model itself. A refusal is returned as a refusal.
  aiGateway.gateway?.attachSelector({
    select: async (request: RouteSelectorRequest) => {
      const decision = await modelRouter.routeFor(request.ownerRef, {
        category: request.category as never,
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        ...(request.needsStreaming !== undefined ? { needsStreaming: request.needsStreaming } : {}),
        ...(request.estimatedInputTokens !== undefined
          ? { estimatedInputTokens: request.estimatedInputTokens }
          : {}),
        ...(request.purpose !== undefined ? { purpose: request.purpose } : {}),
      });
      if (decision.outcome !== 'routed' || decision.selected === null) {
        return {
          outcome: 'refused' as const,
          summary: decision.summary,
          decisionId: decision.id,
        };
      }
      return {
        outcome: 'routed' as const,
        connectionId: decision.selected.connectionId,
        providerId: decision.selected.providerId,
        modelId: decision.selected.modelId,
        decisionId: decision.id,
        summary: decision.summary,
        contextWindowTokens: decision.selected.contextWindowTokens,
      };
    },
  });

  // Step 25: cross-source intelligence. Sources are the owner's uploaded
  // documents, connected-app resources and project workspace files. Reasoning
  // runs a deterministic provider (no model, no credentials) and says so.
  const intelligence = createIntelligenceService({
    files: fileManager,
    connected: connections.manager,
    projectEngine,
    ...(aiGateway.gateway ? { gateway: aiGateway.gateway } : {}),
  });

  const tools =
    options.tools ??
    createToolManager(
      () => new Date(),
      sandboxes,
      undefined,
      undefined,
      undefined,
      versionManager,
      fileManager,
      audioManager,
      imageManager,
      videoManager,
      intelligence,
    );
  registerToolRoutes(app, tools);

  // Integration / plugin system (Step 12): catalog + owner-scoped
  // connections over the multi-connector foundation. Read-only for the
  // catalog; connections are metadata only - no endpoint here executes
  // anything or can touch a secret.
  const integrations =
    options.integrations ?? createIntegrationSystem({ github: createGitHubApiConnector({}) });
  registerIntegrationRoutes(app, integrations);

  // Agent execution endpoints: bounded runs, confirmation flow, cancellation.
  // Responses carry safe normalized state only - never chain-of-thought.
  // The integration tools (mock storage/database) ride the same pipeline,
  // so the demo storage agent proves agent->tool->connector discovery
  // with no connector-specific agent code.
  const agents =
    options.agents ??
    createAgentManager(() => new Date(), integrations, options.codebase, fileManager);
  // The agent routes get the Project Engine so every run's project/workspace
  // association is resolved and validated server-side (Step 11C-4): the
  // browser's identifiers are never trusted, and the derived context is
  // bounded safe metadata + tree structure - never file contents.
  // Project memory (Step 15): durable, per-project facts with human
  // review of every AI-extracted candidate. Memory enters agent runs as
  // UNTRUSTED reference data only - never as instructions.
  const memory =
    options.memory ?? new MemoryManager({ repository: new InMemoryMemoryRepository() });
  registerAgentRoutes(app, agents, projectEngine, memory, { gateway: aiGateway });

  // Project & Workspace Engine: safe project/workspace/file management over
  // in-memory repositories. No filesystem, execution, connector, or GitHub
  // operations are exposed - the future coding agent reaches this engine
  // only through declared project tools. (The sandbox layer validates
  // workspace references against this engine above.)
  registerProjectRoutes(app, projectEngine);

  // Coding Agent endpoints: bounded, state-machine-driven coding runs. Every
  // file mutation and validation flows through the Tool System above; plan
  // approvals and tool confirmations are decided by humans through the API.
  const coding =
    options.coding ??
    // The coding agent gets its OWN Tool System instance, seeded with the
    // sandbox tools and the project file tools, with explicit server-side
    // grants. It never mutates the read-only tool surface above - tools
    // registered for coding do not appear on /api/tools and cannot change
    // the availability of tools other consumers see.
    createCodingManager({
      projectEngine,
      sandboxes,
      now: () => new Date(),
    });
  registerCodingRoutes(
    app,
    coding,
    { version: versionManager },
    // Honest capability reporting: the API's default coding agent runs a
    // scripted decision source, so the UI can say "demo" instead of implying
    // a model produced the plan.
    {
      decisionSource: options.coding === undefined ? 'scripted-demo' : 'injected',
      planApprovalRequired: true,
    },
  );

  // App Generation endpoints: bounded, state-machine-driven idea-to-app
  // runs. The engine gets its OWN Tool System instance (project file tools
  // + sandbox tools, explicit minimal grants); plans and high-risk tool
  // calls pause for HUMAN decisions through these routes. Responses carry
  // safe normalized state only - the plan view exposes paths and sizes,
  // never file content.
  const generation =
    options.generation ??
    createGenerationManager({
      projectEngine,
      sandboxes,
      now: () => new Date(),
    });
  registerGenerationRoutes(app, generation, { version: versionManager });

  // Testing Engine endpoints: bounded, state-machine-driven test runs over
  // the SAME project engine and sandbox layer - every read and command flows
  // through a dedicated Tool System instance with explicit minimal grants.
  // Plans, repairs, and high-risk tool calls pause for HUMAN decisions
  // through these routes; responses carry safe normalized state only.
  const testing =
    options.testing ??
    createTestingManager({
      projectEngine,
      sandboxes,
      now: () => new Date(),
    });
  registerTestingRoutes(app, testing, { version: versionManager });

  // Memory routes: per-project memory CRUD, search, lifecycle, candidate
  // review, stats, and candidate extraction from COMPLETED runs. Every
  // route validates the project against the Project Engine; extraction
  // products are always NON-AUTHORITATIVE candidates pending approval.
  registerMemoryRoutes(app, { memory, projectEngine, generation, testing });

  // Codebase intelligence (Step 16): read-only analysis over the SAME
  // Project Engine data - indexes, bounded search, feature traces, and
  // memory candidates from COMPLETED indexes. Never mutates project
  // files and never returns raw source content.
  const codebase = options.codebase ?? createCodebaseManager(projectEngine);
  registerCodebaseRoutes(app, { codebase, projectEngine, memory });
  const runtimeManager =
    options.runtimeManager ?? createRuntimeManager({ projectEngine, codebase });
  registerRuntimeRoutes(app, { runtimeManager, projectEngine });

  // Version Control routes (Step 18): revision timeline, diffs, checkpoints,
  // and rollback. Rollback restores ONLY through the Tool System above
  // (`version.rollback`, critical risk, human confirmation bound to the
  // exact input); every response is metadata or a bounded diff view.
  registerVersionRoutes(app, { version: versionManager, projectEngine, tools });

  // Step 19: upload, bounded extraction/preview, provenance-linked artifacts,
  // controlled short-lived downloads. Raw storage references never cross API.
  registerFileRoutes(app, fileManager);

  // Step 20: first-class audio understanding over Step 19 files. Transcripts
  // are untrusted data, reasoning output is ai_generated, and spoken content
  // never becomes authorization. Provider is the honest mock (see
  // audio-service.ts); memory candidates ride the Step 15 approval model.
  registerAudioRoutes(app, audioManager, { memory, projectEngine });

  // Step 21: first-class image and screenshot understanding over Step 19
  // files. OCR text is UNTRUSTED DATA; reasoning output is ai_generated. The
  // API wires the deterministic MOCK provider (see image-service.ts); no real
  // vision provider is claimed in this step.
  registerImageRoutes(app, imageManager);
  registerVideoRoutes(app, videoManager);

  // Step 23: document understanding over Step 19 files. Parsing is genuine
  // (DOCX/XLSX/PPTX/PDF/CSV/MD/HTML/JSON/XML/TXT); the reasoning provider is
  // the deterministic mock (see document-service.ts). Extracted text and
  // tables are UNTRUSTED DATA; reasoning output is ai_generated.
  // Step 26: documents can reason on the caller's own provider. The manager is
  // cached PER OWNER so a job created in one request is visible in the next;
  // each owner keeps their own stack and their own key scope.
  const gatewayDocumentManagers = new Map<string, DocumentIntelligenceManager>();
  registerDocumentRoutes(app, documentManager, {
    gatewayManagerFor: (ownerRef) => {
      const existing = gatewayDocumentManagers.get(ownerRef);
      if (existing) return existing;
      if (!aiGateway.gateway) {
        throw new Error(
          aiGateway.blockedReason ?? 'Credential encryption is not configured on this server.',
        );
      }
      const created = createGatewayDocumentManager({
        files: fileManager,
        gateway: aiGateway.gateway,
        ownerRef,
      });
      gatewayDocumentManagers.set(ownerRef, created);
      return created;
    },
  });

  registerConnectionRoutes(app, connections);

  // Owner-scoped provider connections, model discovery, preferences and usage.
  // No endpoint returns a credential; only a masked hint ever crosses the API.
  registerAiGatewayRoutes(app, {
    service: aiGateway,
    router: modelRouter,
    persistenceNote:
      'Routing preferences are held in memory for this server process and are lost on restart.',
  });

  // The catalog, per-task support, preferences and explanations behind every
  // model choice. Read-only apart from preferences: this surface never calls a
  // provider, so a decision cannot bill anything.
  registerModelRouterRoutes(app, {
    service: modelRouter,
    projects: projectEngine,
    gateway: aiGateway.gateway ?? null,
    ...(aiGateway.blockedReason ? { blockedReason: aiGateway.blockedReason } : {}),
  });

  // Cross-source search, synthesis, contradictions, relationships and evidence.
  // Owner-scoped and read-only; the reasoning mode is disclosed in every answer.
  registerIntelligenceRoutes(app, intelligence);

  // Step 27: the reasoning engine. Every run goes through the owner's own
  // provider (or the disclosed offline mock), may only name tools the server
  // offers, and pauses for a human before anything risky. Streaming exposes the
  // same events the API reports, never hidden reasoning.
  const reasoning =
    options.reasoning ??
    new ReasoningService({
      gateway: aiGateway.gateway ?? null,
      ...(aiGateway.gateway
        ? {}
        : { blockedReason: aiGateway.blockedReason ?? 'No AI provider is connected yet.' }),
      codebase,
      files: fileManager,
      intelligence,
      routeFor: async (input) => {
        const decision = await modelRouter.routeFor(input.ownerRef, {
          category: SERVICE_CATEGORIES.reasoning,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          purpose: 'reasoning run',
        });
        if (decision.outcome === 'routed' && decision.selected !== null) {
          return {
            outcome: 'routed' as const,
            connectionId: decision.selected.connectionId,
            modelId: decision.selected.modelId,
          };
        }
        return {
          outcome: decision.outcome === 'routed' ? 'needs-attention' : decision.outcome,
          summary: decision.summary,
        };
      },
    });
  registerReasoningRoutes(app, reasoning);

  // Step 29: real-model execution. Router decides, the gateway executes, events
  // stream over SSE, and usage is recorded once per run.
  // App Builder (Step 30): the language-independent builder. Adapters reach the
  // SAME project engine and coding agent as everything else - no second store,
  // no second executor. Builds and deployments stay unavailable and say so.
  const appBuilder =
    options.appBuilder ?? createAppBuilderManager({ projectEngine, codingAgent: coding });
  registerAppBuilderRoutes(app, { appBuilder });

  // Native source storage (Step 31): history, atomic change sets and snapshots
  // over the SAME project engine. No second project system, no filesystem.
  const sourceStorage = options.sourceStorage ?? createSourceService({ projectEngine });
  registerSourceRoutes(app, {
    source: sourceStorage,
    // Framework-aware structure: detection reads manifests through the project
    // engine; a stack it cannot identify stays `null` rather than a guess.
    detectStack: async (projectId, workspaceId) => {
      if (workspaceId === undefined) return null;
      const detection = await appBuilder.detectWorkspace({ projectId, workspaceId });
      const best = [...detection.frameworks].sort((a, b) => b.confidence - a.confidence)[0];
      return best?.id ?? null;
    },
  });

  // Backend Builder (Step 33): a descriptive scan of the SAME tree. Read-only,
  // bounded, redacted, and explicit about the capabilities it does not have.
  registerBackendRoutes(app, {
    scan: {
      source: sourceStorage,
      detect: async (projectId, workspaceId) => {
        if (workspaceId === undefined) return { framework: null, language: null, runtime: null };
        const detection = await appBuilder.detectWorkspace({ projectId, workspaceId });
        const framework = [...detection.frameworks].sort((a, b) => b.confidence - a.confidence)[0];
        const language = [...detection.languages].sort((a, b) => b.confidence - a.confidence)[0];
        return {
          framework: framework?.id ?? null,
          language: language?.name ?? null,
          runtime: null,
        };
      },
    },
  });

  // Unified app workspace (Step 34): one project is one application. This
  // composes the source layer, the frontend classifier and the backend scan that
  // already exist - no second store, no second analyser, no second AI system.
  registerUnifiedRoutes(app, {
    unified: {
      source: sourceStorage,
      scan: {
        source: sourceStorage,
        detect: async (projectId, workspaceId) => {
          if (workspaceId === undefined) return { framework: null, language: null, runtime: null };
          const detection = await appBuilder.detectWorkspace({ projectId, workspaceId });
          const framework = [...detection.frameworks].sort(
            (a, b) => b.confidence - a.confidence,
          )[0];
          const language = [...detection.languages].sort((a, b) => b.confidence - a.confidence)[0];
          return {
            framework: framework?.id ?? null,
            language: language?.name ?? null,
            runtime: null,
          };
        },
      },
      describeProject: async (projectId, ownerRef) => {
        const project = await projectEngine.projects.getProject(projectId);
        // Ownership is enforced by the source layer below; this only reads the
        // record it has already been allowed to see.
        if (project.ownerRef !== ownerRef) {
          const error = Object.assign(new Error('Project not found.'), {
            code: 'PROJECT_NOT_FOUND',
          });
          throw error;
        }
        return {
          id: project.id,
          name: project.name,
          description: project.description,
          projectType: project.projectType,
          status: project.status,
          updatedAt: project.updatedAt,
        };
      },
    },
  });

  registerAiExecutionRoutes(app, {
    service:
      options.aiExecution ??
      createAiExecutionService({
        gateway: aiGateway.gateway ?? null,
        router: modelRouter,
        ...(aiGateway.blockedReason ? { blockedReason: aiGateway.blockedReason } : {}),
      }),
  });

  return app;
}
