import Fastify, { type FastifyInstance } from 'fastify';
import type { AICore } from '@veltravia/ai-core';
import type { ConnectorManager } from '@veltravia/connector-core';
import type { AgentManager } from '@veltravia/agent-core';
import type { CodingAgentManager } from '@veltravia/coding-agent-core';
import type { ToolManager } from '@veltravia/tool-core';
import type { ProjectEngine } from '@veltravia/project-core';
import type { SandboxManager } from '@veltravia/sandbox-core';
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
import { createCodingManager } from './coding.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerProjectRoutes } from './routes/projects.js';

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

  // Agent execution endpoints: bounded runs, confirmation flow, cancellation.
  // Responses carry safe normalized state only - never chain-of-thought.
  const agents = options.agents ?? createAgentManager();
  // The agent routes get the Project Engine so every run's project/workspace
  // association is resolved and validated server-side (Step 11C-4): the
  // browser's identifiers are never trusted, and the derived context is
  // bounded safe metadata + tree structure - never file contents.
  registerAgentRoutes(app, agents, projectEngine);

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

  return app;
}
