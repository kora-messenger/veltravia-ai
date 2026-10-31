import { describe, expect, it } from 'vitest';

import { AIProviderGateway, type GatewayOptions } from './gateway/index.js';
import { CredentialVault } from './vault/index.js';
import { InMemoryConnectionStore, InMemoryPreferenceStore } from './store/index.js';
import { InMemoryUsageStore } from './usage/index.js';
import { RateLimiter } from './ratelimit/index.js';
import { GatewayError } from './errors/index.js';
import { FixtureProviderTransport, TEST_OPENAI_KEY, createTestKeyring } from '../mock/src/index.js';

const OTHER_KEY = 'sk-other-key-0000000000000000';

function setup(options: { transport?: FixtureProviderTransport; now?: () => Date } = {}) {
  const transport =
    options.transport ?? new FixtureProviderTransport({ models: ['gpt-a', 'gpt-b'] });
  const usage = new InMemoryUsageStore();
  const gatewayOptions: GatewayOptions = {
    vault: new CredentialVault({ keyring: createTestKeyring([1]) }),
    connections: new InMemoryConnectionStore(),
    preferences: new InMemoryPreferenceStore(),
    usage,
    transport,
    // Fake DNS: the SSRF guard would otherwise need real resolution for the
    // public custom-endpoint fixtures.
    resolveHost: async () => ['93.184.216.34'],
    ...(options.now ? { now: options.now } : {}),
  };
  return { gateway: new AIProviderGateway(gatewayOptions), transport, usage };
}

const ownerA = { ownerRef: 'owner-a' };
const ownerB = { ownerRef: 'owner-b' };

async function connect(gateway: AIProviderGateway, owner = ownerA, key = TEST_OPENAI_KEY) {
  return gateway.createConnection(owner, {
    providerId: 'openai',
    apiKey: key,
    displayName: 'Work key',
  });
}

describe('provider gateway: connections', () => {
  it('creates a connection, discovers models and validates the key', async () => {
    const { gateway } = setup();
    const view = await connect(gateway);
    expect(view.status).toBe('active');
    expect(view.modelIds).toEqual(['gpt-a', 'gpt-b']);
    expect(view.defaultModelId).toBe('gpt-a');
    expect(view.lastValidatedAt).toBeTruthy();
    expect(view.credentialHint).toBe('••••0000');
    const json = JSON.stringify(view);
    expect(json).not.toContain(TEST_OPENAI_KEY);
    expect(json).not.toContain('credentialRef');
  });

  it('marks a rejected key as invalid but still stores it for replacement', async () => {
    const { gateway } = setup({
      transport: new FixtureProviderTransport({ status: 401, models: ['gpt-a'] }),
    });
    const view = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
      modelIds: ['gpt-a'],
    });
    expect(view.status).toBe('invalid');
    expect(view.lastErrorCategory).toBe('GATEWAY_AUTH_FAILED');
    expect(view.lastValidatedAt).toBeNull();
  });

  it('refuses a duplicate provider + key and allows a second account', async () => {
    const { gateway } = setup();
    await connect(gateway);
    await expect(connect(gateway)).rejects.toMatchObject({ code: 'GATEWAY_CONNECTION_DUPLICATE' });
    const second = await connect(gateway, ownerA, OTHER_KEY);
    expect(second.id).toBeDefined();
    expect(await gateway.listConnections(ownerA)).toHaveLength(2);
  });

  it('rejects unknown providers, bad keys and secret-shaped names', async () => {
    const { gateway } = setup();
    await expect(
      gateway.createConnection(ownerA, { providerId: 'nope', apiKey: TEST_OPENAI_KEY }),
    ).rejects.toMatchObject({ code: 'GATEWAY_PROVIDER_UNKNOWN' });
    await expect(
      gateway.createConnection(ownerA, { providerId: 'openai', apiKey: 'short' }),
    ).rejects.toBeInstanceOf(GatewayError);
    await expect(
      gateway.createConnection(ownerA, {
        providerId: 'openai',
        apiKey: TEST_OPENAI_KEY,
        displayName: `key ${TEST_OPENAI_KEY}`,
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_INVALID_REQUEST' });
  });

  it('rejects a custom endpoint on a provider that does not allow one', async () => {
    const { gateway } = setup();
    await expect(
      gateway.createConnection(ownerA, {
        providerId: 'openai',
        apiKey: TEST_OPENAI_KEY,
        baseUrl: 'https://evil.example.com/v1',
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_INVALID_REQUEST' });
  });

  it('refuses an internal custom endpoint (SSRF) before storing anything', async () => {
    const { gateway } = setup();
    for (const baseUrl of [
      'http://llm.example.com/v1',
      'https://127.0.0.1/v1',
      'https://169.254.169.254/latest',
      'https://localhost/v1',
    ]) {
      await expect(
        gateway.createConnection(ownerA, {
          providerId: 'custom-openai-compatible',
          apiKey: 'custom-key-1234567890',
          baseUrl,
          modelIds: ['local'],
        }),
      ).rejects.toMatchObject({ code: 'GATEWAY_UNSAFE_ENDPOINT' });
    }
    expect(await gateway.listConnections(ownerA)).toHaveLength(0);
  });

  it('accepts a public custom endpoint and keeps manual model ids', async () => {
    const { gateway, transport } = setup();
    const view = await gateway.createConnection(ownerA, {
      providerId: 'custom-openai-compatible',
      apiKey: 'custom-key-1234567890',
      baseUrl: 'https://llm.example.com/v1',
      modelIds: ['house-model'],
      skipDiscovery: true,
    });
    expect(view.baseUrl).toBe('https://llm.example.com/v1');
    expect(view.modelIds).toEqual(['house-model']);
    expect(transport.requests.length).toBe(0);
  });

  it('validates, replaces and deletes a credential', async () => {
    const { gateway } = setup();
    const view = await connect(gateway);
    const validation = await gateway.validateConnection(ownerA, view.id);
    expect(validation.valid).toBe(true);

    const replaced = await gateway.replaceCredential(ownerA, view.id, OTHER_KEY);
    expect(replaced.id).toBe(view.id);
    expect(replaced.credentialHint).toBe('••••0000');

    await gateway.deleteConnection(ownerA, view.id);
    expect(await gateway.listConnections(ownerA)).toHaveLength(0);
    const preferences = await gateway.getPreferences(ownerA);
    expect(preferences.defaultConnectionId).toBeUndefined();
  });

  it('edits the default model and refuses a model the connection does not have', async () => {
    const { gateway } = setup();
    const view = await connect(gateway);
    const updated = await gateway.updateConnection(ownerA, view.id, { defaultModelId: 'gpt-b' });
    expect(updated.defaultModelId).toBe('gpt-b');
    await expect(
      gateway.updateConnection(ownerA, view.id, { defaultModelId: 'not-a-model' }),
    ).rejects.toMatchObject({ code: 'GATEWAY_INVALID_REQUEST' });
  });
});

describe('provider gateway: owner isolation', () => {
  it('never lists another owner’s connection', async () => {
    const { gateway } = setup();
    await connect(gateway, ownerA);
    expect(await gateway.listConnections(ownerB)).toHaveLength(0);
  });

  it('treats another owner’s connection as missing, not forbidden', async () => {
    const { gateway } = setup();
    const view = await connect(gateway, ownerA);
    expect(await gateway.getConnection(ownerB, view.id)).toBeUndefined();
    for (const action of [
      gateway.validateConnection(ownerB, view.id),
      gateway.discoverModels(ownerB, view.id),
      gateway.updateConnection(ownerB, view.id, { displayName: 'hijack' }),
      gateway.replaceCredential(ownerB, view.id, OTHER_KEY),
      gateway.deleteConnection(ownerB, view.id),
    ]) {
      await expect(action).rejects.toMatchObject({ code: 'GATEWAY_CONNECTION_NOT_FOUND' });
    }
    expect(await gateway.getConnection(ownerB, view.id)).toBeUndefined();
    expect(await gateway.listConnections(ownerA)).toHaveLength(1);
  });

  it('refuses to generate on a foreign connection and never returns the stored key', async () => {
    const { gateway } = setup();
    const view = await connect(gateway, ownerA);
    await expect(
      gateway.generate(ownerB, {
        connectionId: view.id,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_CONNECTION_NOT_FOUND' });
  });
});

describe('provider gateway: routing and generation', () => {
  it('generates through the owner’s connection and records usage', async () => {
    const { gateway, usage, transport } = setup();
    await connect(gateway);
    const outcome = await gateway.generate(ownerA, {
      messages: [{ role: 'user', content: 'hello' }],
      system: 'be brief',
    });
    expect(outcome.content).toBe('Hello from the fixture provider.');
    expect(outcome.providerId).toBe('openai');
    expect(outcome.modelId).toBe('gpt-a');
    expect(outcome.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(outcome.live).toBe(true);
    expect(transport.requests.at(-1)?.headers.authorization).toBe(`Bearer ${TEST_OPENAI_KEY}`);

    const records = await gateway.listUsage(ownerA);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-a',
      status: 'success',
      inputTokens: 12,
      outputTokens: 7,
      live: true,
    });
    expect(records[0]?.estimatedCostUsd).toBeNull();
    const raw = JSON.stringify(usage.snapshot());
    expect(raw).not.toContain('hello');
    expect(raw).not.toContain(TEST_OPENAI_KEY);
  });

  it('records a failure with a normalized category and no prompt content', async () => {
    const { gateway, usage } = setup({ transport: new FixtureProviderTransport({ status: 429 }) });
    await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
      modelIds: ['gpt-a'],
      skipDiscovery: true,
    });
    await expect(
      gateway.generate(ownerA, { messages: [{ role: 'user', content: 'secret prompt text' }] }),
    ).rejects.toMatchObject({ code: 'GATEWAY_RATE_LIMITED' });
    const records = usage.snapshot();
    expect(records[0]).toMatchObject({ status: 'failure', errorCategory: 'rate_limited' });
    expect(JSON.stringify(records)).not.toContain('secret prompt text');
  });

  it('fails honestly when no provider is connected', async () => {
    const { gateway } = setup();
    await expect(
      gateway.generate(ownerA, { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'GATEWAY_NO_PROVIDER_CONFIGURED' });
    expect(await gateway.isConfigured(ownerA)).toBe(false);
  });

  it('uses the project preference, then falls back to the default', async () => {
    const { gateway } = setup();
    const first = await connect(gateway);
    const second = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: OTHER_KEY,
      displayName: 'Personal key',
    });
    await gateway.setPreferences(ownerA, {
      defaultConnectionId: first.id,
      projects: { 'project-1': { connectionId: second.id, modelId: 'gpt-b' } },
    });

    const projectRoute = await gateway.resolveRoute(ownerA, { projectId: 'project-1' });
    expect(projectRoute).toMatchObject({
      connectionId: second.id,
      source: 'project',
      modelId: 'gpt-b',
    });

    const defaultRoute = await gateway.resolveRoute(ownerA, { projectId: 'project-2' });
    expect(defaultRoute).toMatchObject({ connectionId: first.id, source: 'default' });

    const explicit = await gateway.resolveRoute(ownerA, {
      connectionId: second.id,
      modelId: 'gpt-a',
    });
    expect(explicit.source).toBe('explicit');
  });

  it('degrades to the default when a project preference points at a deleted connection', async () => {
    const { gateway } = setup();
    const first = await connect(gateway);
    const second = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: OTHER_KEY,
    });
    await gateway.setPreferences(ownerA, {
      defaultConnectionId: first.id,
      projects: { 'project-1': { connectionId: second.id, modelId: 'gpt-a' } },
    });
    await gateway.deleteConnection(ownerA, second.id);
    const route = await gateway.resolveRoute(ownerA, { projectId: 'project-1' });
    expect(route.connectionId).toBe(first.id);
    expect(route.source).toBe('default');
  });

  it('refuses a capability the provider does not declare', async () => {
    const { gateway } = setup();
    await connect(gateway);
    await expect(
      gateway.generate(ownerA, {
        messages: [{ role: 'user', content: 'hi' }],
        requiredCapabilities: ['embeddings'],
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_CAPABILITY_UNSUPPORTED' });
  });

  it('refuses an unknown model on the connection', async () => {
    const { gateway } = setup();
    await connect(gateway);
    await expect(
      gateway.generate(ownerA, { messages: [{ role: 'user', content: 'hi' }], modelId: 'gpt-z' }),
    ).rejects.toMatchObject({ code: 'GATEWAY_MODEL_UNKNOWN' });
  });

  it('rate limits validation attempts per owner', async () => {
    const gateway = new AIProviderGateway({
      vault: new CredentialVault({ keyring: createTestKeyring([1]) }),
      connections: new InMemoryConnectionStore(),
      preferences: new InMemoryPreferenceStore(),
      usage: new InMemoryUsageStore(),
      transport: new FixtureProviderTransport(),
      limiter: new RateLimiter({ rules: { validate: { capacity: 2, refillPerSecond: 0 } } }),
    });
    const view = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
      modelIds: ['gpt-a'],
      skipDiscovery: true,
    });
    await gateway.validateConnection(ownerA, view.id);
    await gateway.validateConnection(ownerA, view.id);
    await expect(gateway.validateConnection(ownerA, view.id)).rejects.toMatchObject({
      code: 'GATEWAY_RATE_LIMITED',
    });
  });

  it('limits connections per owner', async () => {
    const gateway = new AIProviderGateway({
      vault: new CredentialVault({ keyring: createTestKeyring([1]) }),
      connections: new InMemoryConnectionStore(),
      preferences: new InMemoryPreferenceStore(),
      usage: new InMemoryUsageStore(),
      transport: new FixtureProviderTransport(),
      maxConnectionsPerOwner: 1,
    });
    await connect(gateway);
    await expect(connect(gateway, ownerA, OTHER_KEY)).rejects.toMatchObject({
      code: 'GATEWAY_LIMIT_EXCEEDED',
    });
  });
});

describe('provider gateway: AI Core integration', () => {
  it('exposes a scope-bound AICore that routes through the owner’s provider', async () => {
    const { gateway } = setup();
    await connect(gateway);
    const core = await gateway.createCore(ownerA);
    const response = await core.generate({ messages: [{ role: 'user', content: 'hello' }] });
    expect(response.content).toBe('Hello from the fixture provider.');
    expect(response.providerId.startsWith('gw_conn_')).toBe(true);
    expect(response.modelId).toBe('gpt-a');
  });

  it('honours the project model preference inside the core', async () => {
    const { gateway } = setup();
    const view = await connect(gateway);
    await gateway.setPreferences(ownerA, {
      defaultConnectionId: view.id,
      projects: { 'project-1': { connectionId: view.id, modelId: 'gpt-b' } },
    });
    const core = await gateway.createCore(ownerA, 'project-1');
    const response = await core.generate({ messages: [{ role: 'user', content: 'hello' }] });
    expect(response.modelId).toBe('gpt-b');
  });

  it('refuses to build a core with no connection', async () => {
    const { gateway } = setup();
    await expect(gateway.createCore(ownerA)).rejects.toMatchObject({
      code: 'GATEWAY_NO_PROVIDER_CONFIGURED',
    });
  });
});
