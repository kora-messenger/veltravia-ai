/**
 * The provider port the reasoning engine speaks. It has exactly one real
 * implementation - the Step 26 gateway - and one offline mock. There is no
 * second provider system here: the gateway owns credentials, routing,
 * preferences, SSRF rules and usage; this file only adapts its interface and
 * normalizes its errors for the engine.
 */

import type { AIMessage } from '@veltravia/ai-core';
import type { AIProviderGateway, GatewayScope, GenerationOutcome } from '@veltravia/ai-gateway';
import { isGatewayError } from '@veltravia/ai-gateway';

import { ReasoningError, isReasoningError, scrubReasoningText } from './errors.js';

export interface ProviderRequest {
  readonly system: string;
  readonly messages: readonly AIMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** Aborted when the caller cancels the run. */
  readonly signal?: AbortSignal;
}

export interface ProviderResult {
  readonly content: string;
  /** Which provider/model actually answered. Shown to the user verbatim. */
  readonly providerId: string;
  readonly modelId: string;
  readonly connectionId?: string;
  /** Tokens as reported by the provider, or null. Never estimated. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  /** True only when a real provider answered over the network. */
  readonly live: boolean;
  /** True when this is a deterministic mock. Never presented as real AI. */
  readonly simulated: boolean;
  readonly finishReason: string;
}

export interface ProviderChunk {
  readonly delta: string;
  readonly done: boolean;
}

export interface ReasoningProvider {
  /** Stable identifier, e.g. 'gateway' or 'simulated'. */
  readonly id: string;
  /** False for mocks: the engine surfaces this in every run result. */
  readonly live: boolean;
  /** True when the provider can stream deltas. */
  readonly streams: boolean;
  complete(request: ProviderRequest): Promise<ProviderResult>;
  stream?(request: ProviderRequest): AsyncIterable<ProviderChunk>;
}

/**
 * Maps a gateway failure onto a normalized reasoning failure. The gateway has
 * already scrubbed provider text; this keeps the SAME category names so the
 * audit trail reads the same everywhere.
 */
export function toReasoningProviderError(error: unknown): ReasoningError {
  if (isReasoningError(error)) return error;
  if (isGatewayError(error)) {
    switch (error.code) {
      case 'GATEWAY_AUTH_FAILED':
      case 'GATEWAY_CREDENTIAL_INVALID':
        return new ReasoningError(
          'REASONING_PROVIDER_AUTH_FAILED',
          'The AI provider rejected the stored key.',
          { gatewayCode: error.code },
        );
      case 'GATEWAY_RATE_LIMITED':
        return new ReasoningError(
          'REASONING_PROVIDER_RATE_LIMITED',
          'The AI provider is rate limiting this account.',
          { gatewayCode: error.code },
        );
      case 'GATEWAY_TIMEOUT':
        return new ReasoningError(
          'REASONING_PROVIDER_TIMEOUT',
          'The AI provider did not answer in time.',
          { gatewayCode: error.code },
        );
      case 'GATEWAY_NO_PROVIDER_CONFIGURED':
      case 'GATEWAY_CONNECTION_NOT_FOUND':
      case 'GATEWAY_PROVIDER_UNAVAILABLE':
        return new ReasoningError(
          'REASONING_PROVIDER_UNAVAILABLE',
          'No usable AI provider is connected for this request.',
          { gatewayCode: error.code },
        );
      default:
        return new ReasoningError(
          'REASONING_PROVIDER_ERROR',
          scrubReasoningText(error.message || 'The AI provider returned an error.'),
          { gatewayCode: error.code },
        );
    }
  }
  const message = error instanceof Error ? error.message : 'The AI provider failed.';
  return new ReasoningError('REASONING_PROVIDER_ERROR', scrubReasoningText(message));
}

export interface GatewayProviderOptions {
  readonly gateway: AIProviderGateway;
  readonly scope: GatewayScope;
  /** Explicit connection, otherwise the owner's preference decides. */
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly temperature?: number;
}

/**
 * The real provider: every call goes through the gateway, which resolves the
 * owner-scoped connection, decrypts the credential server-side, enforces the
 * SSRF and capability rules, and records usage. The engine never sees a key.
 */
export class GatewayReasoningProvider implements ReasoningProvider {
  readonly id = 'gateway';
  readonly live = true;
  readonly streams = true;
  private readonly options: GatewayProviderOptions;

  constructor(options: GatewayProviderOptions) {
    this.options = options;
  }

  private requestPayload(request: ProviderRequest) {
    return {
      messages: request.messages,
      system: request.system,
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature ?? this.options.temperature ?? 0.2,
      requiredCapabilities: ['text-generation'] as const,
      ...(this.options.connectionId ? { connectionId: this.options.connectionId } : {}),
      ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
      ...(this.options.scope.projectId ? { projectId: this.options.scope.projectId } : {}),
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResult> {
    throwIfAborted(request.signal);
    let outcome: GenerationOutcome;
    try {
      outcome = await this.options.gateway.generate(
        this.options.scope,
        this.requestPayload(request),
      );
    } catch (error) {
      throw toReasoningProviderError(error);
    }
    return {
      content: outcome.content,
      providerId: outcome.providerId,
      modelId: outcome.modelId,
      connectionId: outcome.connectionId,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      latencyMs: outcome.latencyMs,
      live: outcome.live,
      simulated: false,
      finishReason: outcome.finishReason,
    };
  }

  /**
   * Streams when the provider supports it, and falls back to one complete
   * response when it does not - the caller sees the same chunks either way,
   * and the fallback is reported honestly through `onFallback`.
   */
  async *stream(
    request: ProviderRequest,
    onFallback?: (reason: string) => void,
  ): AsyncIterable<ProviderChunk> {
    throwIfAborted(request.signal);
    const iterator = this.options.gateway.stream(this.options.scope, this.requestPayload(request));
    let yielded = false;
    try {
      for await (const chunk of iterator) {
        throwIfAborted(request.signal);
        if (chunk.delta.length > 0) {
          yielded = true;
          yield { delta: chunk.delta, done: chunk.done };
        }
        if (chunk.done) return;
      }
      if (!yielded) {
        // A stream that produced nothing is not a successful generation.
        throw new ReasoningError(
          'REASONING_PROVIDER_ERROR',
          'The AI provider streamed no content.',
        );
      }
      return;
    } catch (error) {
      const mapped = toReasoningProviderError(error);
      if (mapped.code !== 'REASONING_PROVIDER_ERROR' || yielded) throw mapped;
      // Unsupported streaming, or a provider that refuses to stream at all:
      // answer in one piece rather than failing the run.
      onFallback?.(mapped.message);
      const result = await this.complete(request);
      yield { delta: result.content, done: true };
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new ReasoningError('REASONING_CANCELLED', 'The reasoning run was cancelled.');
  }
}
