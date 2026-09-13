import { describe, expect, it } from 'vitest';
import { resolveAIConfig } from './config';
import { AIProviderError, CapabilityNotSupportedError, ModelNotFoundError } from './errors';
import type { AIProvider, AIRequest, AIResponse } from './types';
import { AICore } from './core';
import { ModelRegistry } from './registry';

/** A provider that fails with a raw (vendor-style) error - must be normalized. */
class RawErrorProvider implements AIProvider {
  readonly id = 'raw';
  readonly displayName = 'Raw Error Provider';
  async send(): Promise<AIResponse> {
    throw new Error('vendor exploded');
  }
}

/** A provider that fails with a typed AI error - must pass through untouched. */
class TypedErrorProvider implements AIProvider {
  readonly id = 'typed';
  readonly displayName = 'Typed Error Provider';
  async send(): Promise<AIResponse> {
    throw new AIProviderError('typed failure');
  }
}

/** A minimal deterministic provider for happy-path tests. */
class EchoProvider implements AIProvider {
  readonly id = 'echo';
  readonly displayName = 'Echo Provider';
  async send(request: AIRequest, model): Promise<AIResponse> {
    const last = [...request.messages].reverse().find((m) => m.role === 'user');
    return {
      content: `echo:${last?.content ?? ''}`,
      providerId: this.id,
      modelId: model.modelId,
      usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
      finishReason: 'stop',
      requestId: 'echo-req',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
  }
}

function buildCore(overrides: { providers?: AIProvider[] } = {}) {
  const registry = new ModelRegistry();
  registry.registerModels([
    {
      providerId: 'echo',
      modelId: 'echo-text',
      capabilities: ['text-generation'],
      available: true,
    },
    {
      providerId: 'raw',
      modelId: 'raw-text',
      capabilities: ['text-generation'],
      available: true,
    },
    {
      providerId: 'typed',
      modelId: 'typed-text',
      capabilities: ['text-generation'],
      available: true,
    },
    {
      providerId: 'echo',
      modelId: 'echo-embed',
      capabilities: ['embeddings'],
      available: true,
    },
  ]);
  const providers = overrides.providers ?? [new EchoProvider()];
  return new AICore({ registry, providers, config: resolveAIConfig() });
}

describe('AICore.generate', () => {
  it('validates, routes and executes a request end to end', async () => {
    const core = buildCore();
    const response = await core.generate({
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(response.content).toBe('echo:hello world');
    expect(response.providerId).toBe('echo');
    expect(response.modelId).toBe('echo-text');
    expect(response.usage?.totalTokens).toBe(8);
    expect(response.finishReason).toBe('stop');
  });

  it('rejects invalid input with a typed error before routing', async () => {
    const core = buildCore();
    await expect(core.generate({ messages: [] })).rejects.toThrow(/messages/);
  });

  it('returns ModelNotFoundError for unknown models', async () => {
    const core = buildCore();
    await expect(
      core.generate({ messages: [{ role: 'user', content: 'x' }], model: 'ghost' }),
    ).rejects.toThrow(ModelNotFoundError);
  });

  it('returns CapabilityNotSupportedError when no model fits', async () => {
    const core = buildCore();
    await expect(
      core.generate({
        messages: [{ role: 'user', content: 'x' }],
        capabilities: ['image-generation'],
      }),
    ).rejects.toThrow(CapabilityNotSupportedError);
  });

  it('does not route a plain text request to an embeddings-only model', async () => {
    const core = buildCore();
    const response = await core.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(response.modelId).toBe('echo-text');
  });

  it('normalizes raw provider errors into AIProviderError', async () => {
    const core = buildCore({ providers: [new RawErrorProvider()] });
    const error = await core
      .generate({ messages: [{ role: 'user', content: 'x' }] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).code).toBe('AI_PROVIDER_ERROR');
    expect((error as AIProviderError).cause).toBeInstanceOf(Error);
  });

  it('passes typed provider errors through without double-wrapping', async () => {
    const core = buildCore({ providers: [new TypedErrorProvider()] });
    const error = await core
      .generate({ messages: [{ role: 'user', content: 'x' }] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).message).toBe('typed failure');
  });

  it('rejects duplicate provider ids at construction', () => {
    const duplicate = new EchoProvider();
    expect(() => new AICore({ providers: [duplicate, duplicate] })).toThrow(/Duplicate/);
  });

  it('exposes the registry via listModels', () => {
    const core = buildCore();
    expect(core.listModels().map((m) => m.modelId)).toContain('echo-text');
  });
});
