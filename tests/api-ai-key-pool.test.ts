import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
  type TransportRequest,
} from '@veltravia/ai-gateway-mock';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';

/**
 * Step 36 wiring: multiple keys per connection, through the shipping HTTP
 * surface. A key is a bucket of quota, so the interesting cases are the ones a
 * single key could not express - rotate, retire, and refuse honestly.
 */

const ownerA = { 'x-veltravia-owner-ref': 'pool-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'pool-owner-b' };
const SECOND_KEY = 'sk-pool-second-00000000000000000';

function harness() {
  const limited = new Set<string>();
  const rejected = new Set<string>();
  const transport = new FixtureProviderTransport({
    override: (request: TransportRequest) => {
      const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (rejected.has(key)) {
        return {
          status: 401,
          headers: {},
          body: { error: { message: 'invalid api key' } },
          text: JSON.stringify({ error: { message: 'invalid api key' } }),
        };
      }
      if (!limited.has(key)) return undefined;
      return {
        status: 429,
        headers: { 'retry-after': '30' },
        body: { error: { message: 'quota' } },
        text: JSON.stringify({ error: { message: 'quota' } }),
      };
    },
  });
  const aiGateway = createGatewayService({
    keyring: createTestKeyring([1]),
    transport,
    // 5s is the production floor; a test that waited it would time out.
    rateLimitFloorMs: 1,
  });
  return { app: buildApp({ aiGateway }), limited, rejected };
}

async function connect(app: ReturnType<typeof buildApp>, headers = ownerA) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers,
    payload: { providerId: 'openai', apiKey: TEST_OPENAI_KEY },
  });
  expect(created.statusCode).toBe(201);
  return created.json().connection as { id: string; keys: unknown[] };
}

describe('AI provider gateway: key pool routes', () => {
  it('reports one key on a brand new connection', async () => {
    const { app } = harness();
    const connection = await connect(app);
    expect(connection.keys).toHaveLength(1);
  });

  it('adds a second key and shows both without leaking a secret', async () => {
    const { app } = harness();
    const connection = await connect(app);
    const added = await app.inject({
      method: 'POST',
      url: `/api/ai/providers/connections/${connection.id}/keys`,
      headers: ownerA,
      payload: { apiKey: SECOND_KEY, label: 'Backup' },
    });
    expect(added.statusCode).toBe(201);
    const body = added.json();
    expect(body.connection.keys).toHaveLength(2);
    expect(body.connection.keys[1].label).toBe('Backup');
    expect(JSON.stringify(body)).not.toContain(SECOND_KEY);
    expect(JSON.stringify(body)).not.toContain('cred_');
  });

  it('refuses a key the provider rejects instead of storing it', async () => {
    const { app, rejected } = harness();
    const connection = await connect(app);
    const badKey = 'sk-rejected-key-000000000000';
    rejected.add(badKey);
    const refused = await app.inject({
      method: 'POST',
      url: `/api/ai/providers/connections/${connection.id}/keys`,
      headers: ownerA,
      payload: { apiKey: badKey },
    });
    // A rejected key is a caller-side problem, reported the same way connect
    // reports one (category 'auth' -> 400), with plain words not vendor text.
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.json())).not.toContain('invalid api key');

    // And the pool is untouched, so a later generate cannot spend it.
    const providers = await app.inject({
      method: 'GET',
      url: '/api/ai/providers',
      headers: ownerA,
    });
    expect(providers.json().providers[0].keys).toHaveLength(1);
  });

  it('will not let another owner add or remove a key', async () => {
    const { app } = harness();
    const connection = await connect(app);
    const foreignAdd = await app.inject({
      method: 'POST',
      url: `/api/ai/providers/connections/${connection.id}/keys`,
      headers: ownerB,
      payload: { apiKey: SECOND_KEY },
    });
    expect(foreignAdd.statusCode).toBe(404);

    const foreignList = await app.inject({
      method: 'GET',
      url: '/api/ai/providers',
      headers: ownerB,
    });
    expect(foreignList.json().providers).toEqual([]);
  });

  it('removes a pooled key and refuses to remove the last one', async () => {
    const { app } = harness();
    const connection = await connect(app);
    const added = (
      await app.inject({
        method: 'POST',
        url: `/api/ai/providers/connections/${connection.id}/keys`,
        headers: ownerA,
        payload: { apiKey: SECOND_KEY },
      })
    ).json();
    const spareId = added.connection.keys[1].id as string;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/ai/providers/connections/${connection.id}/keys/${spareId}`,
      headers: ownerA,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().connection.keys).toHaveLength(1);

    const last = await app.inject({
      method: 'DELETE',
      url: `/api/ai/providers/connections/${connection.id}/keys/${removed.json().connection.keys[0].id as string}`,
      headers: ownerA,
    });
    expect(last.statusCode).toBe(400);
  });

  it('keeps generating from a second key after the first is rate limited', async () => {
    const { app, limited } = harness();
    const connection = await connect(app);
    await app.inject({
      method: 'POST',
      url: `/api/ai/providers/connections/${connection.id}/keys`,
      headers: ownerA,
      payload: { apiKey: SECOND_KEY },
    });
    limited.add(TEST_OPENAI_KEY);

    const first = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/generate',
      headers: ownerA,
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().content.length).toBeGreaterThan(0);

    // The spent key is now cooling, and that is visible to the owner.
    const providers = await app.inject({
      method: 'GET',
      url: '/api/ai/providers',
      headers: ownerA,
    });
    const view = providers.json().providers[0];
    const states = view.keys.map((key: { status: string }) => key.status);
    expect(states).toContain('cooling');
  });

  it('says plainly when every key needs to wait', async () => {
    const { app, limited } = harness();
    const connection = await connect(app);
    await app.inject({
      method: 'POST',
      url: `/api/ai/providers/connections/${connection.id}/keys`,
      headers: ownerA,
      payload: { apiKey: SECOND_KEY },
    });
    limited.add(TEST_OPENAI_KEY);
    limited.add(SECOND_KEY);

    const refused = await app.inject({
      method: 'POST',
      url: '/api/ai/providers/generate',
      headers: ownerA,
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.message).toMatch(/soonest frees up in \d+s/);
  });
});
