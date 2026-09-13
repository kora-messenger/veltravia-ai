import { describe, expect, it } from 'vitest';
import { AICore, AIRouter, ModelRegistry, resolveAIConfig } from '@veltravia/ai-core';
import { MockAIProvider, createMockModels } from '@veltravia/ai-provider-mock';
import {
  GeminiAIProvider,
  createGeminiModels,
  resolveGeminiConfig,
  type GeminiClientLike,
} from '@veltravia/ai-provider-gemini';

/**
 * Router integration: the EXISTING provider-neutral router selects Gemini
 * models purely through the registry - the router has no Gemini imports and
 * no Gemini-specific logic.
 */

const fakeInteraction = {
  id: 'int_router',
  status: 'completed',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }],
};

function fakeGeminiClient(): GeminiClientLike {
  return { interactions: { create: () => Promise.resolve(fakeInteraction) } };
}

function providerMap(
  mock: MockAIProvider,
  gemini: GeminiAIProvider,
): ReadonlyMap<string, import('@veltravia/ai-core').AIProvider> {
  return new Map([
    [mock.id, mock],
    [gemini.id, gemini],
  ]);
}

const geminiProvider = new GeminiAIProvider({
  config: resolveGeminiConfig({ apiKey: 'test-key' }),
  client: fakeGeminiClient(),
});

function registryWithGemini(): ModelRegistry {
  const registry = new ModelRegistry();
  registry.registerModels(createMockModels());
  registry.registerModels(createGeminiModels());
  return registry;
}

describe('router + Gemini integration', () => {
  it('selects a Gemini model when the request names it explicitly', () => {
    const router = new AIRouter({
      registry: registryWithGemini(),
      providers: providerMap(new MockAIProvider(), geminiProvider),
      config: resolveAIConfig(),
    });
    const selection = router.select({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gemini-3.8-flash',
    });
    expect(selection.model.providerId).toBe('gemini');
    expect(selection.provider).toBe(geminiProvider);
  });

  it('selects Gemini as the default when configuration points at it', () => {
    const router = new AIRouter({
      registry: registryWithGemini(),
      providers: providerMap(new MockAIProvider(), geminiProvider),
      config: resolveAIConfig({ defaultProvider: 'gemini', defaultModel: 'gemini-3.8-flash' }),
    });
    const selection = router.select({ messages: [{ role: 'user', content: 'hi' }] });
    expect(selection.model.providerId).toBe('gemini');
  });

  it('still serves mock traffic with Gemini registered alongside', () => {
    const router = new AIRouter({
      registry: registryWithGemini(),
      providers: providerMap(new MockAIProvider(), geminiProvider),
      config: resolveAIConfig(),
    });
    const selection = router.select({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'mock-text-small',
    });
    expect(selection.provider.id).toBe('mock');
  });

  it('serves a full generate() through the real AICore facade to Gemini', async () => {
    const core = new AICore({
      providers: [geminiProvider],
      config: { defaultProvider: 'gemini', defaultModel: 'gemini-3.8-flash' },
    });
    core.registry.registerModels(createGeminiModels());
    const response = await core.generate({ messages: [{ role: 'user', content: 'hello' }] });
    expect(response.providerId).toBe('gemini');
    expect(response.modelId).toBe('gemini-3.8-flash');
    expect(response.content).toBe('ok');
  });
});
