import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';

/**
 * Step 28 wiring tests: the real Fastify app with a fixture provider transport.
 *
 * The point of these is the seam, not the scoring rules (those are covered by
 * the router package tests): does a real request reach the router with the
 * caller's own catalog, does a refusal come back as a refusal, and does a
 * preference set on this surface reach the code that actually executes?
 */

const ownerA = { 'x-veltravia-owner-ref': 'router-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'router-owner-b' };

function appWithTransport(transport = new FixtureProviderTransport()) {
  const aiGateway = createGatewayService({ keyring: createTestKeyring([1]), transport });
  return { app: buildApp({ aiGateway }), transport };
}

async function connect(app: ReturnType<typeof buildApp>, headers = ownerA, key = TEST_OPENAI_KEY) {
  return app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers,
    payload: { providerId: 'openai', apiKey: key, displayName: 'Work key' },
  });
}

describe('model router: catalog and task support', () => {
  it('reports an empty, honest catalog before anything is connected', async () => {
    const { app } = appWithTransport();
    const response = await app.inject({ method: 'GET', url: '/api/ai/router', headers: ownerA });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.catalog).toEqual([]);
    expect(body.catalogNotes.join(' ')).toMatch(/no provider is connected/i);
    expect(body.persistence).toMatch(/in memory/i);
  });

  it('lists the connected provider models with their capability source', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const body = (
      await app.inject({ method: 'GET', url: '/api/ai/router', headers: ownerA })
    ).json();
    expect(body.catalog).toHaveLength(1);
    expect(body.catalog[0]).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-test-mini',
      capabilitySource: 'catalog',
      discoverySource: 'connection',
    });
    expect(body.providerCount).toBe(1);
  });

  it('never leaks a credential or a credential reference', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const response = await app.inject({ method: 'GET', url: '/api/ai/router', headers: ownerA });
    expect(response.body).not.toContain(TEST_OPENAI_KEY);
    expect(response.body).not.toContain('credentialRef');
    expect(response.body).not.toContain('credentialHint');
  });

  it('separates categories the provider can serve from the ones it cannot', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const body = (
      await app.inject({ method: 'GET', url: '/api/ai/router', headers: ownerA })
    ).json();
    const byCategory = new Map<string, { supported: boolean; reason: string | null }>(
      (body.categories as { category: string; supported: boolean; reason: string | null }[]).map(
        (entry) => [entry.category, entry],
      ),
    );
    expect(byCategory.get('general-conversation')?.supported).toBe(true);
    expect(byCategory.get('video-understanding')?.supported).toBe(false);
    expect(byCategory.get('video-understanding')?.reason).toMatch(/no connected adapter/i);
    expect(byCategory.get('embeddings')?.supported).toBe(false);
  });
});

describe('model router: routing', () => {
  it('routes a task and explains the decision', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/router/route',
      headers: ownerA,
      payload: { category: 'general-conversation' },
    });
    expect(response.statusCode).toBe(200);
    const decision = response.json().decision;
    expect(decision.outcome).toBe('routed');
    expect(decision.selected.modelId).toBe('gpt-test-mini');
    expect(decision.summary).toMatch(/because it declares/i);
    expect(decision.decidedBy).toBe('automatic');
  });

  it('answers a category nothing can serve with the honest decision, not an error', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/router/route',
      headers: ownerA,
      payload: { category: 'video-understanding' },
    });
    // Advisory route: the refusal is the answer, so it arrives as a decision.
    expect(response.statusCode).toBe(200);
    expect(response.json().decision.outcome).toBe('unsupported');
    expect(response.json().decision.summary).toMatch(/not available yet/i);
  });

  it('rejects an unknown category', async () => {
    const { app } = appWithTransport();
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/router/route',
      headers: ownerA,
      payload: { category: 'telepathy' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('ROUTER_UNKNOWN_CATEGORY');
  });

  it('refuses one owner’s connection to another owner', async () => {
    const { app } = appWithTransport();
    const created = await connect(app);
    const connectionId = created.json().connection.id;
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/router/route',
      headers: ownerB,
      payload: {
        category: 'general-conversation',
        mode: 'manual',
        connectionId,
        modelId: 'gpt-test-mini',
      },
    });
    console.log('ISO BODY', response.statusCode, response.body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('ROUTER_PREFERENCE_UNUSABLE');
  });

  it('keeps decision history per owner', async () => {
    const { app } = appWithTransport();
    await connect(app);
    await app.inject({
      method: 'POST',
      url: '/api/ai/router/route',
      headers: ownerA,
      payload: { category: 'general-conversation' },
    });
    const mine = (
      await app.inject({ method: 'GET', url: '/api/ai/router/decisions', headers: ownerA })
    ).json();
    expect(mine.decisions).toHaveLength(1);

    const theirs = (
      await app.inject({ method: 'GET', url: '/api/ai/router/decisions', headers: ownerB })
    ).json();
    expect(theirs.decisions).toHaveLength(0);

    const stolen = await app.inject({
      method: 'GET',
      url: `/api/ai/router/decisions/${mine.decisions[0].id}`,
      headers: ownerB,
    });
    expect(stolen.statusCode).toBe(404);
  });
});

describe('model router: preferences reach execution', () => {
  it('saves a preference and uses it for the next decision', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/ai/router/preferences',
      headers: ownerA,
      payload: {
        autoSelect: false,
        preference: 'stronger-reasoning',
        defaultModel: { connectionId: await connectionIdOf(app), modelId: 'gpt-test-mini' },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().preferences.autoSelect).toBe(false);

    const decision = (
      await app.inject({
        method: 'POST',
        url: '/api/ai/router/route',
        headers: ownerA,
        payload: { category: 'complex-reasoning' },
      })
    ).json().decision;
    expect(decision.decidedBy).toBe('user-default');
    expect(decision.selected.modelId).toBe('gpt-test-mini');
  });

  it('mirrors the default into the gateway so other services use it too', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const connectionId = await connectionIdOf(app);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/ai/router/preferences',
      headers: ownerA,
      payload: { defaultModel: { connectionId, modelId: 'gpt-test-mini' } },
    });
    expect(saved.json().appliedToExecution).toBe(true);

    // The gateway's own preferences now carry the same choice.
    const gatewayPreferences = (
      await app.inject({
        method: 'GET',
        url: '/api/ai/providers/preferences',
        headers: ownerA,
      })
    ).json();
    expect(gatewayPreferences.defaultConnectionId).toBe(connectionId);
    expect(gatewayPreferences.defaultModelId).toBe('gpt-test-mini');
  });

  it('refuses a preference for a model that is not on the connection', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/router/preferences',
      headers: ownerA,
      payload: {
        defaultModel: { connectionId: await connectionIdOf(app), modelId: 'gpt-9-ultra' },
      },
    });
    console.log('ISO BODY', response.statusCode, response.body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('ROUTER_PREFERENCE_UNUSABLE');
  });

  it('refuses a project preference for a project that is not the caller’s', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: ownerA,
      payload: {
        name: 'Router project',
        projectType: 'web',
        description: 'A project used to prove project preferences are owner-scoped.',
      },
    });
    const projectId = created.json().id as string;

    const mine = await app.inject({
      method: 'PUT',
      url: '/api/ai/router/preferences',
      headers: ownerA,
      payload: {
        projectPreferences: {
          [projectId]: {
            connectionId: await connectionIdOf(app),
            modelId: 'gpt-test-mini',
          },
        },
      },
    });
    expect(mine.statusCode).toBe(200);

    const theirs = await app.inject({
      method: 'PUT',
      url: '/api/ai/router/preferences',
      headers: ownerB,
      payload: {
        projectPreferences: {
          [projectId]: { connectionId: 'whatever', modelId: 'whatever' },
        },
      },
    });
    expect(theirs.statusCode).toBe(404);
  });
});

describe('model router: generation seam', () => {
  it('routes a generation request that names no model, and reports the decision', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/generate',
      headers: ownerA,
      payload: {
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
        category: 'general-conversation',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.modelId).toBe('gpt-test-mini');
    expect(body.routing.summary).toMatch(/because it declares/i);
  });

  it('refuses generation honestly when nothing can be routed', async () => {
    const { app } = appWithTransport();
    await connect(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/generate',
      headers: ownerA,
      payload: {
        messages: [{ role: 'user', content: 'Read this video.' }],
        category: 'video-understanding',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/not available yet/i);
  });

  it('records execution evidence so the router can rank speed later', async () => {
    const { app } = appWithTransport();
    await connect(app);
    await app.inject({
      method: 'POST',
      url: '/api/ai/providers/generate',
      headers: ownerA,
      payload: { messages: [{ role: 'user', content: 'Hello' }] },
    });
    const recorded = await app.inject({
      method: 'POST',
      url: '/api/ai/router/outcomes',
      headers: ownerA,
      payload: {
        providerId: 'openai',
        modelId: 'gpt-test-mini',
        status: 'success',
        latencyMs: 120,
      },
    });
    expect(recorded.statusCode).toBe(204);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/ai/router/outcomes',
      headers: ownerA,
      payload: { providerId: 'openai' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

async function connectionIdOf(app: ReturnType<typeof buildApp>): Promise<string> {
  const list = (
    await app.inject({ method: 'GET', url: '/api/ai/providers', headers: ownerA })
  ).json();
  return list.providers[0].id as string;
}
