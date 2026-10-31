import { describe, expect, it } from 'vitest';

import { AIProviderGateway, type GatewayOptions, type RetryPolicy } from './gateway/index.js';
import { CredentialVault } from './vault/index.js';
import { InMemoryConnectionStore, InMemoryPreferenceStore } from './store/index.js';
import { InMemoryUsageStore } from './usage/index.js';
import { ModelPricingTable } from './providers/pricing.js';
import { prepareContext, estimateTokens } from './context/index.js';
import type { RouteSelector, RouteSelectorRequest } from './types/index.js';
import { FixtureProviderTransport, TEST_OPENAI_KEY, createTestKeyring } from '../mock/src/index.js';

/**
 * Step 29: real-model execution. What is asserted here is exactly what the
 * platform promises: progressive streaming, honest cancellation, bounded
 * retries, router-only model choice, declared-price-only costs, and one usage
 * record per call.
 */

const ownerA = { ownerRef: 'owner-a' };
const ownerB = { ownerRef: 'owner-b' };

function setup(
  options: {
    transport?: FixtureProviderTransport;
    selector?: RouteSelector;
    pricing?: ModelPricingTable;
    retry?: RetryPolicy;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const transport =
    options.transport ??
    new FixtureProviderTransport({ models: ['gpt-a'], streamChunks: ['one ', 'two ', 'three'] });
  const usage = new InMemoryUsageStore();
  const gatewayOptions: GatewayOptions = {
    vault: new CredentialVault({ keyring: createTestKeyring([1]) }),
    connections: new InMemoryConnectionStore(),
    preferences: new InMemoryPreferenceStore(),
    usage,
    transport,
    resolveHost: async () => ['93.184.216.34'],
    ...(options.selector ? { selector: options.selector } : {}),
    ...(options.pricing ? { pricing: options.pricing } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  };
  return { gateway: new AIProviderGateway(gatewayOptions), transport, usage };
}

async function connect(gateway: AIProviderGateway, owner = ownerA) {
  return gateway.createConnection(owner, {
    providerId: 'openai',
    apiKey: TEST_OPENAI_KEY,
    displayName: 'Primary key',
  });
}

describe('execution: streaming', () => {
  it('yields deltas progressively and reports provider-confirmed usage once', async () => {
    const transport = new FixtureProviderTransport({
      models: ['gpt-a'],
      streamChunks: ['Hel', 'lo', ' there'],
      streamUsage: { inputTokens: 12, outputTokens: 5 },
    });
    const { gateway, usage } = setup({ transport });
    const connection = await connect(gateway);

    const deltas: string[] = [];
    let terminal: { done: boolean; usage?: unknown; latencyMs?: number } | undefined;
    for await (const chunk of gateway.stream(ownerA, {
      connectionId: connection.id,
      modelId: 'gpt-a',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (chunk.done) terminal = chunk;
      else deltas.push(chunk.delta);
    }

    // Progressive: more than one delta, in arrival order.
    expect(deltas).toEqual(['Hel', 'lo', ' there']);
    expect(terminal?.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(typeof terminal?.latencyMs).toBe('number');

    const records = await usage.listByOwner('owner-a', 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 'success',
      streamed: true,
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      usageSource: 'provider-confirmed',
      attempts: 1,
      costSource: 'unavailable',
      estimatedCostUsd: null,
    });
  });

  it('records a cancelled stream as cancelled, never as a success', async () => {
    const controller = new AbortController();
    const transport = new FixtureProviderTransport({
      models: ['gpt-a'],
      streamChunks: ['a', 'b', 'c', 'd'],
      streamUsage: { inputTokens: 4, outputTokens: 4 },
    });
    const { gateway, usage } = setup({ transport });
    const connection = await connect(gateway);

    const deltas: string[] = [];
    await expect(async () => {
      for await (const chunk of gateway.stream(ownerA, {
        connectionId: connection.id,
        modelId: 'gpt-a',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      })) {
        if (!chunk.done) {
          deltas.push(chunk.delta);
          // Cancel after the first fragment arrives.
          if (deltas.length === 1) controller.abort();
        }
      }
    }).rejects.toMatchObject({ code: 'GATEWAY_ABORTED' });

    const records = await usage.listByOwner('owner-a', 10);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('cancelled');
    expect(records[0]?.errorCategory).toBe('cancelled');
    // A cancelled call still has no confirmed cost.
    expect(records[0]?.estimatedCostUsd).toBeNull();
  });

  it('refuses a run that needs a capability the connection does not declare', async () => {
    const { gateway, transport } = setup();
    const connection = await connect(gateway);
    const before = transport.requests.length;
    await expect(
      gateway.generate(ownerA, {
        connectionId: connection.id,
        modelId: 'gpt-a',
        messages: [{ role: 'user', content: 'hi' }],
        requiredCapabilities: ['embeddings'],
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_CAPABILITY_UNSUPPORTED' });
    expect(transport.requests.length).toBe(before);
  });
});

describe('execution: retries', () => {
  it('retries a rate limit once and succeeds, recording a single usage row', async () => {
    let calls = 0;
    const transport = new FixtureProviderTransport({ models: ['gpt-a'] });
    const handler = transport.request.bind(transport);
    (transport as unknown as { request: typeof handler }).request = async (request) => {
      if (!request.url.includes('chat/completions')) return handler(request);
      calls += 1;
      if (calls === 1) {
        return {
          status: 429,
          headers: {},
          body: { error: { message: 'slow down' } },
          text: '{"error":{"message":"slow down"}}',
        };
      }
      return handler(request);
    };
    const { gateway, usage } = setup({ transport });
    const connection = await connect(gateway);

    const outcome = await gateway.generate(ownerA, {
      connectionId: connection.id,
      modelId: 'gpt-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls).toBe(2);
    expect(outcome.attempts).toBe(2);
    const records = await usage.listByOwner('owner-a', 10);
    expect(records).toHaveLength(1);
    expect(records[0]?.attempts).toBe(2);
    expect(records[0]?.status).toBe('success');
  });

  it('never retries a rejected key', async () => {
    let calls = 0;
    const transport = new FixtureProviderTransport({ models: ['gpt-a'] });
    (transport as unknown as { request: typeof transport.request }).request = async (request) => {
      if (!request.url.includes('chat/completions')) {
        return {
          status: 200,
          headers: {},
          body: { data: [{ id: 'gpt-a' }] },
          text: '{"data":[{"id":"gpt-a"}]}',
        };
      }
      calls += 1;
      return {
        status: 401,
        headers: {},
        body: { error: { message: 'bad key' } },
        text: '{"error":{"message":"bad key"}}',
      };
    };
    const { gateway, usage } = setup({
      transport,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const connection = await connect(gateway);
    await expect(
      gateway.generate(ownerA, {
        connectionId: connection.id,
        modelId: 'gpt-a',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_AUTH_FAILED' });
    expect(calls).toBe(1);
    const records = await usage.listByOwner('owner-a', 10);
    expect(records[0]?.status).toBe('failure');
    expect(records[0]?.errorCategory).toBe('auth');
  });
});

describe('execution: router-only model choice', () => {
  it('uses the router answer verbatim and records the decision', async () => {
    let seen: RouteSelectorRequest | undefined;
    const selector: RouteSelector = {
      select: async (request) => {
        seen = request;
        return {
          outcome: 'routed',
          connectionId: 'from-router',
          providerId: 'openai',
          modelId: 'gpt-a',
          decisionId: 'dec-1',
          summary: 'Chose OpenAI gpt-a because it is your connected default.',
          contextWindowTokens: 128_000,
        };
      },
    };
    const { gateway } = setup({ selector });
    const connection = await connect(gateway);
    // The selector names a connection id it must own; rewrite it to the real one.
    const patched: RouteSelector = {
      select: async (request) => {
        seen = request;
        return {
          outcome: 'routed',
          connectionId: connection.id,
          providerId: 'openai',
          modelId: 'gpt-a',
          decisionId: 'dec-1',
          summary: 'Chose OpenAI gpt-a because it is your connected default.',
          contextWindowTokens: 128_000,
        };
      },
    };
    gateway.attachSelector(patched);

    const outcome = await gateway.generate(ownerA, {
      category: 'general-conversation',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(seen?.category).toBe('general-conversation');
    expect(outcome.modelId).toBe('gpt-a');
    expect(outcome.decisionId).toBe('dec-1');
    expect(outcome.live).toBe(true);
  });

  it('refuses when the router refuses, and sends nothing', async () => {
    const selector: RouteSelector = {
      select: async () => ({
        outcome: 'refused',
        summary: 'No connected model can handle this task.',
        decisionId: 'dec-2',
      }),
    };
    const { gateway, transport } = setup({ selector });
    await connect(gateway);
    const before = transport.requests.length;
    await expect(
      gateway.generate(ownerA, {
        category: 'complex-reasoning',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_ROUTE_UNAVAILABLE' });
    expect(transport.requests.length).toBe(before);
  });

  it('refuses a router answer that points at another owner’s connection', async () => {
    const { gateway } = setup({
      selector: {
        select: async () => ({
          outcome: 'routed',
          connectionId: 'someone-elses-connection',
          providerId: 'openai',
          modelId: 'gpt-a',
          summary: 'Selected a model.',
        }),
      },
    });
    await connect(gateway);
    await expect(
      gateway.generate(ownerA, {
        category: 'general-conversation',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_ROUTE_UNAVAILABLE' });
  });
});

describe('execution: cost estimation', () => {
  it('estimates cost only from a declared price', async () => {
    const pricing = new ModelPricingTable();
    pricing.declare('openai', 'gpt-a', { inputPer1MUsd: 2, outputPer1MUsd: 8 });
    const transport = new FixtureProviderTransport({
      models: ['gpt-a'],
      content: 'answer',
      streamChunks: ['ans', 'wer'],
      streamUsage: { inputTokens: 500_000, outputTokens: 500_000 },
    });
    const { gateway, usage } = setup({ transport, pricing });
    const connection = await connect(gateway);
    for await (const _chunk of gateway.stream(ownerA, {
      connectionId: connection.id,
      modelId: 'gpt-a',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      // drain
    }
    const record = (await usage.listByOwner('owner-a', 10))[0];
    expect(record?.costSource).toBe('declared-pricing');
    expect(record?.estimatedCostUsd).toBeCloseTo(5, 5);
  });

  it('reports unavailable rather than guessing when tokens are missing', async () => {
    const pricing = new ModelPricingTable();
    pricing.declare('openai', 'gpt-a', { inputPer1MUsd: 2, outputPer1MUsd: 8 });
    // No streamUsage: the provider never states token counts.
    const transport = new FixtureProviderTransport({ models: ['gpt-a'], streamChunks: ['x'] });
    const { gateway, usage } = setup({ transport, pricing });
    const connection = await connect(gateway);
    for await (const _chunk of gateway.stream(ownerA, {
      connectionId: connection.id,
      modelId: 'gpt-a',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      // drain
    }
    const record = (await usage.listByOwner('owner-a', 10))[0];
    expect(record?.usageSource).toBe('unavailable');
    expect(record?.totalTokens).toBeNull();
    expect(record?.estimatedCostUsd).toBeNull();
  });

  it('rejects a negative declared price', () => {
    const pricing = new ModelPricingTable();
    expect(() =>
      pricing.declare('openai', 'gpt-a', { inputPer1MUsd: -1, outputPer1MUsd: 1 }),
    ).toThrow();
  });
});

describe('execution: context fitting', () => {
  const long = (word: string) => `${word} `.repeat(1_200);

  it('drops the oldest messages first and keeps the newest question', () => {
    const result = prepareContext({
      system: 'You are a careful assistant.',
      messages: [
        { role: 'user', content: long('oldest') },
        { role: 'assistant', content: long('older') },
        { role: 'user', content: 'the real question' },
      ],
      budget: { contextWindowTokens: 1_200, maxOutputTokens: 200 },
    });
    expect(result.truncated).toBe(true);
    expect(result.droppedMessages).toBe(2);
    expect(result.messages.at(-1)?.content).toBe('the real question');
    expect(result.notes[0]).toContain('left out');
  });

  it('refuses when even the question alone cannot fit', () => {
    expect(() =>
      prepareContext({
        messages: [{ role: 'user', content: long('huge') }],
        budget: { contextWindowTokens: 200, maxOutputTokens: 200 },
      }),
    ).toThrowError(/larger than the model can accept|no room/);
  });

  it('leaves the prompt alone and says so when no window is declared', () => {
    const result = prepareContext({
      messages: [{ role: 'user', content: 'hello' }],
      budget: { contextWindowTokens: null, maxOutputTokens: 256 },
    });
    expect(result.unbounded).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.notes[0]).toContain('no context window');
  });

  it('scrubs secret-shaped values out of the prompt', () => {
    const result = prepareContext({
      messages: [{ role: 'user', content: `key ${TEST_OPENAI_KEY}` }],
      budget: { contextWindowTokens: null, maxOutputTokens: 128 },
    });
    expect(result.messages[0]?.content).not.toContain(TEST_OPENAI_KEY);
  });

  it('estimates tokens conservatively', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('execution: owner isolation', () => {
  it('does not let one owner spend another owner’s connection', async () => {
    const { gateway } = setup();
    const connection = await connect(gateway, ownerA);
    await expect(
      gateway.generate(ownerB, {
        connectionId: connection.id,
        modelId: 'gpt-a',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_CONNECTION_NOT_FOUND' });
    expect(await gateway.listUsage(ownerB, 10)).toHaveLength(0);
  });
});
