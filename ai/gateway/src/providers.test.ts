import { describe, expect, it } from 'vitest';

import { ProviderAdapterRegistry } from './providers/registry.js';
import { OpenAICompatibleAdapter } from './providers/openai-compatible.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { GeminiGatewayAdapter } from './providers/gemini.js';
import { PROVIDER_CATALOG, catalogView, findProviderDefinition } from './providers/catalog.js';
import {
  FixtureProviderTransport,
  errorResponse,
  TEST_ANTHROPIC_KEY,
  TEST_OPENAI_KEY,
} from '../mock/src/index.js';

const registry = new ProviderAdapterRegistry();

function context(providerId: string, apiKey = TEST_OPENAI_KEY) {
  const definition = findProviderDefinition(providerId);
  if (!definition) throw new Error('missing definition');
  return { definition, baseUrl: definition.baseUrl, apiKey, timeoutMs: 5000 };
}

describe('provider catalog', () => {
  it('declares every required provider', () => {
    const ids = PROVIDER_CATALOG.map((provider) => provider.id);
    for (const expected of [
      'openai',
      'gemini',
      'anthropic',
      'deepseek',
      'xai',
      'openrouter',
      'mistral',
      'groq',
      'together',
      'custom-openai-compatible',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('never advertises streaming where the adapter cannot stream', () => {
    for (const definition of PROVIDER_CATALOG) {
      const adapter = registry.adapter(definition.id);
      if (definition.capabilities.includes('streaming')) {
        expect(typeof adapter.stream).toBe('function');
      } else {
        expect(adapter.stream).toBeUndefined();
      }
    }
  });

  it('only advertises model discovery where a models endpoint exists', () => {
    for (const definition of PROVIDER_CATALOG) {
      if (definition.capabilities.includes('model-discovery')) {
        expect(definition.modelsPath).toBeTruthy();
      }
    }
  });

  it('exposes no secrets and no pricing in the catalog view', () => {
    const view = JSON.stringify(catalogView());
    expect(view).not.toMatch(/sk-|AIza|gsk_/);
    expect(view).not.toMatch(/price|cost/i);
  });
});

describe('OpenAI-compatible adapter', () => {
  it('discovers models and validates a credential', async () => {
    const definition = findProviderDefinition('openai');
    const adapter = registry.adapter('openai');
    const transport = new FixtureProviderTransport({ models: ['gpt-a', 'gpt-b'] });
    const result = await adapter.validateCredential({
      apiKey: TEST_OPENAI_KEY,
      baseUrl: definition!.baseUrl,
      timeoutMs: 5000,
      transport,
    });
    expect(result.valid).toBe(true);
    expect(result.models?.map((model) => model.modelId)).toEqual(['gpt-a', 'gpt-b']);
    expect(transport.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_OPENAI_KEY}`);
  });

  it('generates text and normalizes usage', async () => {
    const definition = findProviderDefinition('openai');
    const adapter = registry.adapter('openai');
    const transport = new FixtureProviderTransport({ content: 'Normalized answer.' });
    const result = await adapter.generate(
      { apiKey: TEST_OPENAI_KEY, baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
      { modelId: 'gpt-a', messages: [{ role: 'user', content: 'hi' }], system: 'be terse' },
    );
    expect(result.content).toBe('Normalized answer.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    const body = transport.requests[0]?.body as { messages: { role: string }[] };
    expect(body.messages[0]?.role).toBe('system');
  });

  it('maps auth, rate-limit and outage statuses to normalized codes', async () => {
    const definition = findProviderDefinition('openai');
    const adapter = registry.adapter('openai');
    const cases: [number, string][] = [
      [401, 'GATEWAY_AUTH_FAILED'],
      [403, 'GATEWAY_AUTH_FAILED'],
      [404, 'GATEWAY_MODEL_UNKNOWN'],
      [429, 'GATEWAY_RATE_LIMITED'],
      [500, 'GATEWAY_PROVIDER_UNAVAILABLE'],
      [503, 'GATEWAY_PROVIDER_UNAVAILABLE'],
      [400, 'GATEWAY_INVALID_REQUEST'],
    ];
    for (const [status, code] of cases) {
      const transport = new FixtureProviderTransport({ status });
      await expect(
        adapter.generate(
          { apiKey: TEST_OPENAI_KEY, baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
          { modelId: 'gpt-a', messages: [{ role: 'user', content: 'hi' }] },
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it('reports an invalid credential without throwing', async () => {
    const definition = findProviderDefinition('openai');
    const adapter = registry.adapter('openai');
    const transport = new FixtureProviderTransport({ status: 401 });
    const result = await adapter.validateCredential({
      apiKey: TEST_OPENAI_KEY,
      baseUrl: definition!.baseUrl,
      timeoutMs: 5000,
      transport,
    });
    expect(result.valid).toBe(false);
    expect(result.errorCategory).toBe('GATEWAY_AUTH_FAILED');
  });

  it('refuses structured output for providers that do not declare it', async () => {
    const definition = findProviderDefinition('xai');
    const adapter = registry.adapter('xai');
    expect(definition?.capabilities).not.toContain('structured-output');
    const transport = new FixtureProviderTransport();
    await expect(
      adapter.generate(
        { apiKey: TEST_OPENAI_KEY, baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
        {
          modelId: 'grok-test',
          messages: [{ role: 'user', content: 'hi' }],
          structuredOutput: { name: 'answer' },
        },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_CAPABILITY_UNSUPPORTED' });
  });

  it('refuses vision on a provider that does not declare it', async () => {
    const definition = findProviderDefinition('deepseek');
    const adapter = registry.adapter('deepseek');
    const transport = new FixtureProviderTransport();
    await expect(
      adapter.generate(
        { apiKey: TEST_OPENAI_KEY, baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
        {
          modelId: 'deepseek-chat',
          messages: [{ role: 'user', content: 'hi' }],
          requiredCapabilities: ['vision'],
        },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_CAPABILITY_UNSUPPORTED' });
  });

  it('streams server-sent events when declared', async () => {
    const definition = findProviderDefinition('openai');
    const adapter = registry.adapter('openai');
    const transport = new FixtureProviderTransport({
      override: () => ({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: undefined,
        text: 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
      }),
    });
    const chunks: string[] = [];
    for await (const chunk of adapter.stream!(
      { apiKey: TEST_OPENAI_KEY, baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
      { modelId: 'gpt-a', messages: [{ role: 'user', content: 'hi' }] },
    )) {
      if (!chunk.done) chunks.push(chunk.delta);
    }
    expect(chunks.join('')).toBe('Hello');
  });

  it('rejects a redirect instead of following it', async () => {
    const definition = findProviderDefinition('openai');
    const adapter = registry.adapter('openai');
    const transport = new FixtureProviderTransport({
      override: () => ({
        status: 307,
        headers: { location: 'https://169.254.169.254/latest/meta-data' },
        body: {},
        text: '',
      }),
    });
    await expect(
      adapter.generate(
        { apiKey: TEST_OPENAI_KEY, baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
        { modelId: 'gpt-a', messages: [{ role: 'user', content: 'hi' }] },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_PROVIDER_ERROR' });
  });

  it('supports an alternate auth format for custom endpoints', async () => {
    const definition = findProviderDefinition('custom-openai-compatible');
    const adapter = new OpenAICompatibleAdapter(definition!);
    const transport = new FixtureProviderTransport();
    await adapter.generate(
      {
        apiKey: 'custom-key-1234567890',
        baseUrl: 'https://llm.example.com/v1',
        timeoutMs: 5000,
        transport,
        authFormatOverride: 'x-api-key',
      },
      { modelId: 'local-model', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(transport.requests[0]?.headers['x-api-key']).toBe('custom-key-1234567890');
    expect(transport.requests[0]?.url).toBe('https://llm.example.com/v1/chat/completions');
  });
});

describe('Anthropic adapter', () => {
  it('sends the key in x-api-key with a version header and normalizes the reply', async () => {
    const definition = findProviderDefinition('anthropic');
    const adapter = new AnthropicAdapter(definition!);
    const transport = new FixtureProviderTransport({ content: 'Claude says hi.' });
    const result = await adapter.generate(
      { apiKey: TEST_ANTHROPIC_KEY, baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
      {
        modelId: 'claude-test-1',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'be terse',
        maxOutputTokens: 64,
      },
    );
    expect(result.content).toBe('Claude says hi.');
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 9 });
    expect(transport.requests[0]?.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);
    expect(transport.requests[0]?.headers['anthropic-version']).toBeDefined();
    const body = transport.requests[0]?.body as { system?: string; max_tokens?: number };
    expect(body.system).toBe('be terse');
    expect(body.max_tokens).toBe(64);
  });

  it('discovers models and reports an invalid key', async () => {
    const definition = findProviderDefinition('anthropic');
    const adapter = new AnthropicAdapter(definition!);
    const models = await adapter.discoverModels({
      apiKey: TEST_ANTHROPIC_KEY,
      baseUrl: definition!.baseUrl,
      timeoutMs: 5000,
      transport: new FixtureProviderTransport({ models: ['claude-test-1'] }),
    });
    expect(models.map((model) => model.modelId)).toEqual(['claude-test-1']);
    const invalid = await adapter.validateCredential({
      apiKey: TEST_ANTHROPIC_KEY,
      baseUrl: definition!.baseUrl,
      timeoutMs: 5000,
      transport: new FixtureProviderTransport({ status: 401 }),
    });
    expect(invalid.valid).toBe(false);
  });
});

describe('Gemini adapter', () => {
  it('generates through generateContent with the key out of the URL', async () => {
    const definition = findProviderDefinition('gemini');
    const adapter = new GeminiGatewayAdapter(definition!);
    const transport = new FixtureProviderTransport({ content: 'Gemini says hi.' });
    const result = await adapter.generate(
      { apiKey: 'AIzaTestKey', baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
      { modelId: 'gemini-test-flash', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(result.content).toBe('Gemini says hi.');
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 6 });
    const request = transport.requests[0];
    expect(request?.url).toContain(':generateContent');
    expect(request?.url).not.toContain('AIzaTestKey');
    expect(request?.headers['x-goog-api-key']).toBe('AIzaTestKey');
  });

  it('strips the models/ prefix from discovered ids', async () => {
    const definition = findProviderDefinition('gemini');
    const adapter = new GeminiGatewayAdapter(definition!);
    const models = await adapter.discoverModels({
      apiKey: 'AIzaTestKey',
      baseUrl: definition!.baseUrl,
      timeoutMs: 5000,
      transport: new FixtureProviderTransport({ models: ['gemini-a'] }),
    });
    expect(models[0]?.modelId).toBe('gemini-a');
  });

  it('maps a 429 to a rate-limit error', async () => {
    const definition = findProviderDefinition('gemini');
    const adapter = new GeminiGatewayAdapter(definition!);
    await expect(
      adapter.generate(
        {
          apiKey: 'AIzaTestKey',
          baseUrl: definition!.baseUrl,
          timeoutMs: 5000,
          transport: new FixtureProviderTransport({ status: 429 }),
        },
        { modelId: 'gemini-a', messages: [{ role: 'user', content: 'hi' }] },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_RATE_LIMITED' });
  });
});

describe('every catalog adapter', () => {
  for (const definition of PROVIDER_CATALOG) {
    it(`${definition.id} validates, discovers and generates against a fixture provider`, async () => {
      const adapter = registry.adapter(definition.id);
      const baseUrl = definition.baseUrl || 'https://llm.example.com/v1';
      const ctx = {
        apiKey: TEST_OPENAI_KEY,
        baseUrl,
        timeoutMs: 5000,
        transport: new FixtureProviderTransport(),
      };
      const validation = await adapter.validateCredential(ctx);
      expect(validation.valid).toBe(true);
      const models = validation.models ?? [];
      expect(models.length).toBeGreaterThan(0);
      const result = await adapter.generate(ctx, {
        modelId: models[0]!.modelId,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.content.length).toBeGreaterThan(0);
    });
  }
});

describe('security hygiene', () => {
  it('never echoes a provider message containing a key shape', async () => {
    const definition = findProviderDefinition('openai');
    const adapter = registry.adapter('openai');
    const transport = new FixtureProviderTransport({
      override: () => errorResponse(418, 'bad key sk-secret-value-1234567890'),
    });
    const error = await adapter
      .generate(
        { apiKey: TEST_OPENAI_KEY, baseUrl: definition!.baseUrl, timeoutMs: 5000, transport },
        { modelId: 'gpt-a', messages: [{ role: 'user', content: 'hi' }] },
      )
      .catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain('sk-secret-value');
  });

  it('context helper is unused by the registry but keeps the catalog honest', () => {
    const ctx = context('openai');
    expect(ctx.definition.id).toBe('openai');
    expect(registry.has('openai')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });
});
