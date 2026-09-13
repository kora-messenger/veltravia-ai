import { describe, expect, it } from 'vitest';
import { AICore, type AIProvider } from '@veltravia/ai-core';
import { MockAIProvider, createMockModels } from '@veltravia/ai-provider-mock';
import {
  GeminiAIProvider,
  createGeminiModels,
  resolveGeminiConfig,
  type GeminiClientLike,
} from '@veltravia/ai-provider-gemini';
import { buildApp } from '@veltravia/api';

/**
 * API integration: POST /api/ai/generate can route to the Gemini provider
 * through the AI Core + router, with the client never seeing a single
 * Gemini-specific request or response format - and never seeing the key.
 */

const API_KEY = 'test-gemini-key-do-not-print';

const okInteraction = {
  id: 'int_api',
  status: 'completed',
  usage: { total_input_tokens: 8, total_output_tokens: 12, total_tokens: 20 },
  created: '2026-09-13T09:00:00.000Z',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Gemini says hi!' }] }],
  output_text: 'Gemini says hi!',
};

const fakeClient: GeminiClientLike = {
  interactions: { create: () => Promise.resolve(okInteraction) },
};

function geminiBackedCore(): AICore {
  const gemini = new GeminiAIProvider({
    config: resolveGeminiConfig({ apiKey: API_KEY }),
    client: fakeClient,
  });
  const providers: readonly AIProvider[] = [new MockAIProvider(), gemini];
  const core = new AICore({
    providers,
    config: { defaultProvider: 'gemini', defaultModel: 'gemini-3.8-flash' },
  });
  core.registry.registerModels(createMockModels());
  core.registry.registerModels(createGeminiModels());
  return core;
}

describe('POST /api/ai/generate with the Gemini provider', () => {
  it('routes an explicit Gemini model through the full stack: API -> Core -> Router -> Gemini', async () => {
    const app = buildApp({ aiCore: geminiBackedCore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/generate',
      payload: {
        messages: [
          { role: 'user', content: 'Hi, my name is Ijezie.' },
          { role: 'assistant', content: 'Hello Ijezie!' },
          { role: 'user', content: 'Who am I?' },
        ],
        model: 'gemini-3.8-flash',
        system: 'Be helpful.',
        temperature: 0.7,
      },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      content: string;
      providerId: string;
      modelId: string;
      usage: unknown;
      finishReason: string;
      requestId: string;
    }>();
    expect(body.providerId).toBe('gemini');
    expect(body.modelId).toBe('gemini-3.8-flash');
    expect(body.content).toBe('Gemini says hi!');
    expect(body.requestId).toBe('int_api');
    expect(body.usage).toEqual({ inputTokens: 8, outputTokens: 12, totalTokens: 20 });
  });

  it('routes to Gemini by default when it is the configured default model', async () => {
    const app = buildApp({ aiCore: geminiBackedCore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/generate',
      payload: { messages: [{ role: 'user', content: 'default please' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ providerId: string }>().providerId).toBe('gemini');
  });

  it('still serves mock traffic on the same core', async () => {
    const app = buildApp({ aiCore: geminiBackedCore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/generate',
      payload: { messages: [{ role: 'user', content: 'mock me' }], model: 'mock-text-small' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ providerId: string }>().providerId).toBe('mock');
  });

  it('never leaks the Gemini API key in any response (success or failure)', async () => {
    const failingClient: GeminiClientLike = {
      interactions: {
        create: () =>
          Promise.reject(Object.assign(new Error(`key ${API_KEY} invalid`), { status: 401 })),
      },
    };
    const gemini = new GeminiAIProvider({
      config: resolveGeminiConfig({ apiKey: API_KEY }),
      client: failingClient,
    });
    const core = new AICore({
      providers: [gemini],
      config: { defaultProvider: 'gemini', defaultModel: 'gemini-3.8-flash' },
    });
    core.registry.registerModels(createGeminiModels());

    const app = buildApp({ aiCore: core });
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/generate',
      payload: { messages: [{ role: 'user', content: 'break it' }] },
    });
    // Auth failure maps to a typed configuration error -> 500 to the client
    // (server-side key problem, not the client's fault).
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(API_KEY);
  });
});
