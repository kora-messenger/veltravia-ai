import {
  InvalidAIRequestError,
  resolveAIConfig,
  type AIModelInfo,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIUsage,
  validateAIRequest,
} from '@veltravia/ai-core';

/**
 * The mock provider: a fully deterministic, offline implementation of the
 * Veltravia AI provider interface. It lets the entire AI Core (registry,
 * router, errors, API endpoint) be tested without any external service and
 * without an API key.
 */

/** Deterministic timestamp used when no clock is injected. */
const FIXED_CLOCK = new Date('2026-01-01T00:00:00.000Z');

/** Rough token estimate: 4 characters per token. Deterministic by design. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Small deterministic string hash (djb2) for stable request ids. */
function stableHash(text: string): string {
  let hash = 5381;
  for (const char of text) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export interface MockProviderOptions {
  /** Clock for `generatedAt`; defaults to a fixed instant for determinism. */
  readonly now?: () => Date;
  /** Defaults to 'mock'. Override only for tests that need distinct providers. */
  readonly id?: string;
}

export class MockAIProvider implements AIProvider {
  readonly id: string;
  readonly displayName = 'Mock Provider';

  private readonly now: () => Date;

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.now = options.now ?? (() => FIXED_CLOCK);
  }

  async send(request: AIRequest, model: AIModelInfo): Promise<AIResponse> {
    // Defensive: a provider must never trust its caller.
    validateAIRequest(
      request,
      resolveAIConfig({ maxInputMessages: 1000, maxInputChars: 1_000_000 }),
    );

    const lastUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === 'user');
    if (lastUserMessage === undefined) {
      throw new InvalidAIRequestError('Request must contain at least one user message', {
        details: { providerId: this.id },
      });
    }

    const echo = lastUserMessage.content;
    const content = request.structuredOutput
      ? JSON.stringify({ [request.structuredOutput.name]: `mock:${echo}` })
      : `MOCK[${model.modelId}]: ${echo}`;

    const inputText = (request.system ?? '') + request.messages.map((m) => m.content).join('');
    const usage: AIUsage = {
      inputTokens: estimateTokens(inputText),
      outputTokens: estimateTokens(content),
      totalTokens: estimateTokens(inputText) + estimateTokens(content),
    };

    return {
      content,
      providerId: this.id,
      modelId: model.modelId,
      usage,
      finishReason: 'stop',
      requestId: `mock-${stableHash(`${this.id}:${model.modelId}:${content}`)}`,
      generatedAt: this.now().toISOString(),
    };
  }
}

/**
 * Ready-made mock model definitions for the registry. Capability variety is
 * deliberate: it exercises the router's capability filtering in tests and
 * the API integration, without pretending to be a real model catalogue.
 */
export function createMockModels(): AIModelInfo[] {
  return [
    {
      providerId: 'mock',
      modelId: 'mock-text-small',
      displayName: 'Mock Text Small',
      capabilities: ['text-generation'],
      available: true,
    },
    {
      providerId: 'mock',
      modelId: 'mock-text-pro',
      displayName: 'Mock Text Pro',
      capabilities: ['text-generation', 'structured-output', 'code-generation', 'large-context'],
      contextWindowTokens: 128_000,
      available: true,
    },
    {
      providerId: 'mock',
      modelId: 'mock-multimodal',
      displayName: 'Mock Multimodal',
      capabilities: ['text-generation', 'vision', 'streaming', 'tool-calling'],
      available: true,
    },
    {
      providerId: 'mock',
      modelId: 'mock-embed',
      displayName: 'Mock Embeddings',
      capabilities: ['embeddings'],
      available: true,
    },
  ];
}
