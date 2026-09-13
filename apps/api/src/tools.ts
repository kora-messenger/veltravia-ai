import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import { ToolManager } from '@veltravia/tool-core';
import { createConnectorBackedMockTool, createMockSummarizeTool } from '@veltravia/tool-mock';

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
export function createToolManager(now: () => Date = () => new Date()): ToolManager {
  const connectors = new ConnectorManager({ now });
  connectors.register(createMockConnector({ now }));
  connectors.configure('mock');

  const manager = new ToolManager({ now, connectors });
  const summarize = createMockSummarizeTool();
  manager.register(summarize.definition);
  manager.registerImplementation(summarize.implementation);
  manager.register(createConnectorBackedMockTool());
  return manager;
}
