import { describe, expect, it } from 'vitest';
import { resolveAIConfig } from '../config';
import { CapabilityNotSupportedError, ModelNotFoundError, ProviderNotFoundError } from '../errors';
import type { AIProvider, AIRequest, AIResponse } from '../types';
import { ModelRegistry } from '../registry';
import { AIRouter } from './index';

const stubProvider = (id: string): AIProvider => ({
  id,
  displayName: `Stub ${id}`,
  async send(_request: AIRequest, model): Promise<AIResponse> {
    return {
      content: 'ok',
      providerId: id,
      modelId: model.modelId,
      usage: null,
      finishReason: 'stop',
      requestId: `req-${id}`,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
  },
});

const request = (overrides: Partial<AIRequest> = {}): AIRequest => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

function setup() {
  const registry = new ModelRegistry();
  const providers = new Map<string, AIProvider>();
  providers.set('mock', stubProvider('mock'));
  providers.set('other', stubProvider('other'));
  registry.registerModels([
    {
      providerId: 'mock',
      modelId: 'mock-text-small',
      capabilities: ['text-generation'],
      available: true,
    },
    {
      providerId: 'mock',
      modelId: 'mock-multimodal',
      capabilities: ['text-generation', 'vision', 'streaming'],
      available: true,
    },
    {
      providerId: 'other',
      modelId: 'other-text',
      capabilities: ['text-generation'],
      available: true,
    },
    {
      providerId: 'mock',
      modelId: 'mock-embeddings',
      capabilities: ['embeddings'],
      available: true,
    },
    {
      providerId: 'mock',
      modelId: 'mock-offline',
      capabilities: ['text-generation'],
      available: false,
    },
  ]);
  return { registry, providers };
}

describe('AIRouter', () => {
  it('selects an explicit model directly', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    const decision = router.select(request({ model: 'mock-multimodal' }));
    expect(decision.model.modelId).toBe('mock-multimodal');
    expect(decision.provider.id).toBe('mock');
  });

  it('uses the configured default model when the request does not name one', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({
      registry,
      providers,
      config: resolveAIConfig({ defaultModel: 'other-text' }),
    });
    expect(router.select(request()).model.modelId).toBe('other-text');
  });

  it('selects the first capable model for a capability-only request', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    const decision = router.select(request({ capabilities: ['vision'] }));
    expect(decision.model.modelId).toBe('mock-multimodal');
  });

  it('defaults to text-generation when no capabilities are requested', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    const decision = router.select(request());
    expect(decision.model.capabilities).toContain('text-generation');
  });

  it('prefers the default provider on ties during capability scanning', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({
      registry,
      providers,
      config: resolveAIConfig({ defaultProvider: 'other' }),
    });
    const decision = router.select(request());
    expect(decision.provider.id).toBe('other');
  });

  it('throws ModelNotFoundError for unknown models', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    expect(() => router.select(request({ model: 'ghost' }))).toThrow(ModelNotFoundError);
  });

  it('throws ModelNotFoundError for unavailable models', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    expect(() => router.select(request({ model: 'mock-offline' }))).toThrow(ModelNotFoundError);
  });

  it('throws CapabilityNotSupportedError when no model has the capability', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    expect(() => router.select(request({ capabilities: ['image-generation'] }))).toThrow(
      CapabilityNotSupportedError,
    );
  });

  it('throws CapabilityNotSupportedError when an explicit model lacks a capability', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    expect(() =>
      router.select(request({ model: 'mock-text-small', capabilities: ['vision'] })),
    ).toThrow(/does not support/);
  });

  it('skips unavailable and non-capable models while scanning', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    const decision = router.select(request({ capabilities: ['text-generation'] }));
    expect(decision.model.modelId).toBe('mock-text-small');
  });

  it('throws ProviderNotFoundError when the provider instance is missing', () => {
    const { registry, providers } = setup();
    providers.delete('mock');
    const router = new AIRouter({ registry, providers, config: resolveAIConfig() });
    expect(() => router.select(request({ model: 'mock-text-small' }))).toThrow(
      ProviderNotFoundError,
    );
  });

  it('throws ProviderNotFoundError when the provider is disabled', () => {
    const { registry, providers } = setup();
    const router = new AIRouter({
      registry,
      providers,
      config: resolveAIConfig({ enabledProviders: ['other'] }),
    });
    expect(() => router.select(request({ model: 'mock-text-small' }))).toThrow(
      ProviderNotFoundError,
    );
    // Disabled models are also skipped during capability scans.
    const decision = router.select(request());
    expect(decision.provider.id).toBe('other');
  });
});
