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
  /** Pre-built TestingManager (tests inject one); defaults to the demo testing engine. */
  readonly testing?: TestingManager;
  /** Project memory (Step 15). Defaults to an in-process manager. */
  readonly memory?: MemoryManager;
  /** Codebase intelligence (Step 16). Defaults to an in-process manager. */
  readonly codebase?: CodebaseIntelligenceManager;
  /** Preview runtime manager (Step 17). Defaults to the mock-executor-backed manager. */
  readonly runtimeManager?: RuntimeManager;
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
  const tools = options.tools ?? createToolManager(() => new Date(), sandboxes);
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
    options.agents ?? createAgentManager(() => new Date(), integrations, options.codebase);
  // The agent routes get the Project Engine so every run's project/workspace
  // association is resolved and validated server-side (Step 11C-4): the
  // browser's identifiers are never trusted, and the derived context is
  // bounded safe metadata + tree structure - never file contents.
  // Project memory (Step 15): durable, per-project facts with human
  // review of every AI-extracted candidate. Memory enters agent runs as
  // UNTRUSTED reference data only - never as instructions.
  const memory =
    options.memory ?? new MemoryManager({ repository: new InMemoryMemoryRepository() });
  registerAgentRoutes(app, agents, projectEngine, memory);

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
  registerCodingRoutes(app, coding);

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
  registerGenerationRoutes(app, generation);

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
  registerTestingRoutes(app, testing);

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

  return app;
}
