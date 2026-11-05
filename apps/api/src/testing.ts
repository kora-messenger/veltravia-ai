import {
  CODING_TOOL_IDS,
  createProjectTools,
  type ProjectToolOwnership,
} from '@veltravia/coding-agent-core';
import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import type { ProjectEngine } from '@veltravia/project-core';
import type { SandboxManager } from '@veltravia/sandbox-core';
import { TestingManager, TESTING_TOOL_IDS, type DebugAgent } from '@veltravia/testing-core';
import { createMockDebugAgent } from '@veltravia/testing-mock';
import type { ToolManager } from '@veltravia/tool-core';

import { createToolManager } from './tools.js';

/**
 * The API's demo testing Debug Agent.
 *
 * DEVELOPMENT-ONLY LIMITATION (documented in docs/testing.md): the API's
 * testing runs diagnose failures with a deterministic, offline scripted debug
 * agent - no real model is wired into the API yet. The orchestration, state
 * machine, tool gating, confirmations, limits, and audit are fully real:
 * swapping the scripted source for an AI-routed DebugAgent changes nothing
 * else (one constructor argument).
 */
function createDemoDebugAgent(): DebugAgent {
  return createMockDebugAgent();
}

export interface CreateTestingManagerOptions {
  readonly projectEngine: ProjectEngine;
  /** Holds each run to the one workspace it was started on (see run-ownership.ts). */
  readonly runScopes: ProjectToolOwnership;
  readonly tools?: ToolManager;
  /** Sandbox manager for registering sandbox tools when no tools manager is injected. */
  readonly sandboxes?: SandboxManager;
  readonly now?: () => Date;
  /** Overrides the debug agent (tests may inject their own). */
  readonly debugAgent?: DebugAgent;
}

/**
 * Builds the API's TestingManager.
 *
 * Every project file read, every sandbox creation, and every command
 * execution flows through the SAME Tool System pipeline (validation,
 * explicit grants, risk-based confirmation). Registration grants nothing:
 * this wiring grants exactly the permissions the testing manager and its
 * Coding Agent repair runs need, server-side, and nothing else.
 */
export function createTestingManager(options: CreateTestingManagerOptions): TestingManager {
  return createTestingStack(options).testing;
}

/** The testing manager together with the Tool System it reads and runs through. */
export interface TestingStack {
  readonly testing: TestingManager;
  /** The same gated Tool System the manager uses, for read-only inspection. */
  readonly tools: ToolManager;
}

export function createTestingStack(options: CreateTestingManagerOptions): TestingStack {
  const now = options.now ?? (() => new Date());
  // The testing manager's OWN ConnectorManager: the read-only
  // /api/connectors surface can never be affected by this wiring.
  const connectors = new ConnectorManager({ now });
  connectors.register(createMockConnector({ now }));
  connectors.configure('mock');
  const tools = options.tools ?? createToolManager(now, options.sandboxes, connectors);

  const projectTools = createProjectTools(options.projectEngine, options.runScopes);
  for (const definition of projectTools.definitions) {
    tools.register(definition);
  }
  for (const implementation of projectTools.implementations) {
    tools.registerImplementation(implementation);
  }
  // Explicit, minimal, server-side grants - nothing the run itself can add.
  // Testing needs its four bound tools; repair runs ride the Coding Agent
  // over the SAME Tool System instance, so those tool ids are granted too.
  const requiredToolIds = [...Object.values(TESTING_TOOL_IDS), ...Object.values(CODING_TOOL_IDS)];
  for (const toolId of requiredToolIds) {
    if (!tools.has(toolId)) continue;
    const inspection = tools.inspect(toolId);
    for (const permission of inspection.requiredPermissions) {
      tools.grantPermission(toolId, permission);
    }
  }

  const testing = new TestingManager({
    tools,
    debugAgent: options.debugAgent ?? createDemoDebugAgent(),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { testing, tools };
}
