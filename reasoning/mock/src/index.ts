/**
 * The deterministic offline reasoning provider. Every response is scripted and
 * every result declares `simulated: true` and `live: false`, so the engine (and
 * every screen built on it) can say plainly that no AI model was involved.
 *
 * It exists for automated tests and for development without a key. It is never
 * presented as real reasoning.
 */

import type {
  ProviderChunk,
  ProviderRequest,
  ProviderResult,
  ReasoningProvider,
} from '@veltravia/reasoning-core';

export interface ScriptedReply {
  readonly content: string;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  /** Simulate a failure instead of answering. */
  readonly fail?: { readonly message: string };
}

export interface SimulatedProviderOptions {
  /**
   * Replies in order. When a request arrives with no scripted reply left, the
   * provider answers from `defaultContent`.
   */
  readonly replies?: readonly ScriptedReply[];
  readonly providerId?: string;
  readonly modelId?: string;
  readonly defaultContent?: string;
  /** Echo whatever step the system prompt names (useful for smoke runs). */
  readonly echoStep?: boolean;
  /**
   * Answer each pipeline step in the shape that step requires, so an unscripted
   * provider can drive a complete run. The answer still says plainly that no
   * model was called.
   */
  readonly respondToStep?: boolean;
  readonly onRequest?: (request: ProviderRequest) => void;
}

const STEP_LABELS = ['classify', 'plan', 'answer', 'final answer'] as const;

function stepName(system: string): string {
  if (/step 1: classify/i.test(system)) return 'classify';
  if (/step 2: plan/i.test(system)) return 'plan';
  if (/step 4: write the final answer/i.test(system)) return 'final';
  if (/step 3: answer/i.test(system)) return 'answer';
  return 'unknown';
}

const SIMULATED_NOTICE = 'No AI model was called.';

/** Extracts the task line from a step prompt so the echo quotes the real task. */
function taskOf(user: string): string {
  const match = /Task:\n([\s\S]*?)(?:\n\n|$)/.exec(user);
  const raw = (match?.[1] ?? '').trim();
  if (raw.length === 0) return 'the requested task';
  return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
}

/**
 * A protocol-shaped reply for one pipeline step. Used when no scripted reply is
 * queued: the run completes and proves the loop, and the answer states that it is
 * a simulation rather than pretending to be model output.
 */
function stepReply(step: string, user: string, fallback: string): string {
  switch (step) {
    case 'classify':
      return JSON.stringify({
        taskType: 'question',
        needsTools: false,
        rationale: 'Simulated classification: answered without consulting platform data.',
      });
    case 'plan':
      return JSON.stringify({ goal: 'Answer from the supplied context.', steps: [] });
    case 'answer':
      return JSON.stringify({
        type: 'answer',
        answer: `Simulated result for: ${taskOf(user)} This run demonstrates the reasoning loop; ${SIMULATED_NOTICE} Connect a provider for a real answer.`,
        complete: true,
        summary: 'Simulated run completed without a model.',
      });
    case 'final':
      return `Simulated result for: ${taskOf(user)} This run demonstrates the reasoning loop; ${SIMULATED_NOTICE} Connect a provider for a real answer.`;
    default:
      return fallback;
  }
}

/**
 * A scripted provider. It is a real implementation of the provider port - the
 * engine drives it exactly as it drives the gateway - but it never talks to a
 * model.
 */
export class SimulatedReasoningProvider implements ReasoningProvider {
  readonly id: string;
  readonly live = false;
  readonly streams = true;
  private readonly queue: ScriptedReply[];
  private readonly modelId: string;
  private readonly defaultContent: string;
  private readonly echoStep: boolean;
  private readonly respondToStep: boolean;
  private readonly onRequest?: (request: ProviderRequest) => void;
  /** Every request the engine made, for assertions. */
  readonly requests: ProviderRequest[] = [];

  constructor(options: SimulatedProviderOptions = {}) {
    this.id = options.providerId ?? 'simulated';
    this.modelId = options.modelId ?? 'simulated-reasoner';
    this.queue = [...(options.replies ?? [])];
    this.defaultContent = options.defaultContent ?? 'Simulated answer. No AI model was called.';
    this.echoStep = options.echoStep ?? false;
    this.respondToStep = options.respondToStep ?? false;
    if (options.onRequest !== undefined) this.onRequest = options.onRequest;
  }

  /** Number of replies that have not been consumed yet. */
  get remaining(): number {
    return this.queue.length;
  }

  private next(request: ProviderRequest): ProviderResult {
    this.requests.push(request);
    this.onRequest?.(request);
    const scripted = this.queue.shift();
    if (scripted?.fail !== undefined) {
      throw new Error(scripted.fail.message);
    }
    const content =
      scripted?.content ??
      (this.respondToStep
        ? stepReply(
            stepName(request.system),
            request.messages.map((message) => message.content).join('\n'),
            this.defaultContent,
          )
        : this.echoStep
          ? `Simulated ${stepName(request.system)} response.`
          : this.defaultContent);
    return {
      content,
      providerId: this.id,
      modelId: this.modelId,
      inputTokens: scripted?.inputTokens ?? null,
      outputTokens: scripted?.outputTokens ?? null,
      latencyMs: 1,
      live: false,
      simulated: true,
      finishReason: 'stop',
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResult> {
    return this.next(request);
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const result = this.next(request);
    const words = result.content.split(/(\s+)/).filter((word: string) => word.length > 0);
    if (words.length === 0) {
      yield { delta: '', done: true };
      return;
    }
    for (const [index, word] of words.entries()) {
      yield { delta: word, done: index === words.length - 1 };
    }
  }
}

/** Convenience: a provider scripted for one classify → plan → answer → final run. */
export function scriptedSingleToolRun(options: {
  readonly taskType?: string;
  readonly toolId?: string;
  readonly input?: Record<string, unknown>;
  readonly draft?: string;
  readonly finalAnswer?: string;
}): SimulatedReasoningProvider {
  return new SimulatedReasoningProvider({
    replies: [
      {
        content: JSON.stringify({
          taskType: options.taskType ?? 'research',
          needsTools: options.toolId !== undefined,
          rationale: 'The task needs project data.',
        }),
      },
      {
        content: JSON.stringify({
          goal: 'Read the project data needed to answer.',
          steps: [
            {
              intent: 'Read the relevant project data.',
              toolId: options.toolId ?? null,
              input: options.input ?? {},
            },
          ],
        }),
      },
      {
        content: JSON.stringify({
          type: 'answer',
          answer: options.draft ?? 'The project contains the requested data.',
          complete: true,
          summary: 'Answered from the tool result.',
        }),
      },
      { content: options.finalAnswer ?? 'Here is the answer, based on the tool result.' },
    ],
  });
}

export { STEP_LABELS };
