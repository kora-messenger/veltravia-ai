import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';

/**
 * The chat model picker: Automatic plus the models a person's own connections
 * report, one pinned choice per person, and an honest refusal for anything else.
 */

const ownerA = { 'x-veltravia-owner-ref': 'pin-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'pin-owner-b' };

function build() {
  const aiGateway = createGatewayService({
    keyring: createTestKeyring([1]),
    transport: new FixtureProviderTransport(),
  });
  return buildApp({ aiGateway });
}

async function connect(app: ReturnType<typeof buildApp>, headers = ownerA) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers,
    payload: { providerId: 'openai', apiKey: TEST_OPENAI_KEY, displayName: 'Work key' },
  });
  expect(response.statusCode).toBeLessThan(300);
}

async function picker(app: ReturnType<typeof buildApp>, headers = ownerA) {
  const response = await app.inject({ method: 'GET', url: '/api/reasoning/models', headers });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    automatic: { label: string };
    models: { connectionId: string; modelId: string; label: string; providerName: string }[];
    choice: { modelId: string; label: string } | null;
  };
}

describe('chat model picker', () => {
  it('offers Automatic first and starts on it', async () => {
    const app = build();
    await connect(app);
    const data = await picker(app);
    expect(data.automatic.label).toBe('Automatic');
    expect(data.choice).toBeNull();
    expect(data.models.length).toBeGreaterThan(0);
    await app.close();
  });

  it("lists only models from the caller's own connections", async () => {
    const app = build();
    await connect(app, ownerA);
    expect((await picker(app, ownerA)).models.length).toBeGreaterThan(0);
    expect((await picker(app, ownerB)).models).toEqual([]);
    await app.close();
  });

  it('pins a listed model, shows it in capabilities, and returns to Automatic', async () => {
    const app = build();
    await connect(app);
    const pick = (await picker(app)).models[0]!;

    const pinned = await app.inject({
      method: 'PUT',
      url: '/api/reasoning/model',
      headers: ownerA,
      payload: { connectionId: pick.connectionId, modelId: pick.modelId },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().choice.label).toBe(pick.label);

    const caps = (
      await app.inject({ method: 'GET', url: '/api/reasoning', headers: ownerA })
    ).json();
    expect(caps.model.modelId).toBe(pick.modelId);

    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/reasoning/model',
      headers: ownerA,
      payload: { automatic: true },
    });
    expect(cleared.json().choice).toBeNull();
    expect((await picker(app)).choice).toBeNull();
    await app.close();
  });

  it("refuses a model that is not on the caller's connections", async () => {
    const app = build();
    await connect(app);
    const refused = await app.inject({
      method: 'PUT',
      url: '/api/reasoning/model',
      headers: ownerA,
      payload: { connectionId: 'conn_missing', modelId: 'not-a-model' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('REASONING_MODEL_UNKNOWN');
    expect((await picker(app)).choice).toBeNull();
    await app.close();
  });

  it("keeps one person's pin from changing another's", async () => {
    const app = build();
    await connect(app, ownerA);
    await connect(app, ownerB);
    const pick = (await picker(app, ownerA)).models[0]!;
    await app.inject({
      method: 'PUT',
      url: '/api/reasoning/model',
      headers: ownerA,
      payload: { connectionId: pick.connectionId, modelId: pick.modelId },
    });
    expect((await picker(app, ownerA)).choice).not.toBeNull();
    expect((await picker(app, ownerB)).choice).toBeNull();
    await app.close();
  });
});
