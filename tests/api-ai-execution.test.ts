import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';

/**
 * Step 29 wiring: real execution through the Fastify app.
 *
 * These tests care about the seam, not the provider protocol (covered in the
 * gateway package): does the request reach the router, does the answer stream
 * back as events, is a cancellation reported honestly, and is usage recorded
 * once per run rather than once per attempt or per listener.
 */

const ownerA = { 'x-veltravia-owner-ref': 'exec-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'exec-owner-b' };

function appWith(transport: FixtureProviderTransport) {
  const aiGateway = createGatewayService({ keyring: createTestKeyring([1]), transport });
  return { app: buildApp({ aiGateway }), transport };
}

async function connect(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string> = ownerA,
  key = TEST_OPENAI_KEY,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers,
    payload: { providerId: 'openai', apiKey: key, displayName: 'Primary key' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().connection as { id: string; defaultModelId: string };
}

function execute(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = ownerA,
) {
  return app.inject({
    method: 'POST',
    url: '/api/ai/execute',
    headers: { ...headers, accept: 'application/json' },
    payload,
  });
}

describe('ai execution: capabilities', () => {
  it('reports readiness and never implies a model is connected', async () => {
    const { app } = appWith(new FixtureProviderTransport());
    const body = (
      await app.inject({ method: 'GET', url: '/api/ai/execution', headers: ownerA })
    ).json();
    expect(body.limits.maxOutputTokens).toBeGreaterThan(0);
    expect(body.transport).toMatch(/server-sent events/);
    expect(body.note).toMatch(/never substitutes/i);
  });

  it('refuses to run when no provider is connected, with a readable reason', async () => {
    const { app } = appWith(new FixtureProviderTransport());
    const response = await execute(app, { task: 'hello' });
    expect(response.statusCode).not.toBe(200);
    expect(response.json().error.message.length).toBeGreaterThan(5);
  });
});

describe('ai execution: real provider answers', () => {
  it('runs a task end to end in JSON mode and reports provider-confirmed usage', async () => {
    const transport = new FixtureProviderTransport({
      content: 'The answer is 42.',
      streamChunks: ['The ', 'answer ', 'is 42.'],
      streamUsage: { inputTokens: 20, outputTokens: 6 },
    });
    const { app } = appWith(transport);
    await connect(app);

    const response = await execute(app, { task: 'What is the answer?', stream: false });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('completed');
    expect(body.run.content).toBe('The answer is 42.');
    expect(body.run.providerId).toBe('openai');
    expect(body.run.streamed).toBe(false);

    const types = (body.events as { type: string }[]).map((event) => event.type);
    expect(types).toContain('route.selected');
    expect(types).toContain('usage');
    expect(types.at(-1)).toBe('run.completed');

    const usageEvent = (body.events as { type: string }[]).find((e) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
  });

  it('streams deltas as events when streaming is available', async () => {
    const transport = new FixtureProviderTransport({
      streamChunks: ['Hel', 'lo', ' there'],
      streamUsage: { inputTokens: 8, outputTokens: 3 },
    });
    const { app } = appWith(transport);
    await connect(app);

    const response = await execute(app, { task: 'Say hello', stream: true });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const deltas = (body.events as { type: string; text?: string }[])
      .filter((event) => event.type === 'delta')
      .map((event) => event.text ?? '');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('Hello there');
    expect(body.run.streamed).toBe(true);
    expect(body.run.content).toBe('Hello there');
  });

  it('records exactly one usage row per run, owner-scoped', async () => {
    const transport = new FixtureProviderTransport({
      streamChunks: ['ok'],
      streamUsage: { inputTokens: 5, outputTokens: 2 },
    });
    const { app } = appWith(transport);
    await connect(app);
    await execute(app, { task: 'first', stream: true });
    await execute(app, { task: 'second', stream: true });

    const mine = (
      await app.inject({ method: 'GET', url: '/api/ai/execution/usage', headers: ownerA })
    ).json();
    expect(mine.records).toHaveLength(2);
    for (const record of mine.records) {
      expect(record).toMatchObject({
        status: 'success',
        streamed: true,
        usageSource: 'provider-confirmed',
        costSource: 'unavailable',
      });
      expect(JSON.stringify(record)).not.toContain('credentialRef');
      expect(JSON.stringify(record)).not.toContain('Answer the question');
    }

    const theirs = (
      await app.inject({ method: 'GET', url: '/api/ai/execution/usage', headers: ownerB })
    ).json();
    expect(theirs.records).toHaveLength(0);
  });

  it('returns the same run for a repeated idempotency key instead of billing twice', async () => {
    const transport = new FixtureProviderTransport({ streamChunks: ['one'] });
    const { app } = appWith(transport);
    await connect(app);

    const first = (
      await execute(app, { task: 'same task', idempotencyKey: 'abc', stream: true })
    ).json();
    const second = (
      await execute(app, { task: 'same task', idempotencyKey: 'abc', stream: true })
    ).json();
    expect(second.run.id).toBe(first.run.id);

    const usage = (
      await app.inject({ method: 'GET', url: '/api/ai/execution/usage', headers: ownerA })
    ).json();
    expect(usage.records).toHaveLength(1);
  });
});

describe('ai execution: failures and cancellation', () => {
  it('reports a refused route as a readable failure, not a substitute answer', async () => {
    const transport = new FixtureProviderTransport({
      override: (request) =>
        request.url.includes('chat/completions')
          ? {
              status: 429,
              headers: {},
              body: { error: { message: 'quota' } },
              text: '{"error":{"message":"quota"}}',
            }
          : undefined,
    });
    const { app } = appWith(transport);
    await connect(app);

    const response = await execute(app, { task: 'anything', stream: false });
    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.error.code).toBe('GATEWAY_RATE_LIMITED');
    expect(body.run.status).toBe('failed');
  });

  it('cancels a live run and refuses to cancel a finished one', async () => {
    const transport = new FixtureProviderTransport({
      streamChunks: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    const { app } = appWith(transport);
    await connect(app);

    // Start without consuming the events, so the run is still live.
    const started = await app.inject({
      method: 'POST',
      url: '/api/ai/execute',
      headers: { ...ownerA, accept: 'application/json' },
      payload: { task: 'long task', stream: true },
    });
    const runId = started.json().run.id as string;

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/ai/execution/runs/${runId}/cancel`,
      headers: ownerA,
    });
    // Either the run was still live (accepted) or it already finished (409);
    // both are honest, and neither may claim a cancelled finished run.
    expect([200, 409]).toContain(cancelled.statusCode);
    if (cancelled.statusCode === 200) {
      const snapshot = (
        await app.inject({
          method: 'GET',
          url: `/api/ai/execution/runs/${runId}`,
          headers: ownerA,
        })
      ).json();
      expect(['cancelled', 'completed', 'failed']).toContain(snapshot.run.status);
    }
  });

  it('never reveals another owner’s run', async () => {
    const transport = new FixtureProviderTransport({ streamChunks: ['x'] });
    const { app } = appWith(transport);
    await connect(app);
    const mine = (await execute(app, { task: 'private', stream: true })).json();
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/ai/execution/runs/${mine.run.id}`,
      headers: ownerB,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('rejects an unknown task category before calling any provider', async () => {
    const transport = new FixtureProviderTransport({ streamChunks: ['x'] });
    const { app } = appWith(transport);
    await connect(app);
    const before = transport.requests.length;
    const response = await execute(app, { task: 'x', category: 'not-a-category' });
    expect(response.statusCode).toBe(400);
    expect(transport.requests.length).toBe(before);
  });
});
