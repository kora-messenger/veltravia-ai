import { AgentManager } from '@veltravia/agent-core';
import { createMockAgent, DEMO_SCRIPTS } from '@veltravia/agent-mock';

import { createToolManager } from './tools.js';
import type { ApiIntegrationSystem } from './integrations.js';
import { mockDatabaseConnector, mockStorageConnector } from '@veltravia/integration-mocks';

/**
 * Builds the API's AgentManager.
 *
 * DEVELOPMENT-ONLY LIMITATION (documented in docs/agents.md): the demo
 * agents run on deterministic, offline scripted decision sources - no real
 * model is wired into the API yet, because wiring one requires prompt tuning
 * that belongs to a later step. The orchestration, gates, confirmation
 * flow, limits, and audit are fully real: swapping the scripted source for
 * a ModelDecisionSource (AI Core + a real provider) changes nothing else.
 *
 * Runs are in-memory (no persistent job queues in Step 6) and the endpoints
 * carry no authentication beyond the app's current boundary.
 */
export function createAgentManager(
  now: () => Date = () => new Date(),
  integrations?: ApiIntegrationSystem,
): AgentManager {
  // Step 12: the multi-connector integration connectors + execution seam
  // ride the SAME Tool System pipeline. The ConnectorManager authorizes,
  // the integration runtime executes, and no connector-specific agent code
  // exists anywhere.
  const integrationWiring =
    integrations !== undefined
      ? {
          connectors: [mockStorageConnector(now), mockDatabaseConnector(now)],
          connectorExecutor: integrations.connectorExecutor(),
        }
      : undefined;
  const tools = createToolManager(now, undefined, undefined, integrationWiring);
  // The demo tool agents may actually execute the (harmless, offline) mock tools.
  tools.grantPermission('mock.summarize', 'mock.read');
  tools.grantPermission('mock.purge', 'mock.admin');

  let storageConnectionId: string | undefined;
  if (integrations !== undefined) {
    integrations.registerAgentTools(tools);
    storageConnectionId = integrations.demoConnections['mock-storage']?.connectionId;
  }

  const manager = new AgentManager({ tools, now });
  manager.register(
    createMockAgent({
      id: 'agent.demo',
      displayName: 'Demo Tool Agent',
      description:
        'Development-only agent: requests the offline mock summarizer, then answers. Fully gated and limited; scripted, no real model.',
      script: DEMO_SCRIPTS.toolThenAnswer(),
      tools,
    }),
  );
  manager.register(
    createMockAgent({
      id: 'agent.demo.answer',
      displayName: 'Demo Answer Agent',
      description:
        'Development-only agent: answers directly without tools. Scripted, no real model.',
      script: DEMO_SCRIPTS.directAnswer(),
      tools,
    }),
  );
  // Step 12: this demo agent proves an agent can discover and invoke a
  // connector tool with NO connector-specific agent code - the script only
  // carries a tool id, a connection id, and plain input.
  if (storageConnectionId !== undefined) {
    manager.register(
      createMockAgent({
        id: 'agent.demo.storage',
        displayName: 'Demo Storage Agent',
        description:
          'Development-only agent: writes then reads one object through the offline mock-storage integration. Scripted, no real model.',
        script: [
          {
            type: 'request_tool',
            toolId: 'storage.object.put',
            input: {
              key: 'demo/agent-notes.txt',
              content: 'Written by the demo storage agent through the integration runtime.',
              connectionId: storageConnectionId,
            },
            summary: 'Store a demo object through the mock-storage integration',
          },
          {
            type: 'request_tool',
            toolId: 'storage.object.get',
            input: { key: 'demo/agent-notes.txt', connectionId: storageConnectionId },
            summary: 'Read the demo object back through the same connection',
          },
          {
            type: 'answer',
            output:
              'Stored and re-read the demo object through the offline mock-storage integration. The recorded tool results are in the activity panel.',
          },
        ],
        tools,
      }),
    );
  }
  // Development-only confirmation demo: requests the existing critical-risk
  // mock tool, whose invocation the framework pauses for a human decision
  // (the run resumes only through the confirmation endpoint), then answers.
  manager.register(
    createMockAgent({
      id: 'agent.demo.confirm',
      displayName: 'Demo Confirmation Agent',
      description:
        'Development-only agent: requests the critical-risk offline mock tool and waits for a human approval or rejection. Scripted, no real model.',
      script: [
        {
          type: 'request_tool',
          toolId: 'mock.purge',
          input: { confirmLabel: 'offline demo' },
          summary: 'Run the offline critical-risk demo tool',
        },
        {
          type: 'answer',
          output: 'The demo tool finished. Its recorded result is in the activity panel.',
        },
      ],
      tools,
    }),
  );
  return manager;
}
