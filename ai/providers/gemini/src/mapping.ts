import type {
  AIFinishReason,
  AIRequest,
  AIResponse,
  AIUsage,
  AIModelInfo,
} from '@veltravia/ai-core';
import { AIProviderError } from '@veltravia/ai-core';
import type { GeminiConfig } from './config.js';

/**
 * The mapping layer: the ONLY code that translates between Veltravia's
 * provider-neutral request/response formats and Gemini's Interactions API
 * format. Gemini SDK types never leave this package.
 *
 * Flow:
 *   Veltravia AIRequest  -> toGeminiInteraction()  -> Gemini Interactions API
 *   Gemini response      -> fromGeminiInteraction() -> Veltravia AIResponse
 */

// ---------------------------------------------------------------------------
// Structural views over the Gemini Interactions API shapes.
// The real SDK objects satisfy these interfaces structurally; tests inject
// fakes that satisfy them too. Only the fields the adapter actually reads
// are declared.
// ---------------------------------------------------------------------------

/** A single text content block in a step. */
export interface GeminiTextContent {
  readonly type: 'text';
  readonly text: string;
}

/** One execution step in an interaction. */
export interface GeminiStep {
  readonly type: 'user_input' | 'model_output' | 'thought' | string;
  readonly content?: readonly (GeminiTextContent | { readonly type: string })[];
  readonly status?: string;
}

/** The subset of the Interaction resource the adapter consumes. */
export interface GeminiInteractionResult {
  readonly id?: string;
  readonly status?: string;
  readonly steps?: readonly GeminiStep[];
  readonly usage?: {
    readonly total_input_tokens?: number;
    readonly total_output_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly created?: string;
  readonly updated?: string;
}

/** Body shape for interactions.create, mirroring the official REST/SDK schema. */
export interface GeminiCreateInteraction {
  readonly model: string;
  readonly input: string | readonly GeminiStep[];
  readonly system_instruction?: string;
  readonly generation_config?: Record<string, unknown>;
  readonly response_format?: { type: 'text'; mime_type: string; schema?: unknown };
  readonly store?: boolean;
  readonly previous_interaction_id?: string;
}

// ---------------------------------------------------------------------------
// Request mapping: Veltravia AIRequest -> Gemini interactions.create body
// ---------------------------------------------------------------------------

/**
 * A future-proofing hook for Gemini's optional server-side conversation
 * state. The provider-neutral AIRequest deliberately has no Gemini-specific
 * conversation concept; when stateful multi-turn conversations arrive, the
 * adapter (or a future session manager) can pass a stored interaction id
 * here WITHOUT changing the AI Core, the router, or the public API.
 */
export interface GeminiRequestOptions {
  readonly previousInteractionId?: string;
}

function textStep(type: 'user_input' | 'model_output', text: string): GeminiStep {
  return { type, content: [{ type: 'text', text }] };
}

/**
 * Maps a normalized AIRequest to the Gemini Interactions API create body.
 *
 * - system messages and `request.system` merge into `system_instruction`
 *   (Gemini's representation for system-level guidance)
 * - user/assistant messages map to `user_input` / `model_output` steps sent
 *   as the full conversation history (stateless mode - works with any
 *   provider, not just Gemini)
 * - structured output maps to `response_format` with the JSON mime type
 * - temperature/maxOutputTokens map into `generation_config`
 */
export function toGeminiInteraction(
  request: AIRequest,
  model: AIModelInfo,
  config: GeminiConfig,
  options: GeminiRequestOptions = {},
): GeminiCreateInteraction {
  const systemParts: string[] = [];
  const steps: GeminiStep[] = [];

  if (request.system !== undefined && request.system.length > 0) {
    systemParts.push(request.system);
  }
  for (const message of request.messages) {
    switch (message.role) {
      case 'system':
        systemParts.push(message.content);
        break;
      case 'user':
        steps.push(textStep('user_input', message.content));
        break;
      case 'assistant':
        steps.push(textStep('model_output', message.content));
        break;
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (request.maxOutputTokens !== undefined) {
    generationConfig.max_output_tokens = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) {
    // Documented in the official text-generation guide for the Interactions
    // API (`generation_config: { temperature: ... }`). The REST reference
    // schema does not list it yet, so it is passed through as-is; if Gemini
    // ever rejects it, only this line changes.
    generationConfig.temperature = request.temperature;
  }
  if (config.thinkingLevel !== undefined) {
    generationConfig.thinking_level = config.thinkingLevel;
  }

  // Built in a single expression: the interface fields are readonly.
  return {
    model: model.modelId,
    // Stateful mode (previous_interaction_id) replaces the history array in
    // a future step; stateless history keeps Veltravia provider-neutral.
    input: steps,
    store: config.storeInteractions,
    ...(systemParts.length > 0 ? { system_instruction: systemParts.join('\n\n') } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
    ...(request.structuredOutput !== undefined
      ? {
          response_format: {
            type: 'text' as const,
            mime_type: 'application/json',
            schema:
              request.structuredOutput.schema === undefined
                ? undefined
                : (request.structuredOutput.schema as unknown),
          },
        }
      : {}),
    ...(options.previousInteractionId !== undefined
      ? { previous_interaction_id: options.previousInteractionId }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Response mapping: Gemini interaction -> Veltravia AIResponse
// ---------------------------------------------------------------------------

/** Maps Gemini's Usage object to Veltravia's AIUsage. Missing = undefined. */
export function mapGeminiUsage(usage: GeminiInteractionResult['usage']): AIUsage | null {
  if (usage === undefined || usage === null) return null;
  const hasAny =
    usage.total_input_tokens !== undefined ||
    usage.total_output_tokens !== undefined ||
    usage.total_tokens !== undefined;
  if (!hasAny) return null;

  // Never fabricate: only fields Gemini actually reported are populated.
  return {
    inputTokens: usage.total_input_tokens,
    outputTokens: usage.total_output_tokens,
    totalTokens: usage.total_tokens,
  };
}

/** Maps the interaction status to Veltravia's normalized finish reason. */
export function mapFinishReason(status: string | undefined): AIFinishReason {
  switch (status) {
    case 'completed':
      return 'stop';
    case 'incomplete':
    case 'budget_exceeded':
      return 'length';
    case 'failed':
    case 'cancelled':
      return 'error';
    case 'requires_action':
    case 'in_progress':
    case 'queued':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Extracts the model's textual output from the interaction steps: the text
 * content of every model_output step, joined with newlines. Falls back to
 * the SDK's output_text convenience property when steps are absent.
 */
export function extractOutputText(
  interaction: GeminiInteractionResult,
  outputTextFallback?: string,
): string {
  const modelOutputs: string[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const content of step.content ?? []) {
      if (content.type === 'text' && 'text' in content) {
        modelOutputs.push(content.text);
      }
    }
  }
  if (modelOutputs.length > 0) return modelOutputs.join('\n');
  return outputTextFallback ?? '';
}

/**
 * Maps a Gemini interaction result to Veltravia's normalized AIResponse.
 * Throws AIProviderError (malformed) when the response has no usable output
 * or no id - malformed provider responses must never silently pass.
 */
export function fromGeminiInteraction(
  interaction: GeminiInteractionResult,
  model: AIModelInfo,
  outputTextFallback: string | undefined,
  now: () => Date,
): AIResponse {
  const requestId = interaction.id;
  if (requestId === undefined || requestId === '') {
    throw new AIProviderError('Gemini response is missing an interaction id', {
      details: { malformed: true, retryable: false },
    });
  }

  const content = extractOutputText(interaction, outputTextFallback);
  if (content.length === 0) {
    throw new AIProviderError('Gemini response contains no model output', {
      details: {
        malformed: true,
        retryable: false,
        status: interaction.status,
        stepTypes: (interaction.steps ?? []).map((step) => step.type),
      },
    });
  }

  if (interaction.status === 'failed' || interaction.status === 'cancelled') {
    throw new AIProviderError(`Gemini interaction ${interaction.status}`, {
      details: { retryable: false, status: interaction.status },
    });
  }

  return {
    content,
    providerId: 'gemini',
    modelId: model.modelId,
    usage: mapGeminiUsage(interaction.usage),
    finishReason: mapFinishReason(interaction.status),
    requestId,
    generatedAt: interaction.created ?? interaction.updated ?? now().toISOString(),
  };
}
