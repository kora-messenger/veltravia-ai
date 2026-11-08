import { pickModelFor } from './model-preferences.js';
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
import { registerExportRoutes } from './routes/exports.js';
import { createExportService } from './export-service.js';
import { runWithOwner } from '@veltravia/storage-postgres';
import { createSyncService } from './sync-service.js';
import { registerSyncRoutes } from './routes/sync.js';
import type { SyncManager } from '@veltravia/sync-core';
import type { GitHubApiConnector } from './github.js';
import type { RateLimiter } from './rate-limit.js';
import type { ExportManager } from '@veltravia/export-core';
import { registerBackendRoutes } from './routes/backend.js';
import { registerUnifiedRoutes } from './routes/unified.js';
import { createSourceService } from './source-service.js';
import { createAppBuilderManager } from './app-builder-service.js';
import type { RouteSelectorRequest } from '@veltravia/ai-gateway';
import { createAiExecutionService } from './ai-execution-service.js';
import type { AiExecutionService } from './ai-execution-service.js';
import type { GatewayServiceOptions } from './ai-gateway-service.js';
import { registerReasoningRoutes } from './routes/reasoning.js';
import { registerAgentProfileRoutes } from './routes/agent-profile.js';
import { AgentProfileStore } from './agent-profile.js';
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
import { fastifyLimits, registerSecurity } from './deployment/security.js';
import { resolveDeploymentConfig, type DeploymentConfig } from './deployment/config.js';
import { registerHealthRoutes } from './routes/health.js';
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
import { createAICore } from './ai.js';
import { createConnectorManager } from './connectors.js';
import { createAgentManager } from './agents.js';
import { createEngine } from './projects.js';
import { type Persistence, registerOwnerScope } from './persistence.js';
import { withRunRecording } from './durable-state.js';
import { resolveCallerOwnerRef } from './project-access.js';
import { registerRunRecordRoutes } from './routes/run-records.js';
import { registerWorkerRoutes } from './routes/workers.js';
import { registerVerificationRoutes } from './routes/verification.js';
import { registerChangeIntegrationRoutes } from './routes/change-integration.js';
import { WorkerStagingRegistry } from './worker-staging.js';
import { createChangeIntegrationService } from './change-integration-service.js';
import { createRecoveryService } from './recovery-service.js';
import { createExecutionService } from './execution-service.js';
import { registerRecoveryRoutes } from './routes/recovery.js';
import { registerExecutionRoutes } from './routes/executions.js';
import { registerReliabilityRoutes } from './routes/reliability.js';
import { randomUUID } from 'node:crypto';

import { registerUsageRoutes } from './routes/usage.js';
import { registerWalletRoutes } from './routes/wallet.js';
import { createUsageService } from './usage-service.js';
import { createWalletService } from './wallet-service.js';
import { registerIdempotency } from './idempotency.js';
import { createReliabilityService } from './reliability-service.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { createTaskService } from './task-service.js';
import { createWorkerService } from './worker-service.js';
import { createWorkerExecutor } from './worker-execution.js';
import { createVerificationService, type VerificationService } from './verification.js';
import { createToolManager } from './tools.js';
import { createSandboxManager, describeSandboxRuntime } from './sandboxes.js';
import { registerSandboxRoutes } from './routes/sandboxes.js';
import { registerAIRoutes } from './routes/ai-generate.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerCodingRoutes } from './routes/coding.js';
import { registerAppTestingRoutes } from './routes/app-testing.js';
import { registerTestingRoutes } from './routes/testing.js';
import { AppTestingService } from './app-testing.js';
import { describeEnvironment } from '@veltravia/testing-core';
import { TestingRunLedger } from './testing-ownership.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerCodebaseRoutes } from './routes/codebase.js';
import { registerRuntimeRoutes } from './routes/runtimes.js';
import { createCodingCheckpointPort } from './coding-checkpoints.js';
import { registerBranchRoutes } from './routes/branches.js';
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
import { createCodingManager, createDemoCodingDecisionSource } from './coding.js';
import { createApiCodingDecisionSource } from './coding-model.js';
import { createTestingStack } from './testing.js';
import { createGenerationManager } from './generation.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerProjectRoutes } from './routes/projects.js';
import { createProjectAccess, registerProjectAccessGuard } from './project-access.js';
import { RunOwnership } from './run-ownership.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { createIntegrationSystem, type ApiIntegrationSystem } from './integrations.js';
import { createGitHubApiConnector } from './github.js';

/** A positive integer from the environment, or 0 when unset or nonsense. */
function readPositiveIntEnv(name: string): number {
  const raw = process.env[name];
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface BuildAppOptions {
  /** Pre-built export manager (tests inject one); defaults to one over the project engine. */
  readonly exports?: ExportManager;
  /**
   * The run-scope ledger. Tests that inject their own coding / generation /
   * testing manager must build that manager from THIS ledger's resolver, or the
   * server and the manager disagree about which workspace a run may touch.
   */
  readonly runOwnership?: RunOwnership;
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
  /** Pre-built GitHub sync manager (tests inject one). */
  readonly githubSync?: SyncManager;
  /** The existing GitHub connector (tests inject a fake-backed one). */
  readonly githubConnector?: GitHubApiConnector;
  /** Rate limiter for sync routes (tests use a tiny window). */
  readonly syncLimiter?: RateLimiter;
  /** Pre-built TestingManager (tests inject one); defaults to the demo testing engine. */
  readonly testing?: TestingManager;
  /** Project memory (Step 15). Defaults to an in-process manager. */
  readonly memory?: MemoryManager;
  /** Verification service (Step 45); tests inject a scripted executor. */
  readonly verification?: VerificationService;
  /** Codebase intelligence (Step 16). Defaults to an in-process manager. */
  readonly codebase?: CodebaseIntelligenceManager;
  /** Preview runtime manager (Step 17). Defaults to the mock-executor-backed manager. */
  readonly runtimeManager?: RuntimeManager;
  /** Version Control manager (Step 18). Defaults to an in-process manager. */
  readonly versionManager?: VersionControlManager;
  /** Resolved deployment configuration. A test never has to supply one. */
  readonly deployment?: DeploymentConfig;
  /** Marketplace of durable gateway stores, when file storage is configured. */
  readonly gatewayStores?: NonNullable<GatewayServiceOptions['stores']>;
  /** Proves durable storage works; wired by main.ts when a data directory exists. */
  readonly verifyStorage?: () => Promise<void>;
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
  /**
   * Where data lives (Step 41). main.ts supplies a Postgres-backed one when a
   * database is configured; tests and laptops get the in-memory engine.
   */
  readonly persistence?: Persistence;
  /**
   * Environment for this instance (Step 52). Tests pass their own so a metering
   * token or deployment mode can be exercised without mutating `process.env` for
   * every other test in the file.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Builds the Fastify instance without starting it.
 * Tests use this entry point via fastify.inject(); main.ts starts the listener.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = options.env ?? process.env;
  const config = options.deployment ?? resolveDeploymentConfig();
  const app = Fastify({
    logger: false,
    ...fastifyLimits(config),
    // Strict validation: unknown properties are rejected (400), not silently
    // stripped - the API contract stays exact.
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Deployment plumbing comes first: it decides who may call, how much they may
  // send and what an error may say, so no route can answer before it applies.
  registerSecurity(app, { config });

  // The database pool must not outlive the server, or a test suite that builds
  // several apps leaks a pool per app and never exits.
  if (options.persistence !== undefined) {
    app.addHook('onClose', async () => {
      await options.persistence?.close();
    });
  }

  // The caller goes into scope before anything reads a repository: every
  // durable query is owner-scoped and refuses to run without it. Harmless in
  // memory mode, required in postgres mode.
  registerOwnerScope(app);

  // Liveness for the load balancer, readiness for traffic. Readiness verifies
  // durable storage only when the deployment claims to have some, and the
  // database only when one is configured.
  const persistence = options.persistence;

  /*
   * Durable state plumbing, present only when a database is configured.
   *
   * `preHandler` loads this owner's rows into the mirror the synchronous sync
   * and export ports read from, and hands export records back to the export
   * manager so an export created before a restart can still be listed.
   * `onSend` waits for queued writes before the response leaves, so a 2xx from
   * a mutating request means the row is in PostgreSQL, not merely queued.
   */
  if (persistence?.durable !== undefined && persistence.durable !== null) {
    const durable = persistence.durable;
    app.addHook('preHandler', async (request) => {
      const owner = resolveCallerOwnerRef(request);
      await runWithOwner(owner, async () => {
        const seeds = await durable.prepare(owner);
        if (seeds.length > 0) exportManager.hydrate(seeds);
      });
    });
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
        return payload;
      }
      const owner = resolveCallerOwnerRef(request);
      try {
        await runWithOwner(owner, () => durable.flush());
        return payload;
      } catch {
        reply.status(503);
        return JSON.stringify({
          error: {
            code: 'PERSISTENCE_UNAVAILABLE',
            message: 'The change could not be saved. Nothing was recorded; try again.',
          },
        });
      }
    });
  }

  registerHealthRoutes(app, {
    config,
    dependencies: {
      ...(options.verifyStorage === undefined ? {} : { verifyStorage: options.verifyStorage }),
      ...(persistence !== undefined && persistence.mode === 'postgres'
        ? { extra: [{ name: 'database', check: () => persistence.verify() }] }
        : {}),
    },
  });

  const aiCore = options.aiCore ?? createAICore();
  registerAIRoutes(app, aiCore);

  // Read-only connector surface: metadata, capabilities, permissions, status.
  const connectors = options.connectors ?? createConnectorManager();
  registerConnectorRoutes(app, connectors);

  // Sandbox engine: sandboxes, structured execution, cancellation. All
  // execution flows through the SandboxManager into the runtime behind the
  // isolation boundary - never in the API process, never with inherited
  // environment, never unrestricted.
  const projectEngine = options.projectEngine ?? persistence?.engine ?? createEngine();

  // Ownership guard. Registered BEFORE any route that names a project or a
  // workspace: Fastify applies a hook only to routes added after it.
  const projectAccess = createProjectAccess(projectEngine);
  registerProjectAccessGuard(app, projectAccess);
  // Which owner started which coding / generation run, and the one workspace
  // each run may touch. Shared by the three run managers and their routes.
  const runOwnership = options.runOwnership ?? new RunOwnership(projectEngine);
  const runScopes = { scopeOfRun: (runId: string) => runOwnership.scopeOf(runId) };
  const sandboxes = options.sandboxes ?? createSandboxManager();
  registerSandboxRoutes(app, sandboxes, projectEngine);

  // Read-only tool surface: definitions, permissions, risk, availability.
  // Execution is deliberately NOT exposed - the agent layer owns invocation.
  // Sandbox tools ride the same controlled pipeline (Step 5 gates apply).
  // Version Control (Step 18): immutable revisions, checkpoints, diffs, and
  // Tool-System-gated rollback over the SAME Project Engine. Created BEFORE
  // the tool manager so its tools can ride the controlled pipeline.
  // Which store holds the history follows the process: PostgreSQL when a
  // database is configured, in memory otherwise. Same manager, same conflict
  // checks, same routes above it.
  const durableStores = persistence?.mode === 'postgres' ? persistence.stores : null;
  const durableState = persistence?.durable ?? null;
  const versionService = createVersionControlService({
    projectEngine,
    ...(options.versionManager !== undefined ? { manager: options.versionManager } : {}),
    ...(durableStores === null
      ? {}
      : { revisionStore: durableStores.revisions, branchStore: durableStores.branches }),
  });
  const versionManager = versionService.manager;
  const branchManager = versionService.branches;
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
  const aiGateway =
    options.aiGateway ??
    createGatewayService(
      options.gatewayStores === undefined ? {} : { stores: options.gatewayStores },
    );

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
  // One GitHub connector for the whole server: the integration system and the
  // Step 40 synchroniser share it, so there is one token, one repository scope
  // and one set of operations. Never a second GitHub integration.
  const githubConnector = options.githubConnector ?? createGitHubApiConnector({});
  const integrations = options.integrations ?? createIntegrationSystem({ github: githubConnector });
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
    options.memory ??
    new MemoryManager({
      repository: durableStores?.memory ?? new InMemoryMemoryRepository(),
    });
  registerAgentRoutes(
    app,
    durableState === null ? agents : withRunRecording(agents, 'agent', durableState),
    projectEngine,
    memory,
    { gateway: aiGateway },
  );
  if (durableState !== null) registerRunRecordRoutes(app, { durable: durableState });

  // Task orchestration (Step 42): the Central Primary Agent's task records.
  // Durable when a database is configured, and honest about it when not.
  const taskService = createTaskService({ persistence, projects: projectEngine });
  registerTaskRoutes(app, { tasks: taskService });

  // Bounded Superagent workers (Step 43) over the same task service, so a
  // delegated task is the same record whichever route touches it.
  // Real verification (Step 45): discovery from project configuration, an
  // operation allowlist, and an execution seam that reports exactly how much
  // containment it has. Without a real runtime every run is recorded as
  // blocked - a simulated result is never stored as evidence.
  const verificationService: VerificationService =
    options.verification ?? createVerificationService({ projects: projectEngine, persistence });

  // Step 46: worker writes land in a staging tree, never the shared project.
  const workerStaging = new WorkerStagingRegistry(projectEngine);

  const workerService = createWorkerService({
    persistence,
    projects: projectEngine,
    tasks: taskService,
    executor: createWorkerExecutor({
      gateway: aiGateway,
      engine: projectEngine,
      verification: verificationService,
      staging: workerStaging,
    }),
  });
  /*
   * Step 52: metering.
   *
   * Two gauges are measured rather than inferred: bytes actually stored (from
   * the file records) and workers actually running (from the worker store). The
   * counters come from the ledger, which the guards below write to as work
   * happens. Nothing here duplicates a worker, task or execution decision; it
   * only records what they consumed.
   */
  // The wallet exists before the meter because the meter bills into it: the
  // wallet is created first and handed to the usage service as a hook.
  const walletService = createWalletService({
    env,
    store: persistence?.stores?.wallet,
  });

  const usageService = createUsageService({
    env,
    store: persistence?.stores?.usage,
    onRecorded: async (record) => {
      await walletService.billUsage({ ownerRef: record.ownerRef, record });
    },
    measureFileBytes: async (ownerRef, projectId) => {
      const assets = await fileManager.listFiles(
        { ownerRef },
        { projectId: projectId ?? undefined },
      );
      let bytes = 0;
      for (const asset of assets) {
        const size = (asset as { byteLength?: unknown }).byteLength;
        // An asset whose size is unknown contributes nothing rather than a guess;
        // the gauge is then a lower bound, which the capability matrix says.
        if (typeof size === 'number' && Number.isFinite(size) && size > 0) bytes += size;
      }
      return bytes;
    },
    measureOpenJobs: async (ownerRef) => {
      const workers = await workerService.workers.list(ownerRef);
      return workers.filter((worker) => worker.status === 'starting' || worker.status === 'running')
        .length;
    },
  });
  registerUsageRoutes(app, { usage: usageService }, env);
  registerWalletRoutes(app, { wallet: walletService }, env);
  registerWorkerRoutes(app, {
    workers: workerService,
    verification: verificationService,
    usage: {
      beforeStart: async ({ ownerRef }) => {
        const running = await workerService.workers.list(ownerRef);
        await usageService.guardConcurrency({
          ownerRef,
          running: running.filter(
            (worker) => worker.status === 'starting' || worker.status === 'running',
          ).length,
        });
      },
      afterReview: async ({ ownerRef, workerId, startedAt, finishedAt }) => {
        await usageService.recordWorkerExecution({ ownerRef, workerId, startedAt, finishedAt });
      },
    },
  });
  registerVerificationRoutes(app, { verification: verificationService, projects: projectEngine });

  // Project & Workspace Engine: safe project/workspace/file management over
  // in-memory repositories. No filesystem, execution, connector, or GitHub
  // operations are exposed - the future coding agent reaches this engine
  // only through declared project tools. (The sandbox layer validates
  // workspace references against this engine above.)
  registerProjectRoutes(app, projectEngine);

  // Coding Agent endpoints: bounded, state-machine-driven coding runs. Every
  // file mutation and validation flows through the Tool System above; plan
  // approvals and tool confirmations are decided by humans through the API.
  // Step 29's execution service is the ONE real-model path (router -> gateway
  // -> provider -> usage). Step 35's coding agent calls it, so the coding run
  // adds no second gateway, no second vault and no second usage record.
  const aiExecution =
    options.aiExecution ??
    createAiExecutionService({
      gateway: aiGateway.gateway ?? null,
      router: modelRouter,
      ...(aiGateway.blockedReason ? { blockedReason: aiGateway.blockedReason } : {}),
      onUsage: (input) => {
        /*
         * Every provider call here uses the caller's own connected key (the
         * gateway's vault is per owner), so the tokens are the caller's bill and
         * nothing is deducted from an allowance. They are still written down:
         * "what did this run cost" should not depend on the caller's provider
         * dashboard. The day a Veltravia-managed key exists, `byok` becomes the
         * flag that decides whether an allowance pays for it.
         */
        void usageService
          .recordProviderCall({
            ownerRef: input.ownerRef,
            runId: input.runId,
            providerId: input.providerId,
            modelId: input.modelId,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            byok: true,
          })
          .catch(() => undefined);
      },
    });

  // Step 35: the model-powered decision source. Scripted plans are a
  // development tool only, and only when the server says so explicitly.
  const codingDemoMode = (process.env.VELTRAVIA_CODING_DEMO ?? '') === '1';
  const codingModelMinIntervalMs = readPositiveIntEnv('VELTRAVIA_CODING_MODEL_MIN_INTERVAL_MS');
  const codingDecision =
    options.coding === undefined
      ? createApiCodingDecisionSource({
          execution: aiGateway.gateway ? aiExecution : null,
          gateway: aiGateway.gateway ?? null,
          projectEngine,
          demoMode: codingDemoMode,
          // Free provider tiers meter per minute; a coding run spends several
          // calls, so an operator can pace decisions for a metered key.
          ...(codingModelMinIntervalMs > 0 ? { minIntervalMs: codingModelMinIntervalMs } : {}),
          ...(aiGateway.blockedReason ? { blockedReason: aiGateway.blockedReason } : {}),
        })
      : null;

  const codingManager =
    options.coding ??
    // The coding agent gets its OWN Tool System instance, seeded with the
    // sandbox tools and the project file tools, with explicit server-side
    // grants. It never mutates the read-only tool surface above - tools
    // registered for coding do not appear on /api/tools and cannot change
    // the availability of tools other consumers see.
    createCodingManager({
      projectEngine,
      runScopes,
      sandboxes,
      checkpoints: createCodingCheckpointPort({ projectEngine, version: versionManager }),
      now: () => new Date(),
      // A real model plans and implements by default. The scripted source is
      // used only when VELTRAVIA_CODING_DEMO=1 is set server-side, and the run
      // view then says "demonstration" instead of implying model output.
      decisionSource:
        codingDecision === null || codingDemoMode
          ? createDemoCodingDecisionSource()
          : codingDecision,
    });
  const coding =
    durableState === null ? codingManager : withRunRecording(codingManager, 'coding', durableState);
  registerCodingRoutes(
    app,
    coding,
    { version: versionManager },
    // Honest capability reporting: the API's default coding agent runs a
    // scripted decision source, so the UI can say "demo" instead of implying
    // a model produced the plan.
    {
      decisionSource:
        options.coding !== undefined ? 'injected' : codingDemoMode ? 'scripted-demo' : 'model',
      planApprovalRequired: true,
    },
    { runs: runOwnership, ...(codingDecision !== null ? { decisionSource: codingDecision } : {}) },
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
      runScopes,
      sandboxes,
      now: () => new Date(),
    });
  runOwnership.addScopeSource((runId) => {
    try {
      const view = generation.getRun(runId);
      return view.projectId !== null && view.workspaceId !== null
        ? { projectId: view.projectId, workspaceId: view.workspaceId }
        : null;
    } catch {
      return null;
    }
  });
  registerGenerationRoutes(app, generation, { version: versionManager }, runOwnership);

  // Testing Engine endpoints: bounded, state-machine-driven test runs over
  // the SAME project engine and sandbox layer - every read and command flows
  // through a dedicated Tool System instance with explicit minimal grants.
  // Plans, repairs, and high-risk tool calls pause for HUMAN decisions
  // through these routes; responses carry safe normalized state only.
  const testing =
    options.testing ??
    createTestingStack({ projectEngine, sandboxes, runScopes, now: () => new Date() }).testing;
  // Who may see and act on which testing run. Required by every testing route.
  const testingLedger = new TestingRunLedger(projectEngine);
  // A test run, and the repair run it spawns, may touch only the workspace the test run was started on.
  runOwnership.addScopeSource((runId) => testingLedger.scopeOf(runId));
  registerTestingRoutes(
    app,
    durableState === null ? testing : withRunRecording(testing, 'testing', durableState),
    testingLedger,
    { version: versionManager },
  );
  // Application testing (Step 39): inspection, generated tests, security checks
  // and reports over the SAME testing manager. The environment is stated from
  // the sandbox runtime, never assumed.
  registerAppTestingRoutes(
    app,
    new AppTestingService({
      testing,
      ledger: testingLedger,
      environment: describeEnvironment(describeSandboxRuntime(), 'disabled'),
      now: () => new Date(),
    }),
    testing,
    testingLedger,
    { version: versionManager },
  );

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
  registerBranchRoutes(app, { version: versionManager, branches: branchManager, projectEngine });

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
  // Built here so the reasoning service can read it; routes register further down.
  const appBuilder =
    options.appBuilder ?? createAppBuilderManager({ projectEngine, codingAgent: coding });
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
      documents: documentManager,
      integrations,
      appBuilder: { manager: appBuilder, projects: projectEngine },
      images: imageManager,
      videos: videoManager,
      audio: audioManager,
      routeFor: async (input) => {
        // Automatic: the prompt's kind picks a model the owner actually has.
        // When none of the preferred models is connected, the router decides
        // exactly as it did before.
        let chosen: ReturnType<typeof pickModelFor> = null;
        if (input.category !== undefined) {
          try {
            const catalog = await modelRouter.router.catalog({ ownerRef: input.ownerRef });
            chosen = pickModelFor(
              input.category,
              catalog.models
                .filter((model) => model.available)
                .map((model) => ({
                  connectionId: model.connectionId,
                  providerId: model.providerId,
                  modelId: model.modelId,
                })),
            );
          } catch {
            chosen = null;
          }
        }
        const decision = await modelRouter.routeFor(input.ownerRef, {
          category: input.category ?? SERVICE_CATEGORIES.reasoning,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(chosen !== null
            ? {
                mode: 'manual' as const,
                connectionId: chosen.connectionId,
                modelId: chosen.modelId,
              }
            : {}),
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

  // Agent identity: each owner names their own assistant. Display-only, and
  // the name is never part of a run's context or an authorisation decision.
  registerAgentProfileRoutes(app, { store: new AgentProfileStore() });

  // Step 29: real-model execution. Router decides, the gateway executes, events
  // stream over SSE, and usage is recorded once per run.
  // App Builder (Step 30): the language-independent builder. Adapters reach the
  // SAME project engine and coding agent as everything else - no second store,
  // no second executor. Builds and deployments stay unavailable and say so.
  registerAppBuilderRoutes(app, { appBuilder });

  // Native source storage (Step 31): history, atomic change sets and snapshots
  // over the SAME project engine. No second project system, no filesystem.
  const sourceStorage = options.sourceStorage ?? createSourceService({ projectEngine });

  // Step 46: change integration, over the same source layer and verification
  // runtime, so an integration is the only way a worker's proposal reaches the
  // project and a stored run is the only evidence a check passed.
  const changeIntegrationService = createChangeIntegrationService({
    projects: projectEngine,
    source: sourceStorage,
    verification: verificationService,
    persistence,
  });
  registerChangeIntegrationRoutes(app, {
    changeIntegration: changeIntegrationService,
    source: sourceStorage,
    projects: projectEngine,
    staging: workerStaging,
    workers: workerService,
  });

  // Step 48: recovery reads what 42-46 recorded and decides whether a failed
  // unit of work is retried, handed to another worker, or escalated. The
  // project context is resolved from the task, never from the request.
  const recoveryService = createRecoveryService({
    workers: workerService,
    workerStore: workerService.workers,
    verification: verificationService,
    changeSets: changeIntegrationService.changeSets,
    integrations: changeIntegrationService.integrations,
    persistence,
    contextFor: async (ownerRef, taskId) => {
      const task = await taskService.manager.getTask(ownerRef, taskId).catch(() => null);
      if (task === null || task.projectId === null) {
        return { projectId: null, workspaceId: null, revision: null };
      }
      const workspaceId = task.workspaceId;
      if (workspaceId === null) {
        return { projectId: task.projectId, workspaceId: null, revision: null };
      }
      const revision = await sourceStorage
        .tree(ownerRef, { projectId: task.projectId, workspaceId })
        // Recovery compares revisions for staleness; the source layer's
        // numeric root becomes a stable string here.
        .then((tree) => (tree.rootRevision === null ? null : String(tree.rootRevision)))
        .catch(() => null);
      return { projectId: task.projectId, workspaceId, revision };
    },
  });
  registerRecoveryRoutes(app, { recovery: recoveryService });

  // Step 50: one coordinator over the engines above. It owns the plan, the
  // approvals and the delivery report; it never schedules, verifies, merges or
  // repairs anything itself, so there is still exactly one of each.
  const executionService = createExecutionService({
    projects: projectEngine,
    tasks: taskService,
    workers: workerService,
    verification: verificationService,
    changeIntegration: changeIntegrationService,
    recovery: recoveryService,
    store: persistence?.stores?.executions,
  });
  registerExecutionRoutes(app, {
    executions: executionService,
    usage: {
      beforeStart: async ({ ownerRef, projectId }) => {
        // A hold is only taken when the job count is actually measurable; with no
        // measurement the decision is "not enforced" and nothing is held.
        const operationKey = `intake:${randomUUID()}`;
        const hold = await usageService.guardBackgroundJob({ ownerRef, projectId, operationKey });
        if (hold === null) return null;
        return {
          settle: () =>
            usageService.settleJob({ ownerRef, operationKey, projectId, outcome: 'completed' }),
          release: () =>
            usageService.settleJob({ ownerRef, operationKey, projectId, outcome: 'released' }),
        };
      },
    },
  });

  // Step 51: the coordination the pipeline was missing. Idempotency keys, leases
  // around every state change, a sweep for interrupted work and health from
  // stored records. The coordinator above takes the leases; nothing here
  // duplicates a task, worker, verification, integration or recovery decision.
  const reliabilityService = createReliabilityService({
    executions: executionService,
    tasks: taskService,
    workers: workerService,
    verification: verificationService,
    recovery: recoveryService,
    persistence,
    holder: `api_${process.pid}`,
  });
  executionService.manager.useCoordination({
    run: async (ownerRef, resource, work) => {
      // A lease claimed and released around one section of work: a second
      // process asking for the same execution is refused, not served twice.
      const held = await reliabilityService.leases.withLease(ownerRef, resource, work);
      return held;
    },
  });
  registerIdempotency(app, () => reliabilityService.guard);
  registerReliabilityRoutes(app, { reliability: reliabilityService });
  app.get('/api/reliability/ready', async () => ({
    reliability: {
      durable: reliabilityService.durable,
      holder: reliabilityService.holder,
      store: persistence === null ? 'memory' : 'postgres',
    },
  }));
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

  // Native export (Step 40): ZIP archives of a project, read through the SAME
  // project engine. Owner-scoped, revision-consistent, secrets left out. GitHub
  // is not involved and nothing here writes to the project.
  const exportManager =
    options.exports ??
    createExportService({
      projectEngine,
      ...(durableState === null
        ? {}
        : {
            store: durableState.archiveStore,
            sink: {
              save: (seed: { view: { exportId: string } }) => {
                durableState?.saveExportRecord(seed as never);
              },
              delete: (exportId: string) => {
                durableState?.deleteExportRecord(exportId);
              },
            },
          }),
    });
  registerExportRoutes(app, { exports: exportManager });

  // GitHub synchronisation (Step 40, phase 3): OPTIONAL. It rides the existing
  // GitHub connector, keeps both sides of every conflict, and never writes to
  // the remote without an approved plan. Native use and export never need it.
  registerSyncRoutes(app, {
    sync:
      options.githubSync ??
      createSyncService({
        projectEngine,
        github: githubConnector,
        ...(durableState === null ? {} : { store: durableState.syncStore }),
      }),
    ...(options.syncLimiter === undefined ? {} : { limiter: options.syncLimiter }),
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

  registerAiExecutionRoutes(app, { service: aiExecution });

  return app;
}
