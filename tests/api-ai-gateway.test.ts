import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';

/**
 * Step 26 wiring tests: the real Fastify app with a fixture provider transport.
 * No socket is opened and no real key exists, but everything else is the
 * shipping path - encryption, owner scoping, routing, usage, and the opt-in
 * paths that let agents, documents and intelligence reason on the caller's own
 * provider.
 */

const ownerA = { 'x-veltravia-owner-ref': 'gateway-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'gateway-owner-b' };

function appWithTransport(transport: FixtureProviderTransport = new FixtureProviderTransport()) {
  const aiGateway = createGatewayService({ keyring: createTestKeyring([1]), transport });
  return { app: buildApp({ aiGateway }), transport };
}

async function connect(app: ReturnType<typeof buildApp>, headers = ownerA) {
  return app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers,
    payload: { providerId: 'openai', apiKey: TEST_OPENAI_KEY, displayName: 'Work key' },
  });
}

describe('AI provider gateway: configuration', () => {
  it('reports honestly when credential encryption is not configured', async () => {
    const app = buildApp({ aiGateway: createGatewayService({ keyring: null }) });
    const body = (
      await app.inject({ method: 'GET', url: '/api/ai/providers', headers: ownerA })
    ).json();
    expect(body.ready).toBe(false);
    expect(body.providers).toEqual([]);
    expect(body.blockedReason).toMatch(/VELTRAVIA_CREDENTIAL_KEY/);

    const created = await connect(app);
    expect(created.statusCode).toBe(503);
    expect(created.json().error.code).toBe('GATEWAY_VAULT_UNAVAILABLE');
  });

  it('ships the provider catalog with capabilities and no secrets', async () => {
    const { app } = appWithTransport();
    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/providers/catalog',
      headers: ownerA,
    });
    expect(response.statusCode).toBe(200);
    const catalog = response.json().catalog as { id: string }[];
    expect(catalog.map((entry) => entry.id)).toContain('anthropic');
    expect(response.body).not.toMatch(/sk-|gsk_|AIza/);
  });
});

describe('AI provider gateway: connection lifecycle', () => {
  it('creates a connection and never returns the key', async () => {
    const { app } = appWithTransport();
    const response = await connect(app);
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(TEST_OPENAI_KEY);
    expect(response.body).not.toContain('credentialRef');
    const connection = response.json().connection;
    expect(connection.credentialHint).toBe('••••0000');
    expect(connection.modelIds).toEqual(['gpt-test-mini']);
  });

  it('lists connections with models and encryption info', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const body = (
      await app.inject({ method: 'GET', url: '/api/ai/providers', headers: ownerA })
    ).json();
    expect(body.ready).toBe(true);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].models).toHaveLength(1);
    expect(body.encryption.algorithm).toBe('aes-256-gcm');
    expect(body.encryption.keyVersions).toEqual([1]);
  });

  it('validates, edits, replaces the credential and deletes', async () => {
    const { app, transport } = appWithTransport();
    const id = (await connect(app)).json().connection.id as string;

    const validation = await app.inject({
      method: 'POST',
      url: `/api/ai/providers/connections/${id}/validate`,
      headers: ownerA,
      payload: {},
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().valid).toBe(true);

    const models = await app.inject({
      method: 'GET',
      url: `/api/ai/providers/connections/${id}/models?refresh=true`,
      headers: ownerA,
    });
    expect(models.json().models.map((model: { modelId: string }) => model.modelId)).toEqual([
      'gpt-test-mini',
    ]);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/ai/providers/connections/${id}`,
      headers: ownerA,
      payload: { displayName: 'Renamed', defaultModelId: 'gpt-test-mini' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().connection.displayName).toBe('Renamed');
    expect(patched.json().connection.defaultModelId).toBe('gpt-test-mini');

    // A default model the connection does not expose is refused, not stored.
    const bogus = await app.inject({
      method: 'PATCH',
      url: `/api/ai/providers/connections/${id}`,
      headers: ownerA,
      payload: { defaultModelId: 'gpt-not-offered' },
    });
    expect(bogus.statusCode).toBe(400);

    const before = transport.requests.length;
    const replaced = await app.inject({
      method: 'POST',
      url: `/api/ai/providers/connections/${id}/credential`,
      headers: ownerA,
      payload: { apiKey: 'sk-replacement-key-0000000000' },
    });
    expect(replaced.statusCode).toBe(200);
    expect(transport.requests.length).toBeGreaterThan(before);
    expect(replaced.body).not.toContain('sk-replacement-key');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/ai/providers/connections/${id}`,
      headers: ownerA,
    });
    expect(deleted.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/ai/providers', headers: ownerA });
    expect(after.json().providers).toEqual([]);
  });

  it('rejects an unknown provider and a secret-shaped display name', async () => {
    const { app } = appWithTransport();
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/connections',
      headers: ownerA,
      payload: { providerId: 'not-a-vendor', apiKey: TEST_OPENAI_KEY },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('GATEWAY_PROVIDER_UNKNOWN');

    const leaky = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/connections',
      headers: ownerA,
      payload: {
        providerId: 'openai',
        apiKey: TEST_OPENAI_KEY,
        displayName: `key ${TEST_OPENAI_KEY}`,
      },
    });
    expect(leaky.statusCode).toBe(400);
  });

  it('refuses an internal custom endpoint', async () => {
    const { app } = appWithTransport();
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/connections',
      headers: ownerA,
      payload: {
        providerId: 'custom-openai-compatible',
        apiKey: 'custom-key-1234567890',
        baseUrl: 'https://169.254.169.254/latest',
        modelIds: ['local'],
        skipDiscovery: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('GATEWAY_UNSAFE_ENDPOINT');
  });
});

describe('AI provider gateway: owner isolation', () => {
  it('never shows or mutates another owner’s connection', async () => {
    const { app } = appWithTransport();
    const id = (await connect(app, ownerA)).json().connection.id as string;
    const listing = await app.inject({ method: 'GET', url: '/api/ai/providers', headers: ownerB });
    expect(listing.json().providers).toEqual([]);

    const attempts: ['POST' | 'GET' | 'DELETE', string, Record<string, unknown>?][] = [
      ['POST', `/api/ai/providers/connections/${id}/validate`, {}],
      ['GET', `/api/ai/providers/connections/${id}/models`],
      [
        'POST',
        `/api/ai/providers/connections/${id}/credential`,
        { apiKey: 'sk-other-0000000000000000' },
      ],
      ['DELETE', `/api/ai/providers/connections/${id}`],
    ];
    for (const [method, url, payload] of attempts) {
      const response = await app.inject({
        method,
        url,
        headers: ownerB,
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('GATEWAY_CONNECTION_NOT_FOUND');
    }
  });
});

describe('AI provider gateway: generation, preferences and usage', () => {
  it('generates through the connected provider and records usage without content', async () => {
    const { app, transport } = appWithTransport();
    await connect(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/generate',
      headers: ownerA,
      payload: { messages: [{ role: 'user', content: 'hello there' }] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.content).toBe('Hello from the fixture provider.');
    expect(body.live).toBe(true);
    expect(body.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(transport.requests.at(-1)?.headers.authorization).toBe(`Bearer ${TEST_OPENAI_KEY}`);

    const usage = await app.inject({
      method: 'GET',
      url: '/api/ai/providers/usage',
      headers: ownerA,
    });
    const records = usage.json().usage;
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('success');
    expect(records[0].estimatedCostUsd).toBeNull();
    expect(JSON.stringify(records)).not.toContain('hello there');
  });

  it('answers 409 with a clear code when nothing is connected', async () => {
    const { app } = appWithTransport();
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/generate',
      headers: ownerA,
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('GATEWAY_NO_PROVIDER_CONFIGURED');
  });

  it('stores and clears preferences', async () => {
    const { app } = appWithTransport();
    const id = (await connect(app)).json().connection.id as string;
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/ai/providers/preferences',
      headers: ownerA,
      payload: { defaultConnectionId: id, defaultModelId: 'gpt-test-mini' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().defaultConnectionId).toBe(id);
    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/ai/providers/preferences',
      headers: ownerA,
      payload: { defaultConnectionId: null },
    });
    expect(cleared.json().defaultConnectionId).toBeNull();
  });
});

describe('AI provider gateway: existing services opt in', () => {
  it('runs an agent on the owner’s own provider when asked', async () => {
    const { app } = appWithTransport(
      new FixtureProviderTransport({
        content: '{"type":"answer","output":"Answered by your provider."}',
        models: ['gpt-test-mini'],
      }),
    );
    await connect(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      headers: ownerA,
      payload: { agentId: 'agent.model', task: 'What is this platform?', reasoning: 'gateway' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().finalOutput).toBe('Answered by your provider.');
  });

  it('refuses an agent gateway run when no provider is connected', async () => {
    const { app } = appWithTransport();
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      headers: ownerA,
      payload: { agentId: 'agent.model', task: 'hello', reasoning: 'gateway' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('GATEWAY_NO_PROVIDER_CONFIGURED');
  });

  it('advertises gateway document reasoning', async () => {
    const { app } = appWithTransport();
    const response = await app.inject({ method: 'GET', url: '/api/documents/capabilities' });
    expect(response.statusCode).toBe(200);
    expect(response.json().gatewayAvailable).toBe(true);
    // The default provider is still the deterministic simulation.
    expect(response.json().providerIsSimulation).toBe(true);
  });

  it('does not pretend to reason on the gateway when there is no evidence to cite', async () => {
    const { app } = appWithTransport();
    const response = await app.inject({
      method: 'POST',
      url: '/api/intelligence/analyze',
      headers: ownerA,
      payload: { question: 'what changed?', reasoning: 'gateway' },
    });
    // No source is authorized for this owner, so the engine reports the gap and
    // never invents an answer - with or without a model behind it.
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('no_evidence');
    expect(response.json().claims).toEqual([]);
  });
});
