import { describe, expect, it } from 'vitest';
import { InvalidAIRequestError, type AIProvider, validateAIRequest } from '@veltravia/ai-core';
import { MockAIProvider, createMockModels } from './index';
import { resolveAIConfig } from '@veltravia/ai-core';

const config = resolveAIConfig();
const provider = new MockAIProvider();
const models = createMockModels();
const textModel = models.find((m) => m.modelId === 'mock-text-small')!;
const request = (value: unknown) => validateAIRequest(value, config);

describe('MockAIProvider', () => {
  it('implements the AIProvider interface', () => {
    expect(typeof provider.send).toBe('function');
    expect(typeof provider.id).toBe('string');
    expect(typeof provider.displayName).toBe('string');
    const asProvider: AIProvider = provider; // compile-time check
    expect(asProvider.id).toBe('mock');
  });

  it('returns a normalized AIResponse for a valid request', async () => {
    const response = await provider.send(
      request({ messages: [{ role: 'user', content: 'build me an app' }] }),
      textModel,
    );
    expect(response.providerId).toBe('mock');
    expect(response.modelId).toBe('mock-text-small');
    expect(response.finishReason).toBe('stop');
    expect(response.content).toContain('build me an app');
    expect(response.content).toContain('mock-text-small');
  });

  it('is fully deterministic: identical input, identical output', async () => {
    const req = request({ messages: [{ role: 'user', content: 'same input' }] });
    const first = await provider.send(req, textModel);
    const second = await provider.send(req, textModel);
    expect(second).toEqual(first);
    expect(first.requestId).toMatch(/^mock-[0-9a-f]+$/);
  });

  it('reports predictable usage metadata', async () => {
    const response = await provider.send(
      request({
        system: 'abcd',
        messages: [{ role: 'user', content: '1234' }],
      }),
      textModel,
    );
    // 8 input characters / 4 chars-per-token = 2 input tokens.
    expect(response.usage?.inputTokens).toBe(2);
    expect(response.usage?.outputTokens).toBeGreaterThan(0);
    expect(response.usage?.totalTokens).toBe(
      (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
    );
  });

  it('returns JSON content when structured output is requested', async () => {
    const response = await provider.send(
      request({
        messages: [{ role: 'user', content: 'give me json' }],
        structuredOutput: { name: 'answer' },
      }),
      textModel,
    );
    const parsed = JSON.parse(response.content) as { answer: string };
    expect(parsed.answer).toContain('give me json');
  });

  it('throws InvalidAIRequestError for malformed requests', async () => {
    await expect(provider.send({ messages: [] } as never, textModel)).rejects.toThrow(
      InvalidAIRequestError,
    );
    await expect(
      provider.send(
        { messages: [{ role: 'assistant', content: 'no user turn' }] } as never,
        textModel,
      ),
    ).rejects.toThrow(/user message/);
  });

  it('needs no network and no API key by construction', () => {
    // The class has no dependency beyond @veltravia/ai-core and takes only a
    // clock in its options. This test pins that contract: if someone adds an
    // HTTP client or a key requirement, it will fail.
    const options: ConstructorParameters<typeof MockAIProvider>[0] = {};
    const fresh = new MockAIProvider(options);
    expect(fresh.id).toBe('mock');
  });
});

describe('createMockModels', () => {
  it('returns a capability-diverse, fully available model set', () => {
    expect(models.length).toBeGreaterThanOrEqual(4);
    expect(models.every((m) => m.available)).toBe(true);
    expect(models.every((m) => m.providerId === 'mock')).toBe(true);
    const caps = new Set(models.flatMap((m) => m.capabilities));
    expect(caps.has('text-generation')).toBe(true);
    expect(caps.has('vision')).toBe(true);
    expect(caps.has('embeddings')).toBe(true);
  });
});
