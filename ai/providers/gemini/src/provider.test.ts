import { describe, expect, it, vi } from 'vitest';
import {
  AIConfigurationError,
  AIProviderError,
  InvalidAIRequestError,
  isAIError,
  ModelNotFoundError,
  type AIModelInfo,
  type AIRequest,
} from '@veltravia/ai-core';
import { GeminiAIProvider, type GeminiClientLike } from './provider';
import { resolveGeminiConfig } from './config';

const model: AIModelInfo = {
  providerId: 'gemini',
  modelId: 'gemini-3.8-flash',
  capabilities: ['text-generation'],
  available: true,
};
const request: AIRequest = { messages: [{ role: 'user', content: 'Hello Gemini' }] };

const okInteraction = {
  id: 'int_ok',
  status: 'completed',
  usage: { total_input_tokens: 4, total_output_tokens: 6, total_tokens: 10 },
  created: '2026-09-13T09:00:00.000Z',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello from Gemini!' }] }],
  output_text: 'Hello from Gemini!',
};

function providerWith(
  create: (body: unknown) => Promise<unknown>,
  overrides: Partial<Parameters<typeof resolveGeminiConfig>[0]> = {},
): GeminiAIProvider {
  const client: GeminiClientLike = {
    interactions: { create: (body) => create(body) as never },
  };
  return new GeminiAIProvider({
    config: resolveGeminiConfig({ apiKey: 'test-key', ...overrides }),
    client,
  });
}

describe('GeminiAIProvider', () => {
  it('implements the AIProvider interface', () => {
    const provider = providerWith(() => Promise.resolve(okInteraction));
    expect(provider.id).toBe('gemini');
    expect(typeof provider.send).toBe('function');
  });

  it('refuses construction without an API key (typed configuration error)', () => {
    expect(() => providerWith(() => Promise.resolve(okInteraction), { apiKey: '' })).toThrow(
      AIConfigurationError,
    );
    expect(() =>
      providerWith(() => Promise.resolve(okInteraction), { enabled: false, apiKey: 'x' }),
    ).toThrow(AIConfigurationError);
  });

  it('returns a normalized AIResponse on success', async () => {
    const provider = providerWith(() => Promise.resolve(okInteraction));
    const response = await provider.send(request, model);
    expect(response.content).toBe('Hello from Gemini!');
    expect(response.providerId).toBe('gemini');
    expect(response.modelId).toBe('gemini-3.8-flash');
    expect(response.requestId).toBe('int_ok');
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
    expect(response.finishReason).toBe('stop');
  });

  it('sends the mapped Interactions API body (model, input, system_instruction)', async () => {
    const create = vi.fn(() => Promise.resolve(okInteraction));
    const provider = providerWith((body) => create(body));
    await provider.send(
      { system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] },
      model,
    );
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0] as Record<string, unknown>;
    expect(body.model).toBe('gemini-3.8-flash');
    expect(body.system_instruction).toBe('Be brief.');
    expect(body.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'Hi' }] }]);
  });

  it('rejects requests without any conversation turn before calling Gemini', async () => {
    const create = vi.fn(() => Promise.resolve(okInteraction));
    const provider = providerWith((body) => create(body));
    await expect(
      provider.send({ messages: [{ role: 'system', content: 'only system' }] }, model),
    ).rejects.toThrow(InvalidAIRequestError);
    expect(create).not.toHaveBeenCalled();
  });

  it('normalizes authentication failures (401)', async () => {
    const provider = providerWith(() =>
      Promise.reject(
        Object.assign(new Error('API key not valid. Please pass a valid API key.'), {
          status: 401,
        }),
      ),
    );
    const error = await provider.send(request, model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIConfigurationError);
    expect(isAIError(error)).toBe(true);
    expect((error as AIConfigurationError).details).toMatchObject({
      retryable: false,
      geminiStatus: 401,
    });
  });

  it('normalizes rate-limit errors (429) as retryable', async () => {
    const provider = providerWith(() =>
      Promise.reject(Object.assign(new Error('Resource has been exhausted'), { status: 429 })),
    );
    const error = await provider.send(request, model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).details).toMatchObject({
      retryable: true,
      rateLimited: true,
    });
  });

  it('normalizes timeouts as retryable timeout errors', async () => {
    const provider = providerWith(() =>
      Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
    );
    const error = await provider.send(request, model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).details).toMatchObject({ retryable: true, timeout: true });
  });

  it('normalizes malformed provider responses (no output) as provider errors', async () => {
    const provider = providerWith(() =>
      Promise.resolve({ id: 'int_empty', status: 'completed', steps: [] }),
    );
    await expect(provider.send(request, model)).rejects.toThrow(/no model output/);
  });

  it('normalizes unknown-model errors (404)', async () => {
    const provider = providerWith(() =>
      Promise.reject(Object.assign(new Error('Model not found'), { status: 404 })),
    );
    await expect(provider.send(request, model)).rejects.toThrow(ModelNotFoundError);
  });

  it('normalizes network failures (TypeError) as retryable', async () => {
    const provider = providerWith(() => Promise.reject(new TypeError('fetch failed')));
    const error = await provider.send(request, model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).details).toMatchObject({ retryable: true, network: true });
  });

  it('never includes the API key in any error message or details', async () => {
    const key = 'AIza-super-secret';
    const client: GeminiClientLike = {
      interactions: {
        create: () =>
          Promise.reject(Object.assign(new Error(`request with ${key} rejected`), { status: 400 })),
      },
    };
    const provider = new GeminiAIProvider({ config: resolveGeminiConfig({ apiKey: key }), client });
    const error = await provider.send(request, model).catch((e: unknown) => e);
    const serialized = JSON.stringify({
      message: (error as Error).message,
      details: (error as { details?: unknown }).details,
    });
    expect(serialized).not.toContain(key);
  });
});
