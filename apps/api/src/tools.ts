import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import type { SandboxManager } from '@veltravia/sandbox-core';
import { ToolManager } from '@veltravia/tool-core';
import {
  createConnectorBackedMockTool,
  createMockPurgeTool,
  createMockSummarizeTool,
} from '@veltravia/tool-mock';
import { createSandboxTools } from './sandboxes.js';

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
export function createToolManager(
  now: () => Date = () => new Date(),
  sandboxes?: SandboxManager,
  /** Existing ConnectorManager to share (e.g. the coding manager's own). */
  existingConnectors?: ConnectorManager,
): ToolManager {
  const connectors = existingConnectors ?? new ConnectorManager({ now });
  if (existingConnectors === undefined) {
    connectors.register(createMockConnector({ now }));
    connectors.configure('mock');
  }

  const manager = new ToolManager({ now, connectors });
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
  return manager;
}
