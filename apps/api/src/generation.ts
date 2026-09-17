import { createProjectTools } from '@veltravia/coding-agent-core';
import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import { AppGenerationManager } from '@veltravia/generation-core';
import {
  createDecliningRepairSource,
  createDeterministicPlanner,
} from '@veltravia/generation-mock';
import type { ProjectEngine } from '@veltravia/project-core';
import type { SandboxManager } from '@veltravia/sandbox-core';
import type { ToolManager } from '@veltravia/tool-core';

import { createToolManager } from './tools.js';

/** The Tool System tool ids the generation engine binds to. */
const GENERATION_TOOL_IDS = [
  'project.create-file',
  'project.create-directory',
  'project.update-file',
  'project.read-file',
  'sandbox.create',
  'sandbox.execute',
] as const;

export interface CreateGenerationManagerOptions {
  readonly projectEngine: ProjectEngine;
  readonly tools?: ToolManager;
  /** Sandbox manager for registering sandbox tools when no tools manager is injected. */
  readonly sandboxes?: SandboxManager;
  readonly now?: () => Date;
}

/**
 * Builds the API's AppGenerationManager.
 *
 * The generation engine gets its OWN Tool System instance (seeded with the
 * sandbox tools and the project file tools, with explicit server-side grants
 * for exactly the five tools it uses). It never mutates the read-only tool
 * surface - tools registered here do not appear on /api/tools.
 *
 * DEVELOPMENT-ONLY LIMITATION (documented in docs/generation.md): the
 * planner is the deterministic offline mock. Swapping it for an AI-routed
 * GenerationPlanner changes nothing else - the engine re-validates every
 * planner output with the same strict schemas.
 */
export function createGenerationManager(
  options: CreateGenerationManagerOptions,
): AppGenerationManager {
  const now = options.now ?? (() => new Date());
  const connectors = new ConnectorManager({ now });
  connectors.register(createMockConnector({ now }));
  connectors.configure('mock');
  const tools = options.tools ?? createToolManager(now, options.sandboxes, connectors);

  const projectTools = createProjectTools(options.projectEngine);
  for (const definition of projectTools.definitions) {
    tools.register(definition);
  }
  for (const implementation of projectTools.implementations) {
    tools.registerImplementation(implementation);
  }
  // Explicit, minimal, server-side grants - and nothing else. The engine
  // can never grant itself permissions (Step 5 rule).
  for (const toolId of GENERATION_TOOL_IDS) {
    if (!tools.has(toolId)) continue;
    const inspection = tools.inspect(toolId);
    for (const permission of inspection.requiredPermissions) {
      tools.grantPermission(toolId, permission);
    }
  }

  return new AppGenerationManager({
    tools,
    projectEngine: options.projectEngine,
    planner: createDeterministicPlanner({ now }),
    repairSource: createDecliningRepairSource(),
    now,
  });
}
