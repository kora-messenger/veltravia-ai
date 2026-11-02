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
  /**
   * Set when a different connection answered because the first one could not.
   * The engine keeps reporting providerId/modelId of whoever actually replied,
   * so nothing is silently substituted.
   */
  readonly fallback?: ProviderFallbackNote;
}

export interface ProviderFallbackNote {
  /** The connection that was tried first and refused. */
  readonly fromProviderId: string;
  readonly fromModelId: string;
  /** Why it was skipped, in the gateway's own words. */
  readonly reason: string;
  /** How many connections were tried in total, including the one that answered. */
  readonly attempts: number;
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

export interface ProviderFallback {
  readonly connectionId: string;
  readonly modelId: string;
  /** The provider behind the connection, for an honest "skipped X" note. */
  readonly providerId?: string;
}

export interface GatewayProviderOptions {
  readonly gateway: AIProviderGateway;
  readonly scope: GatewayScope;
  /** Explicit connection, otherwise the owner's preference decides. */
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly temperature?: number;
  /**
   * Tried in order when the first connection cannot serve: a spent balance, a
   * rate limit, an unreachable provider or a rejected key. Bounded, and every
   * attempt is reported back through `fallback` so the answer never claims a
   * provider that did not answer.
   */
  /** The provider behind `connectionId`, so a skipped note can name it. */
  readonly primaryProviderId?: string;
  readonly fallbacks?: readonly ProviderFallback[];
  /** Hard ceiling on how many alternatives may be tried. Defaults to 2. */
  readonly maxFallbacks?: number;
}

/**
 * Which failures are worth another provider's time.
 *
 * A malformed request is not: every provider would reject it the same way, so
 * retrying only multiplies the bill. Everything else here is about capacity or
 * configuration of the one connection that was picked.
 */
export function canFailOver(error: ReasoningError): boolean {
  switch (error.code) {
    case 'REASONING_PROVIDER_RATE_LIMITED':
    case 'REASONING_PROVIDER_TIMEOUT':
    case 'REASONING_PROVIDER_UNAVAILABLE':
    case 'REASONING_PROVIDER_AUTH_FAILED':
      return true;
    case 'REASONING_PROVIDER_ERROR': {
      const gatewayCode = error.details?.gatewayCode;
      return (
        gatewayCode === 'GATEWAY_LIMIT_EXCEEDED' ||
        gatewayCode === 'GATEWAY_RATE_LIMITED' ||
        gatewayCode === 'GATEWAY_MODEL_UNKNOWN' ||
        gatewayCode === 'GATEWAY_PROVIDER_UNAVAILABLE' ||
        gatewayCode === 'GATEWAY_PROVIDER_ERROR' ||
        gatewayCode === 'GATEWAY_TIMEOUT'
      );
    }
    default:
      return false;
  }
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
  /**
   * The connection that answered last time, once a fallback was used.
   *
   * A run makes several calls (classify, plan, answer, wording). Without this,
   * every one of them pays the same dead-key failure first: seven rejected
   * requests in one measured chat turn. The provider stays on whichever key
   * actually serves the run.
   */
  private serving?: ProviderFallback;

  constructor(options: GatewayProviderOptions) {
    this.options = options;
  }

  /** The primary connection followed by the bounded fallbacks, deduplicated. */
  private candidates(): readonly (ProviderFallback | undefined)[] {
    const primary: ProviderFallback | undefined = this.options.connectionId
      ? { connectionId: this.options.connectionId, modelId: this.options.modelId ?? '' }
      : undefined;
    const limit = Math.max(0, Math.min(this.options.maxFallbacks ?? 2, 5));
    const seen = new Set<string>();
    const order: (ProviderFallback | undefined)[] = [];
    const serving = this.serving;
    if (serving && serving.connectionId !== primary?.connectionId) {
      order.push(serving);
      seen.add(serving.connectionId);
    }
    if (primary) {
      order.push(primary);
      seen.add(primary.connectionId);
    }
    const extras: ProviderFallback[] = [];
    for (const candidate of this.options.fallbacks ?? []) {
      if (extras.length >= limit) break;
      if (seen.has(candidate.connectionId)) continue;
      if (candidate.modelId === '') continue;
      seen.add(candidate.connectionId);
      extras.push(candidate);
    }
    // With no explicit connection the gateway resolves the owner's preference
    // itself, so that "default" attempt must still be made: an empty chain
    // would fail a run that has a perfectly good default connection.
    if (order.length === 0) return [undefined, ...extras];
    return [...order, ...extras];
  }

  private requestPayload(request: ProviderRequest, candidate?: ProviderFallback) {
    return {
      messages: request.messages,
      system: request.system,
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature ?? this.options.temperature ?? 0.2,
      requiredCapabilities: ['text-generation'] as const,
      ...(candidate?.connectionId ? { connectionId: candidate.connectionId } : {}),
      ...(candidate?.modelId ? { modelId: candidate.modelId } : {}),
      ...(this.options.scope.projectId ? { projectId: this.options.scope.projectId } : {}),
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResult> {
    throwIfAborted(request.signal);
    const chain = this.candidates();
    let outcome: GenerationOutcome | undefined;
    let skipped: { providerId: string; modelId: string; reason: string } | undefined;
    let attempts = 0;
    let lastError: ReasoningError | undefined;
    for (const candidate of chain) {
      throwIfAborted(request.signal);
      attempts += 1;
      try {
        outcome = await this.options.gateway.generate(
          this.options.scope,
          this.requestPayload(request, candidate),
        );
        if (candidate && candidate.connectionId !== this.options.connectionId) {
          this.serving = candidate;
        }
        break;
      } catch (error) {
        const mapped = toReasoningProviderError(error);
        lastError = mapped;
        // Only a capacity or configuration failure is worth another provider.
        // A malformed request would fail everywhere, so it is reported at once.
        if (!canFailOver(mapped) || attempts >= chain.length) throw mapped;
        skipped ??= {
          providerId:
            candidate?.providerId ??
            (candidate?.connectionId === this.options.connectionId
              ? (this.options.primaryProviderId ?? 'the selected connection')
              : 'the selected connection'),
          modelId: candidate?.modelId ?? '',
          reason: mapped.message,
        };
      }
    }
    if (!outcome)
      throw lastError ?? new ReasoningError('REASONING_PROVIDER_ERROR', 'The AI provider failed.');
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
      ...(skipped && attempts > 1
        ? {
            fallback: {
              fromProviderId: skipped.providerId,
              fromModelId: skipped.modelId,
              reason: skipped.reason,
              attempts,
            },
          }
        : {}),
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
