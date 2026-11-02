import { describe, expect, it } from 'vitest';

import {
  AIProviderGateway,
  CredentialVault,
  InMemoryConnectionStore,
  InMemoryPreferenceStore,
  InMemoryUsageStore,
  InMemoryVaultRecordStore,
} from '@veltravia/ai-gateway';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';

import {
  OPENROUTER_DEFAULT_MODEL,
  readOpenRouterKeys,
  seedOpenRouterPool,
} from '../apps/api/src/provider-pool-bootstrap.js';

/**
 * Step 36: the OpenRouter pool seeded from the environment.
 *
 * What matters: a restart brings the keys back without a settings visit, a
 * duplicated or malformed value is reported instead of stored as capacity, and
 * a pool with more than one key never waits on a cooldown.
 */

// Assembled at runtime so no credential-shaped literal sits in the repository
// (GitHub push protection blocks such strings, and a real key must never look
// like a test fixture either).
const FAKE_KEY_PREFIX = 'sk-or-' + 'v1-';
const KEY_A = FAKE_KEY_PREFIX + 'a'.repeat(64);
const KEY_B = FAKE_KEY_PREFIX + 'b'.repeat(64);
const KEY_C = FAKE_KEY_PREFIX + 'c'.repeat(64);

function envWith(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

function harness(transport = new FixtureProviderTransport()) {
  const gateway = new AIProviderGateway({
    vault: new CredentialVault({
      keyring: createTestKeyring([1]),
      store: new InMemoryVaultRecordStore(),
    }),
    connections: new InMemoryConnectionStore(),
    preferences: new InMemoryPreferenceStore(),
    usage: new InMemoryUsageStore(),
    transport,
    rateLimitFloorMs: 5000,
  });
  return { gateway, transport };
}

const scope = { ownerRef: 'pool-owner' };

describe('readOpenRouterKeys', () => {
  it('reads only the primary key and ignores numbered variants', () => {
    const { keys, skipped } = readOpenRouterKeys(
      envWith({
        OPENROUTER_API_KEY_10: KEY_C,
        OPENROUTER_API_KEY_2: KEY_B,
        OPENROUTER_API_KEY: KEY_A,
        OPENROUTER_API_KEY_3: KEY_B, // saved twice: not extra quota
        OPENROUTER_API_KEY_4: FAKE_KEY_PREFIX + 'too-short', // truncated paste
        UNRELATED: KEY_A,
      }),
    );
    expect(keys).toEqual([KEY_A]);
    expect(skipped).toBe(0);
  });

  it('finds nothing in an environment without OpenRouter values', () => {
    expect(readOpenRouterKeys(envWith({ OPENAI_API_KEY: 'x' })).keys).toEqual([]);
  });
});

describe('seedOpenRouterPool', () => {
  it('creates one connection holding every usable key, and makes it the default', async () => {
    const { gateway } = harness();
    const result = await seedOpenRouterPool(gateway, scope.ownerRef, {
      keys: [KEY_A, KEY_B, KEY_C],
    });

    expect(result.connectionId).not.toBeNull();
    expect(result.keysAdded).toBe(3);
    expect(result.problems).toEqual([]);
    expect(result.defaultModelId).toBe(OPENROUTER_DEFAULT_MODEL);

    const entries = await gateway.listConnections(scope);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.connection.providerId).toBe('openrouter');
    expect(entries[0]?.connection.keys).toHaveLength(3);
    // Masks only: no key and no vault reference crosses the boundary.
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain(KEY_A);
    expect(serialized).not.toContain('cred_');

    const preferences = await gateway.getPreferences(scope);
    expect(preferences.defaultConnectionId).toBe(result.connectionId);
    expect(preferences.defaultModelId).toBe(OPENROUTER_DEFAULT_MODEL);
  });

  it('adds only the new keys on a second run', async () => {
    const { gateway } = harness();
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      env: envWith({ OPENROUTER_API_KEY: KEY_A }),
    });
    const second = await seedOpenRouterPool(gateway, scope.ownerRef, {
      keys: [KEY_A, KEY_B],
    });
    expect(second.keysAdded).toBe(1);
    expect(second.keysAlreadyPresent).toBe(1);

    const third = await seedOpenRouterPool(gateway, scope.ownerRef, {
      keys: [KEY_A, KEY_B],
    });
    expect(third.keysAdded).toBe(0);
    expect(third.keysAlreadyPresent).toBe(2);
    expect((await gateway.listConnections(scope))[0]?.connection.keys).toHaveLength(2);
  });

  it('says so when the saved value cannot be used', async () => {
    const { gateway } = harness();
    const result = await seedOpenRouterPool(gateway, scope.ownerRef, {
      env: envWith({ OPENROUTER_API_KEY: FAKE_KEY_PREFIX + 'truncated' }),
    });
    expect(result.keysAdded).toBe(0);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/not a usable key/);
  });

  it('ignores a second key in the environment', async () => {
    // One key at a time: a fresh one is handed over when this one is spent.
    const { gateway } = harness();
    const result = await seedOpenRouterPool(gateway, scope.ownerRef, {
      env: envWith({ OPENROUTER_API_KEY: KEY_A, OPENROUTER_API_KEY_2: KEY_B }),
    });
    expect(result.keysAdded).toBe(1);
    const entries = await gateway.listConnections(scope);
    expect(entries[0]?.connection.keys).toHaveLength(1);
  });

  it('does nothing when no key is configured, and leaves a set default alone', async () => {
    const { gateway } = harness();
    const empty = await seedOpenRouterPool(gateway, scope.ownerRef, { env: envWith({}) });
    expect(empty.connectionId).toBeNull();
    expect(await gateway.listConnections(scope)).toEqual([]);

    // A connection the developer chose by hand keeps the default.
    const manual = await gateway.createConnection(scope, {
      providerId: 'openai',
      apiKey: TEST_OPENAI_KEY,
    });
    await gateway.setPreferences(scope, {
      defaultConnectionId: manual.id,
      defaultModelId: manual.modelIds[0] as string,
    });
    const seeded = await seedOpenRouterPool(gateway, scope.ownerRef, {
      env: envWith({ OPENROUTER_API_KEY: KEY_A }),
    });
    expect(seeded.connectionId).not.toBe(manual.id);
    const preferences = await gateway.getPreferences(scope);
    expect(preferences.defaultConnectionId).toBe(manual.id);
  });
});

describe('a 402 with nothing affordable is a spent key', () => {
  it('rotates instead of lowering the ceiling', async () => {
    const broke = new Set<string>([KEY_A]);
    const transport = new FixtureProviderTransport({
      override: (request) => {
        const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!broke.has(key)) return undefined;
        const message =
          'This request requires more credits, or fewer max_tokens. You requested up to 512 tokens, but can only afford 0.';
        return {
          status: 402,
          body: { error: { message, code: 402 } },
          text: JSON.stringify({ error: { message, code: 402 } }),
        };
      },
    });
    const { gateway } = harness(transport);
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      keys: [KEY_A, KEY_B],
    });
    broke.add(KEY_A);

    const outcome = await gateway.generate(scope, {
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 512,
    });
    expect(outcome.content.length).toBeGreaterThan(0);
  });
});

describe('output tokens are bounded', () => {
  it('states an output ceiling instead of letting the provider reserve the model window', async () => {
    const transport = new FixtureProviderTransport();
    const { gateway } = harness(transport);
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      env: envWith({ OPENROUTER_API_KEY: KEY_A }),
    });
    await gateway.generate(scope, { messages: [{ role: 'user', content: 'hello' }] });

    const posted = transport.requests.filter((request) => request.method === 'POST');
    const body = posted[posted.length - 1]?.body as { max_tokens?: number } | undefined;
    // OpenRouter refused a plain "say OK" because the gateway asked for 65,536
    // output tokens; a bounded default is what makes a prepaid key usable.
    expect(body?.max_tokens).toBe(4096);
  });

  it('honours an explicit ceiling', async () => {
    const transport = new FixtureProviderTransport();
    const { gateway } = harness(transport);
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      env: envWith({ OPENROUTER_API_KEY: KEY_A }),
    });
    await gateway.generate(scope, {
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 128,
    });
    const posted = transport.requests.filter((request) => request.method === 'POST');
    expect((posted[posted.length - 1]?.body as { max_tokens?: number }).max_tokens).toBe(128);
  });

  it('does not bench a healthy key when the balance cannot reserve the request', async () => {
    // The 402 that names max_tokens is about the reservation, not a dead key.
    const transport = new FixtureProviderTransport({
      override: (request) => {
        if (request.method !== 'POST') return undefined;
        const message =
          'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 9846.';
        return {
          status: 402,
          body: { error: { message, code: 402 } },
          text: JSON.stringify({ error: { message, code: 402 } }),
        };
      },
    });
    const { gateway } = harness(transport);
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      env: envWith({ OPENROUTER_API_KEY: KEY_A }),
    });

    const failure = (await gateway
      .generate(scope, { messages: [{ role: 'user', content: 'hello' }] })
      .catch((error: unknown) => error)) as { code?: string };
    expect(failure.code).toBe('GATEWAY_INVALID_REQUEST');

    const keys = (await gateway.listConnections(scope))[0]?.connection.keys ?? [];
    expect(keys.every((key) => key.status !== 'cooling')).toBe(true);
  });
});

describe('a pool of keys never waits', () => {
  it('refuses at once when every pooled key is rate limited', async () => {
    const limited = new Set<string>();
    const transport = new FixtureProviderTransport({
      override: (request) => {
        const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!limited.has(key)) return undefined;
        return {
          status: 429,
          headers: { 'retry-after': '30' },
          body: { error: { message: 'slow down' } },
          text: JSON.stringify({ error: { message: 'slow down' } }),
        };
      },
    });
    const { gateway } = harness(transport);
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      keys: [KEY_A, KEY_B],
    });
    // The pool exists first; the limits appear later. A key that is already
    // spent cannot be the one that creates the pool.
    limited.add(KEY_A);
    limited.add(KEY_B);

    const started = Date.now();
    const failure = await gateway
      .generate(scope, { messages: [{ role: 'user', content: 'hello' }] })
      .catch((error: unknown) => error as { code?: string });
    const elapsed = Date.now() - started;

    expect(failure.code).toBe('GATEWAY_RATE_LIMITED');
    // Production floor is 5s. Serving a refusal from that wait would be the
    // slowness the pool exists to remove, so a pool must answer immediately.
    expect(elapsed).toBeLessThan(1000);
  });

  it('rotates past a key that authenticates but has no credit', async () => {
    // Two of the saved keys are real and rejected nothing, they simply cannot
    // pay. Waiting an hour would serve the wrong person: move to a key that can.
    const broke = new Set<string>([KEY_A]);
    const transport = new FixtureProviderTransport({
      override: (request) => {
        const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!broke.has(key)) return undefined;
        return {
          status: 402,
          body: { error: { message: 'insufficient credits', code: 402 } },
          text: JSON.stringify({ error: { message: 'insufficient credits', code: 402 } }),
        };
      },
    });
    const { gateway } = harness(transport);
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      keys: [KEY_A, KEY_B],
    });
    broke.add(KEY_A);

    const started = Date.now();
    const outcome = await gateway.generate(scope, {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(outcome.content.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('says every key is out of credit when none can pay', async () => {
    const broke = new Set<string>();
    const transport = new FixtureProviderTransport({
      override: (request) => {
        const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!broke.has(key)) return undefined;
        return {
          status: 402,
          body: { error: { message: 'insufficient credits', code: 402 } },
          text: JSON.stringify({ error: { message: 'insufficient credits', code: 402 } }),
        };
      },
    });
    const { gateway } = harness(transport);
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      keys: [KEY_A, KEY_B],
    });
    broke.add(KEY_A);
    broke.add(KEY_B);

    const failure = (await gateway
      .generate(scope, { messages: [{ role: 'user', content: 'hello' }] })
      .catch((error: unknown) => error)) as { code?: string; message?: string; details?: unknown };
    expect(failure.code).toBe('GATEWAY_LIMIT_EXCEEDED');
    expect(failure.message).toMatch(/out of credit/i);
    expect(failure.details).toMatchObject({ reason: 'all-keys-out-of-credit' });
  });

  it('serves a request fast while one pooled key is rate limited', async () => {
    const limited = new Set<string>();
    const transport = new FixtureProviderTransport({
      override: (request) => {
        const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!limited.has(key)) return undefined;
        return {
          status: 429,
          headers: { 'retry-after': '30' },
          body: { error: { message: 'slow down' } },
          text: JSON.stringify({ error: { message: 'slow down' } }),
        };
      },
    });
    const { gateway } = harness(transport);
    await seedOpenRouterPool(gateway, scope.ownerRef, {
      keys: [KEY_A, KEY_B],
    });
    limited.add(KEY_A);

    // Either the healthy key served it immediately or the spent one rotated to
    // it; both are the point. What must never happen is a 5s production wait.
    const started = Date.now();
    const outcome = await gateway.generate(scope, {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(outcome.content.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('a key the owner added themselves', () => {
  it('is never mixed with the environment key', async () => {
    const { gateway } = harness();
    const own = await gateway.createConnection(scope, {
      providerId: 'openrouter',
      apiKey: KEY_B,
      displayName: 'My own OpenRouter',
    });

    const result = await seedOpenRouterPool(gateway, scope.ownerRef, {
      env: envWith({ OPENROUTER_API_KEY: KEY_A }),
    });

    expect(result.keysAdded).toBe(0);
    expect(result.connectionId).toBe(own.id);
    expect(result.problems.join(' ')).toMatch(/left untouched/);

    const entries = await gateway.listConnections(scope);
    const connection = entries.find((entry) => entry.connection.id === own.id);
    expect(connection?.connection.keys).toHaveLength(1);
  });
});

describe('an unfunded OpenAI key', () => {
  it('is reported as no credit, not as rate limiting', async () => {
    // The key validates, then the account runs dry: the override must fall
    // through (undefined) until the connection exists.
    let dry = false;
    const transport = new FixtureProviderTransport({
      override: () =>
        dry
          ? {
              status: 429,
              body: {
                error: {
                  message: 'You have no credits remaining. Add credits to continue using the API.',
                  type: 'insufficient_quota',
                  code: 'insufficient_quota',
                },
              },
              text: JSON.stringify({
                error: {
                  message: 'You have no credits remaining. Add credits to continue using the API.',
                  type: 'insufficient_quota',
                  code: 'insufficient_quota',
                },
              }),
            }
          : undefined,
    });
    const { gateway } = harness(transport);
    const attempt = await gateway.createConnection(scope, {
      providerId: 'openai',
      apiKey: KEY_A,
      displayName: 'OpenAI',
    });
    expect(attempt.id).toBeTruthy();
    dry = true;
    const failure = await gateway
      .generate(scope, { messages: [{ role: 'user', content: 'hello' }] })
      .catch((error: { code?: string; message?: string }) => error);
    expect((failure as { code?: string }).code).not.toBe('GATEWAY_RATE_LIMITED');
    expect((failure as { code?: string }).code).toBe('GATEWAY_LIMIT_EXCEEDED');
  });
});
