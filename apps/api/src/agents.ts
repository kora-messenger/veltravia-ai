import { AgentManager } from '@veltravia/agent-core';
import { createMockAgent, DEMO_SCRIPTS } from '@veltravia/agent-mock';

import { createToolManager } from './tools.js';

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
export function createAgentManager(now: () => Date = () => new Date()): AgentManager {
  const tools = createToolManager(now);
  // The demo tool agents may actually execute the (harmless, offline) mock tools.
  tools.grantPermission('mock.summarize', 'mock.read');
  tools.grantPermission('mock.purge', 'mock.admin');

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
