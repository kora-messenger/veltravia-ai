import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';
import { ReasoningService } from '../apps/api/src/reasoning-service.js';
import { SimulatedReasoningProvider } from '@veltravia/reasoning-mock';

/**
 * Step 27 wiring tests: the real Fastify app. Reasoning runs through the
 * shipping gateway path against a fixture transport (no socket, no real key) or
 * through the offline mock that always says it is simulated.
 */

const ownerA = { 'x-veltravia-owner-ref': 'reasoning-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'reasoning-owner-b' };

function appWithSimulated(script?: () => SimulatedReasoningProvider) {
  const service = new ReasoningService({
    gateway: null,
    blockedReason: 'No AI provider is connected yet.',
    simulatedFactory:
      script ??
      (() =>
        new SimulatedReasoningProvider({
          replies: [
            {
              content: JSON.stringify({
                taskType: 'question',
                needsTools: false,
                rationale: 'Simple.',
              }),
            },
            {
              content: JSON.stringify({
                type: 'answer',
                answer: 'Draft answer.',
                complete: true,
                summary: 'Done.',
              }),
            },
            { content: 'The simulated answer is 42.' },
          ],
        })),
  });
  return { app: buildApp({ reasoning: service }), service };
}

function appWithGateway() {
  const steps = [
    JSON.stringify({ taskType: 'question', needsTools: false, rationale: 'Simple.' }),
    JSON.stringify({
      type: 'answer',
      answer: 'The answer is 7.',
      complete: true,
      summary: 'Done.',
    }),
    'The answer is 7.',
  ];
  let call = 0;
  const transport = new FixtureProviderTransport({
    models: ['gpt-test-mini'],
    override: (request) => {
      if (request.method !== 'POST') return undefined;
      const content = steps[Math.min(call, steps.length - 1)] ?? 'done';
      call += 1;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          id: 'chatcmpl-1',
          model: 'gpt-test-mini',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
        },
        text: '',
      };
    },
  });
  const aiGateway = createGatewayService({ keyring: createTestKeyring([1]), transport });
  const service = new ReasoningService({ gateway: aiGateway.gateway ?? null });
  return { app: buildApp({ aiGateway, reasoning: service }), service, aiGateway };
}

async function waitForRun(
  app: ReturnType<typeof buildApp>,
  runId: string,
  headers = ownerA,
  attempts = 40,
): Promise<{ status: string; answer?: string }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/reasoning/runs/${runId}`,
      headers,
    });
    if (response.statusCode === 200) {
      const run = response.json().run as { status: string; answer?: string };
      if (
        ['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_confirmation'].includes(
          run.status,
        )
      ) {
        return run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { status: 'timeout' };
}

describe('reasoning API: capabilities', () => {
  it('reports the six profiles, the limits and an honest provider state', async () => {
    const { app } = appWithSimulated();
    const response = await app.inject({ method: 'GET', url: '/api/reasoning', headers: ownerA });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.profiles.map((profile: { id: string }) => profile.id).sort()).toEqual([
      'agent',
      'coding',
      'connected-apps',
      'document',
      'intelligence',
      'workspace',
    ]);
    expect(body.provider.connected).toBe(false);
    expect(body.provider.modes).toEqual(['simulated']);
    expect(body.provider.reason).toContain('No AI provider');
    expect(body.limits.maxIterations).toBeGreaterThan(0);
    expect(body.ceilings.maxToolCalls).toBeGreaterThanOrEqual(body.limits.maxToolCalls);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/sk-/);
  });

  it('reports the gateway as connected once a provider exists', async () => {
    const { app, aiGateway } = appWithGateway();
    await app.inject({
      method: 'POST',
      url: '/api/ai/providers/connections',
      headers: ownerA,
      payload: { providerId: 'openai', apiKey: TEST_OPENAI_KEY, displayName: 'QA' },
    });
    expect(aiGateway.gateway).not.toBeNull();
    const response = await app.inject({ method: 'GET', url: '/api/reasoning', headers: ownerA });
    expect(response.json().provider.connected).toBe(true);
    expect(response.json().provider.modes).toContain('gateway');
  });
});

describe('reasoning API: runs', () => {
  it('runs on the owner provider and reports it as live', async () => {
    const { app } = appWithGateway();
    await app.inject({
      method: 'POST',
      url: '/api/ai/providers/connections',
      headers: ownerA,
      payload: { providerId: 'openai', apiKey: TEST_OPENAI_KEY, displayName: 'QA' },
    });

    // The run names its model: this test covers the gateway path, not which model
    // the router would pick (the fixture model declares no structured output).
    const connections = (
      await app.inject({ method: 'GET', url: '/api/ai/providers', headers: ownerA })
    ).json();
    const connectionId = connections.providers[0].id as string;

    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: {
        task: 'What is 3 + 4?',
        profile: 'workspace',
        mode: 'gateway',
        connectionId,
        modelId: 'gpt-test-mini',
      },
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;

    const run = await waitForRun(app, runId);
    expect(run.status).toBe('completed');
    expect(run.answer).toBe('The answer is 7.');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/reasoning/runs/${runId}`,
      headers: ownerA,
    });
    const body = detail.json().run;
    expect(body.provider).toEqual({
      providerId: 'openai',
      modelId: 'gpt-test-mini',
      live: true,
      simulated: false,
    });
    expect(body.usage.inputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(TEST_OPENAI_KEY);
  });

  it('refuses to run on the gateway when no provider is connected', async () => {
    const { app } = appWithSimulated();
    const response = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hello' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('GATEWAY_NO_PROVIDER_CONFIGURED');
    expect(response.json().error.message).toMatch(/Connect an AI provider/);
  });

  it('runs the disclosed offline mock when asked explicitly', async () => {
    const { app } = appWithSimulated();
    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hello', mode: 'simulated', profile: 'workspace' },
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    const run = await waitForRun(app, runId);
    expect(run.status).toBe('completed');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/reasoning/runs/${runId}`,
      headers: ownerA,
    });
    const body = detail.json().run;
    expect(body.provider.simulated).toBe(true);
    expect(body.provider.live).toBe(false);
    expect(body.limitations.join(' ')).toMatch(/no AI model/i);
  });

  it('keeps one owner out of another owner run', async () => {
    const { app } = appWithSimulated();
    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hello', mode: 'simulated' },
    });
    const runId = started.json().run.id as string;
    await waitForRun(app, runId);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/reasoning/runs/${runId}`,
      headers: ownerB,
    });
    expect(foreign.statusCode).toBe(404);

    const cancelForeign = await app.inject({
      method: 'POST',
      url: `/api/reasoning/runs/${runId}/cancel`,
      headers: ownerB,
    });
    expect(cancelForeign.statusCode).toBe(404);
  });

  it('refuses to cancel a finished run, keeps its answer, and 404s an unknown run', async () => {
    const { app } = appWithSimulated();
    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hello', mode: 'simulated' },
    });
    const runId = started.json().run.id as string;

    // Wait for the run to reach a terminal state before cancelling it.
    let finished = started.json().run;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (String(finished.status) !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const polled = await app.inject({
        method: 'GET',
        url: `/api/reasoning/runs/${runId}`,
        headers: ownerA,
      });
      finished = polled.json().run;
    }
    expect(finished.status).toBe('completed');

    const refused = await app.inject({
      method: 'POST',
      url: `/api/reasoning/runs/${runId}/cancel`,
      headers: ownerA,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('REASONING_RUN_NOT_CANCELLABLE');

    // The completed run was not rewritten by the refused cancellation.
    const after = await app.inject({
      method: 'GET',
      url: `/api/reasoning/runs/${runId}`,
      headers: ownerA,
    });
    expect(after.json().run.status).toBe('completed');
    expect(after.json().run.answer).toBe(finished.answer);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs/rsn_nope/cancel',
      headers: ownerA,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('REASONING_RUN_NOT_FOUND');
  });

  it('rejects an empty task and an unknown profile', async () => {
    const { app } = appWithSimulated();
    const empty = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: '' },
    });
    expect(empty.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hi', profile: 'root' },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('rejects a paused decision for a run that has no confirmation', async () => {
    const { app } = appWithSimulated();
    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hello', mode: 'simulated' },
    });
    const runId = started.json().run.id as string;
    await waitForRun(app, runId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/reasoning/runs/${runId}/confirmation`,
      headers: ownerA,
      payload: { confirmationId: 'cnf_none', decision: 'approved' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('records usage for every finished run without inventing tokens', async () => {
    const { app } = appWithSimulated();
    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hello', mode: 'simulated' },
    });
    await waitForRun(app, started.json().run.id as string);
    const usage = await app.inject({
      method: 'GET',
      url: '/api/reasoning/usage?limit=5',
      headers: ownerA,
    });
    expect(usage.statusCode).toBe(200);
    const records = usage.json().records as { simulated: boolean; inputTokens: number | null }[];
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.simulated).toBe(true);
    expect(records[0]?.inputTokens).toBeNull();
  });
});

describe('reasoning API: streaming', () => {
  it('streams phases, deltas and a final event', async () => {
    const { app } = appWithSimulated(
      () =>
        new SimulatedReasoningProvider({
          replies: [
            {
              content: JSON.stringify({
                taskType: 'question',
                needsTools: false,
                rationale: 'Simple.',
              }),
            },
            {
              content: JSON.stringify({
                type: 'answer',
                answer: 'Draft.',
                complete: true,
                summary: 'Done.',
              }),
            },
            { content: 'Streamed text for the user.' },
          ],
        }),
    );
    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hello', mode: 'simulated' },
    });
    const runId = started.json().run.id as string;
    await waitForRun(app, runId);

    const stream = await app.inject({
      method: 'GET',
      url: `/api/reasoning/runs/${runId}/events`,
      headers: ownerA,
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    const payloads = stream.body
      .split('\n\n')
      .filter((chunk) => chunk.includes('data:'))
      .map(
        (chunk) =>
          JSON.parse(chunk.replace(/^id: \d+\n/, '').replace(/^data: /, '')) as { type: string },
      );

    const types = payloads.map((payload) => payload.type);
    expect(types).toContain('phase');
    expect(types).toContain('delta');
    expect(types).toContain('final');
    expect(types).toContain('usage');
    // The streamed text is the answer, once.
    const deltas = payloads.filter((payload) => payload.type === 'delta') as { text: string }[];
    expect(deltas.map((delta) => delta.text).join('')).toBe('Streamed text for the user.');
  });

  it('does not stream a run belonging to another owner', async () => {
    const { app } = appWithSimulated();
    const started = await app.inject({
      method: 'POST',
      url: '/api/reasoning/runs',
      headers: ownerA,
      payload: { task: 'hello', mode: 'simulated' },
    });
    const runId = started.json().run.id as string;
    await waitForRun(app, runId);
    const stream = await app.inject({
      method: 'GET',
      url: `/api/reasoning/runs/${runId}/events`,
      headers: ownerB,
    });
    expect(stream.statusCode).toBe(404);
  });
});
