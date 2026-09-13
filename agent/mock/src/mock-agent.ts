import {
  AgentModelError,
  DefaultAgent,
  type AgentDecision,
  type AgentContext,
  type DecisionSource,
} from '@veltravia/agent-core';
import type { ToolManager } from '@veltravia/tool-core';

/**
 * A deterministic, offline, credential-free scripted decision source. Each
 * decide() returns the next scripted raw value; the agent loop re-parses
 * and re-validates it exactly like real model output - so scripts can also
 * deliver MALFORMED values to test the validation path.
 */
export class ScriptedDecisionSource implements DecisionSource {
  private cursor = 0;

  constructor(
    private readonly script: readonly unknown[],
    private readonly onExhausted: () => Error = () =>
      new AgentModelError('the scripted decision source was exhausted'),
  ) {}

  async decide(_context: AgentContext): Promise<AgentDecision> {
    if (this.cursor >= this.script.length) {
      throw this.onExhausted();
    }
    const value = this.script[this.cursor];
    this.cursor += 1;
    return value as AgentDecision;
  }

  /** How many script entries have been consumed (test aid). */
  get consumed(): number {
    return this.cursor;
  }
}

export interface MockAgentOptions {
  /** Agent id. Default "agent.mock". */
  readonly id?: string;
  /** The scripted decisions, in order (raw values - malformed ones allowed). */
  readonly script: readonly unknown[];
  /** The Tool System the agent routes through. */
  readonly tools: ToolManager;
  readonly displayName?: string;
  readonly description?: string;
}

/** Creates a fully functional DefaultAgent driven by a deterministic script. */
export function createMockAgent(options: MockAgentOptions): DefaultAgent {
  return new DefaultAgent({
    id: options.id ?? 'agent.mock',
    displayName: options.displayName ?? 'Mock Agent',
    description:
      options.description ??
      'Deterministic, offline mock agent for tests and CI. Talks to no model and no external service.',
    decisions: new ScriptedDecisionSource(options.script),
    tools: options.tools,
  });
}

/** Demo scripts used by the API's development-only agents. */
export const DEMO_SCRIPTS = {
  /** Answers directly. */
  directAnswer: (): readonly unknown[] => [
    { type: 'answer', output: 'Veltravia AI is a platform for building software with AI.' },
  ],
  /** Requests the mock summarizer, then answers with its result. */
  toolThenAnswer: (): readonly unknown[] => [
    {
      type: 'request_tool',
      toolId: 'mock.summarize',
      input: { items: ['Veltravia', 'AI'] },
      summary: 'Summarize the product words',
    },
    { type: 'answer', output: 'Tool ran: see the recorded result.' },
  ],
} as const;
