import { GoogleGenAI } from '@google/genai';
import {
  AIConfigurationError,
  InvalidAIRequestError,
  type AIModelInfo,
  type AIProvider,
  type AIRequest,
  type AIResponse,
} from '@veltravia/ai-core';
import { isGeminiAvailable, type GeminiConfig } from './config.js';
import {
  fromGeminiInteraction,
  toGeminiInteraction,
  type GeminiCreateInteraction,
  type GeminiInteractionResult,
} from './mapping.js';
import { normalizeGeminiError } from './errors.js';

/**
 * GeminiAIProvider - Veltravia AI's adapter for Google's Gemini models via
 * the CURRENT official Interactions API (ai.interactions.create; the legacy
 * generateContent API is intentionally NOT used).
 *
 * This package is the ONLY place in the entire platform that imports the
 * Gemini SDK. The AI Core, the router, the API route, and the web app only
 * ever see the normalized AIProvider interface.
 */

/**
 * Minimal structural view of the SDK client, so tests can inject fakes
 * without depending on the SDK at all. The real GoogleGenAI client satisfies
 * this shape structurally.
 */
export interface GeminiClientLike {
  readonly interactions: {
    create(params: unknown): Promise<GeminiInteractionResult & { output_text?: string }>;
  };
}

export interface GeminiAIProviderOptions {
  /** Adapter configuration; the API key is read here and nowhere else. */
  readonly config: GeminiConfig;
  /** Injectable SDK client (tests pass a fake; production builds a GoogleGenAI). */
  readonly client?: GeminiClientLike;
  /** Clock for timestamps; defaults to the real time. */
  readonly now?: () => Date;
}

export class GeminiAIProvider implements AIProvider {
  readonly id = 'gemini';
  readonly displayName = 'Google Gemini (Interactions API)';

  private readonly config: GeminiConfig;
  private readonly client: GeminiClientLike;
  private readonly now: () => Date;

  constructor(options: GeminiAIProviderOptions) {
    if (!isGeminiAvailable(options.config)) {
      throw new AIConfigurationError(
        'Gemini provider requires GEMINI_API_KEY (and GEMINI_ENABLED=true) - check the server environment',
      );
    }
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.client =
      options.client ??
      new GoogleGenAI({
        apiKey: this.config.apiKey,
        httpOptions: { timeout: this.config.requestTimeoutMs },
      });
  }

  async send(request: AIRequest, model: AIModelInfo): Promise<AIResponse> {
    // A provider must never trust its caller: reject requests with no
    // non-system turn before touching the network.
    const hasConversationTurn = request.messages.some(
      (message) => message.role === 'user' || message.role === 'assistant',
    );
    if (!hasConversationTurn) {
      throw new InvalidAIRequestError('Gemini requires at least one user or assistant message', {
        details: { providerId: this.id },
      });
    }

    const body: GeminiCreateInteraction = toGeminiInteraction(
      request,
      model,
      this.config,
      // Future stateful-conversation hook (see mapping.ts) - deliberately
      // unset while Veltravia remains stateless per request.
      { previousInteractionId: readPreviousInteractionId(model) },
    );

    try {
      const interaction = await this.client.interactions.create(body);
      return fromGeminiInteraction(interaction, model, interaction.output_text, this.now);
    } catch (error) {
      // All failures leave the adapter as normalized, key-scrubbed AIErrors.
      throw normalizeGeminiError(error, this.config.apiKey);
    }
  }
}

/**
 * Optional server-side conversation state hook. A stored Gemini interaction id
 * can be attached to a registry entry's metadata by a future session manager;
 * the adapter forwards it as previous_interaction_id. This keeps Gemini's
 * stateful mode opt-in WITHOUT forcing Gemini conversation concepts onto the
 * provider-neutral AIRequest or the AI Core.
 */
function readPreviousInteractionId(model: AIModelInfo): string | undefined {
  const raw = model.metadata?.previousInteractionId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
