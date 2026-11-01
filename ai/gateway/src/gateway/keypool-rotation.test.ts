import { describe, expect, it } from 'vitest';

import { AIProviderGateway, type GatewayOptions } from '../gateway/index.js';
import { CredentialVault } from '../vault/index.js';
import { InMemoryConnectionStore, InMemoryPreferenceStore } from '../store/index.js';
import { InMemoryUsageStore } from '../usage/index.js';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
  type TransportRequest,
} from '../../mock/src/index.js';

/**
 * A provider key is a bucket of quota. These tests prove the pool spends a
 * second bucket when the first is empty, retires a key the provider rejects,
 * and stays honest when nothing is left - the three things a single-key engine
 * could not do.
 */

const SECOND_KEY = 'sk-second-key-0000000000000000';
const THIRD_KEY = 'sk-third-key-0000000000000000';

function setup(options: { now?: () => Date } = {}) {
  // Which keys the fake provider refuses, and how. Mutable so a test can arm
  // the refusal only after the connection has been validated.
  const state: {
    limited: Set<string>;
    rejected: Set<string>;
    limitedRequests: number;
    retryAfter: string | null;
  } = { limited: new Set(), rejected: new Set(), limitedRequests: 0, retryAfter: '3' };

  const transport = new FixtureProviderTransport({
    models: ['gpt-a', 'gpt-b'],
    override: (request: TransportRequest) => {
      const auth = request.headers.authorization ?? '';
      const key = auth.replace(/^Bearer\s+/i, '');
      if (state.rejected.has(key)) {
        return {
          status: 401,
          headers: {},
          body: { error: { message: 'invalid api key' } },
          text: JSON.stringify({ error: { message: 'invalid api key' } }),
        };
      }
      if (state.limited.has(key)) {
        state.limitedRequests += 1;
        return {
          status: 429,
          headers: state.retryAfter === null ? {} : { 'retry-after': state.retryAfter },
          body: { error: { message: 'quota' } },
          text: JSON.stringify({ error: { message: 'quota' } }),
        };
      }
      return undefined;
    },
  });

  const gatewayOptions: GatewayOptions = {
    vault: new CredentialVault({ keyring: createTestKeyring([1]) }),
    connections: new InMemoryConnectionStore(),
    preferences: new InMemoryPreferenceStore(),
    usage: new InMemoryUsageStore(),
    transport,
    resolveHost: async () => ['93.184.216.34'],
    ...(options.now ? { now: options.now } : {}),
    rateLimitFloorMs: 1,
  };
  return { gateway: new AIProviderGateway(gatewayOptions), transport, state };
}

const ownerA = { ownerRef: 'owner-a' };

const ask = { messages: [{ role: 'user' as const, content: 'hello' }] };

describe('key pool: rotation', () => {
  it('serves the request from a second key when the first is rate limited', async () => {
    const { gateway, state } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
      displayName: 'Primary',
    });
    await gateway.addKey(ownerA, connection.id, { apiKey: SECOND_KEY, label: 'Spare' });
    state.limited.add(TEST_OPENAI_KEY);

    const outcome = await gateway.generate(ownerA, { messages: ask.messages });
    expect(outcome.content.length).toBeGreaterThan(0);
    expect(state.limitedRequests).toBe(1);

    const after = await gateway.getConnection(ownerA, connection.id);
    const stored = after?.keys ?? [];
    // The masked hint is only the last 4 characters, so keys are read by the
    // order they were added, never by a hint that two keys can share.
    expect(stored[0]?.status).toBe('cooling');
    expect(stored[0]?.cooldownUntil).toBeDefined();
    expect(stored[1]?.status).toBe('active');
  });

  it('reports the wait plainly when every key on the connection is spent', async () => {
    const { gateway, state } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
      displayName: 'Primary',
    });
    state.retryAfter = '45';
    state.limited.add(TEST_OPENAI_KEY);

    const first = await gateway.generate(ownerA, { messages: ask.messages }).catch((e) => e);
    expect(first.code).toBe('GATEWAY_RATE_LIMITED');
    expect(first.details?.reason).toBe('all-keys-cooling');

    // Now add a second key and spend it too: the refusal must name a wait and
    // the number of keys, not pretend the provider is down.
    await gateway.addKey(ownerA, connection.id, { apiKey: SECOND_KEY });
    state.limited.add(SECOND_KEY);
    const second = await gateway.generate(ownerA, { messages: ask.messages }).catch((e) => e);
    expect(second.code).toBe('GATEWAY_RATE_LIMITED');
    expect(second.details?.reason).toBe('all-keys-cooling');
    expect(second.details?.keyCount).toBe(2);
    expect(second.message).toMatch(/soonest frees up in \d+s/);
    expect(second.details?.retryAfterMs).toBeGreaterThan(0);
  });

  it('refuses immediately while every key is cooling instead of hammering the provider', async () => {
    const { gateway, state } = setup();
    await gateway.createConnection(ownerA, { providerId: 'openai', apiKey: TEST_OPENAI_KEY });
    state.retryAfter = '60';
    state.limited.add(TEST_OPENAI_KEY);
    await gateway.generate(ownerA, { messages: ask.messages }).catch(() => undefined);
    const spent = state.limitedRequests;

    const refused = await gateway.generate(ownerA, { messages: ask.messages }).catch((e) => e);
    expect(refused.code).toBe('GATEWAY_RATE_LIMITED');
    expect(state.limitedRequests).toBe(spent);
  });

  it('retires a key the provider rejects and keeps serving on the next one', async () => {
    const { gateway, state } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    await gateway.addKey(ownerA, connection.id, { apiKey: SECOND_KEY });
    state.rejected.add(TEST_OPENAI_KEY);

    const outcome = await gateway.generate(ownerA, { messages: ask.messages });
    expect(outcome.content.length).toBeGreaterThan(0);

    const after = await gateway.getConnection(ownerA, connection.id);
    const retired = after?.keys?.[0];
    expect(retired?.status).toBe('invalid');
    expect(retired?.lastErrorCategory).toBe('authentication');
    expect(after?.keys?.[1]?.status).toBe('active');
  });

  it('refuses with GATEWAY_AUTH_FAILED when every key has been rejected', async () => {
    const { gateway, state } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    state.rejected.add(TEST_OPENAI_KEY);
    await gateway.generate(ownerA, { messages: ask.messages }).catch(() => undefined);

    const refused = await gateway.generate(ownerA, { messages: ask.messages }).catch((e) => e);
    expect(refused.code).toBe('GATEWAY_AUTH_FAILED');
    expect(refused.details?.reason).toBe('all-keys-invalid');
    expect((await gateway.getConnection(ownerA, connection.id))?.status).toBe('invalid');
  });

  it('spreads load over the least recently used key', async () => {
    const { gateway } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    await gateway.addKey(ownerA, connection.id, { apiKey: SECOND_KEY });

    // First call spends the fresh key, so the second call should move on rather
    // than making one key carry every request.
    await gateway.generate(ownerA, { messages: ask.messages });
    const first = (await gateway.getConnection(ownerA, connection.id))?.keys ?? [];
    expect(first.filter((key) => key.lastUsedAt !== undefined)).toHaveLength(1);

    await gateway.generate(ownerA, { messages: ask.messages });
    const second = (await gateway.getConnection(ownerA, connection.id))?.keys ?? [];
    expect(second.filter((key) => key.lastUsedAt !== undefined)).toHaveLength(2);
    // ...and the second call went to the key that had never been spent.
    expect(second[0]?.lastUsedAt).toBeDefined();
    expect(second[1]?.lastUsedAt).toBeDefined();
  });

  it('streams from a second key when the first is spent, before any text is sent', async () => {
    const { gateway, state } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    await gateway.addKey(ownerA, connection.id, { apiKey: SECOND_KEY });
    state.limited.add(TEST_OPENAI_KEY);

    let text = '';
    for await (const chunk of gateway.stream(ownerA, { messages: ask.messages })) {
      text += chunk.delta;
    }
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('key pool: managing keys', () => {
  it('checks a new key before storing it', async () => {
    const { gateway, state } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    state.rejected.add(SECOND_KEY);
    const refused = await gateway
      .addKey(ownerA, connection.id, { apiKey: SECOND_KEY })
      .catch((e) => e);
    expect(refused.code).toBe('GATEWAY_CREDENTIAL_INVALID');
    expect((await gateway.getConnection(ownerA, connection.id))?.keys).toHaveLength(1);
  });

  it('refuses the same key twice', async () => {
    const { gateway } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    const refused = await gateway
      .addKey(ownerA, connection.id, { apiKey: TEST_OPENAI_KEY })
      .catch((e) => e);
    expect(refused.code).toBe('GATEWAY_CONNECTION_DUPLICATE');
  });

  it('caps how many keys one connection may pool', async () => {
    const { gateway } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    for (const key of [SECOND_KEY, THIRD_KEY]) {
      await gateway.addKey(ownerA, connection.id, { apiKey: key });
    }
    const extra = `sk-extra-key-${'9'.repeat(20)}`;
    // The default cap is 8; this test proves the guard exists, not the number.
    let refused: { code?: string } | undefined;
    for (let index = 0; index < 10; index += 1) {
      const key = `sk-bulk-${String(index).padStart(20, '0')}`;
      const result = await gateway.addKey(ownerA, connection.id, { apiKey: key }).catch((e) => e);
      if (result?.code === 'GATEWAY_LIMIT_EXCEEDED') {
        refused = result;
        break;
      }
    }
    expect(refused?.code).toBe('GATEWAY_LIMIT_EXCEEDED');
    void extra;
  });

  it('removes a key and refuses to remove the last one', async () => {
    const { gateway } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    const withKey = await gateway.addKey(ownerA, connection.id, { apiKey: SECOND_KEY });
    const removed = await gateway.removeKey(ownerA, connection.id, withKey.keys[1]?.id as string);
    expect(removed.keys).toHaveLength(1);

    const refused = await gateway
      .removeKey(ownerA, connection.id, removed.keys[0]?.id as string)
      .catch((e) => e);
    expect(refused.code).toBe('GATEWAY_INVALID_REQUEST');
  });

  it('never exposes a secret or a vault reference through a view', async () => {
    const { gateway } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    await gateway.addKey(ownerA, connection.id, { apiKey: SECOND_KEY, label: 'Spare' });
    const entries = await gateway.listConnections(ownerA);
    const view = entries[0]?.connection;
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(TEST_OPENAI_KEY);
    expect(serialized).not.toContain(SECOND_KEY);
    expect(serialized).not.toContain('cred_');
    expect(view?.keys[1]?.label).toBe('Spare');
  });

  it("keeps one owner out of another owner's keys", async () => {
    const { gateway } = setup();
    const connection = await gateway.createConnection(ownerA, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    const refused = await gateway
      .addKey({ ownerRef: 'owner-b' }, connection.id, { apiKey: SECOND_KEY })
      .catch((e) => e);
    expect(refused.code).toBe('GATEWAY_CONNECTION_NOT_FOUND');
  });
});
