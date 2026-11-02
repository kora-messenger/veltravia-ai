import { describe, expect, it } from 'vitest';
import {
  GatewayError,
  type AIProviderGateway,
  type GenerationOutcome,
} from '@veltravia/ai-gateway';

import { GatewayReasoningProvider, canFailOver, type ProviderRequest } from './provider.js';
import { ReasoningError } from './errors.js';

/**
 * A gateway stand-in that answers or fails per connection id, so the failover
 * rules can be checked without any network or credential machinery.
 */
function stubGateway(plan: Readonly<Record<string, GenerationOutcome | GatewayError>>) {
  const called: { connectionId: string; modelId: string }[] = [];
  const gateway = {
    generate: async (
      _scope: unknown,
      payload: { connectionId?: string; modelId?: string },
    ): Promise<GenerationOutcome> => {
      const connectionId = payload.connectionId ?? 'preferred';
      called.push({ connectionId, modelId: payload.modelId ?? '' });
      const answer = plan[connectionId];
      if (answer === undefined) {
        throw new GatewayError('GATEWAY_CONNECTION_NOT_FOUND', 'no such connection');
      }
      if (answer instanceof GatewayError) throw answer;
      return answer;
    },
  };
  return { gateway: gateway as unknown as AIProviderGateway, called };
}

function outcome(connectionId: string, modelId: string): GenerationOutcome {
  return {
    content: `answered by ${connectionId}`,
    providerId: connectionId,
    modelId,
    connectionId,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 12,
    live: true,
    finishReason: 'stop',
  } as GenerationOutcome;
}

const request: ProviderRequest = {
  system: 'You are terse.',
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 64,
};

describe('gateway provider failover', () => {
  it('stays on the primary and reports no fallback when it answers', async () => {
    const { gateway, called } = stubGateway({ primary: outcome('openai', 'gpt-4o-mini') });
    const provider = new GatewayReasoningProvider({
      gateway,
      scope: { ownerRef: 'owner' },
      connectionId: 'primary',
      modelId: 'gpt-4o-mini',
      fallbacks: [{ connectionId: 'groq', modelId: 'qwen/qwen3.8-27b', providerId: 'groq' }],
    });

    const result = await provider.complete(request);

    expect(called).toEqual([{ connectionId: 'primary', modelId: 'gpt-4o-mini' }]);
    expect(result.providerId).toBe('openai');
    expect(result.fallback).toBeUndefined();
  });

  it('moves to the next key when the balance is spent, and says who answered', async () => {
    const { gateway, called } = stubGateway({
      primary: new GatewayError('GATEWAY_LIMIT_EXCEEDED', 'no remaining credit', {
        details: { quota: 'exhausted' },
      }),
      groq: outcome('groq', 'qwen/qwen3.8-27b'),
    });
    const provider = new GatewayReasoningProvider({
      gateway,
      scope: { ownerRef: 'owner' },
      connectionId: 'primary',
      modelId: 'gpt-4o-mini',
      primaryProviderId: 'openai',
      fallbacks: [{ connectionId: 'groq', modelId: 'qwen/qwen3.8-27b', providerId: 'groq' }],
    });

    const result = await provider.complete(request);

    expect(called.map((entry) => entry.connectionId)).toEqual(['primary', 'groq']);
    expect(result.content).toBe('answered by groq');
    expect(result.providerId).toBe('groq');
    expect(result.fallback).toEqual({
      fromProviderId: 'openai',
      fromModelId: 'gpt-4o-mini',
      reason: 'no remaining credit',
      attempts: 2,
    });
  });

  it('also moves on when one stored key is rejected outright', async () => {
    const { gateway } = stubGateway({
      primary: new GatewayError('GATEWAY_AUTH_FAILED', 'the provider rejected the API key'),
      groq: outcome('groq', 'qwen/qwen3.8-27b'),
    });
    const provider = new GatewayReasoningProvider({
      gateway,
      scope: { ownerRef: 'owner' },
      connectionId: 'primary',
      modelId: 'gpt-4o-mini',
      primaryProviderId: 'openai',
      fallbacks: [{ connectionId: 'groq', modelId: 'qwen/qwen3.8-27b', providerId: 'groq' }],
    });

    const result = await provider.complete(request);

    expect(result.providerId).toBe('groq');
    expect(result.fallback?.fromProviderId).toBe('openai');
  });

  it('never retries a malformed request on another provider', async () => {
    const { gateway, called } = stubGateway({
      primary: new GatewayError('GATEWAY_INVALID_REQUEST', 'The provider rejected the request.'),
      groq: outcome('groq', 'qwen/qwen3.8-27b'),
    });
    const provider = new GatewayReasoningProvider({
      gateway,
      scope: { ownerRef: 'owner' },
      connectionId: 'primary',
      modelId: 'gpt-4o-mini',
      fallbacks: [{ connectionId: 'groq', modelId: 'qwen/qwen3.8-27b', providerId: 'groq' }],
    });

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'REASONING_PROVIDER_ERROR',
    });
    expect(called.length).toBe(1);
  });

  it('is bounded: two alternatives at most, and never the same connection twice', async () => {
    const { gateway, called } = stubGateway({
      primary: new GatewayError('GATEWAY_RATE_LIMITED', 'slow down'),
      second: new GatewayError('GATEWAY_TIMEOUT', 'too slow'),
      third: new GatewayError('GATEWAY_PROVIDER_UNAVAILABLE', 'down'),
      fourth: outcome('fourth', 'model-d'),
    });
    const provider = new GatewayReasoningProvider({
      gateway,
      scope: { ownerRef: 'owner' },
      connectionId: 'primary',
      modelId: 'model-a',
      fallbacks: [
        { connectionId: 'primary', modelId: 'model-a' },
        { connectionId: 'second', modelId: 'model-b' },
        { connectionId: 'third', modelId: 'model-c' },
        { connectionId: 'fourth', modelId: 'model-d' },
      ],
    });

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'REASONING_PROVIDER_UNAVAILABLE',
    });
    expect(called.map((entry) => entry.connectionId)).toEqual(['primary', 'second', 'third']);
  });

  it('reports the failing reason when nothing can answer', async () => {
    const { gateway } = stubGateway({
      primary: new GatewayError('GATEWAY_LIMIT_EXCEEDED', 'no remaining credit'),
    });
    const provider = new GatewayReasoningProvider({
      gateway,
      scope: { ownerRef: 'owner' },
      connectionId: 'primary',
      modelId: 'model-a',
      fallbacks: [],
    });

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'REASONING_PROVIDER_ERROR',
      message: 'no remaining credit',
    });
  });

  it('classifies which failures are worth another provider', () => {
    const wrap = (gatewayCode: string) =>
      new ReasoningError('REASONING_PROVIDER_ERROR', 'x', { gatewayCode });

    expect(canFailOver(wrap('GATEWAY_LIMIT_EXCEEDED'))).toBe(true);
    expect(canFailOver(wrap('GATEWAY_RATE_LIMITED'))).toBe(true);
    expect(canFailOver(wrap('GATEWAY_MODEL_UNKNOWN'))).toBe(true);
    expect(canFailOver(wrap('GATEWAY_INVALID_REQUEST'))).toBe(false);
    expect(canFailOver(new ReasoningError('REASONING_FORBIDDEN_TOOL', 'x'))).toBe(false);
    expect(canFailOver(new ReasoningError('REASONING_PROVIDER_TIMEOUT', 'x'))).toBe(true);
  });
});

describe('gateway provider failover: sticking to the key that works', () => {
  it('goes straight to the serving connection on the next call in the run', async () => {
    const { gateway, called } = stubGateway({
      primary: new GatewayError('GATEWAY_LIMIT_EXCEEDED', 'no remaining credit'),
      groq: outcome('groq', 'qwen/qwen3.8-27b'),
    });
    const provider = new GatewayReasoningProvider({
      gateway,
      scope: { ownerRef: 'owner' },
      connectionId: 'primary',
      modelId: 'gpt-4o-mini',
      primaryProviderId: 'openai',
      fallbacks: [{ connectionId: 'groq', modelId: 'qwen/qwen3.8-27b', providerId: 'groq' }],
    });

    await provider.complete(request);
    await provider.complete(request);
    await provider.complete(request);

    // One dead-key attempt for the whole run, not one per call.
    expect(called.map((entry) => entry.connectionId)).toEqual(['primary', 'groq', 'groq', 'groq']);
  });
});
