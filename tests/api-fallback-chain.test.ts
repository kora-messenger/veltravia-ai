import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_CUSTOM_KEY,
  TEST_OPENAI_KEY,
  createTestKeyring,
  errorResponse,
} from '@veltravia/ai-gateway-mock';
import type { TransportRequest } from '@veltravia/ai-gateway-core';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';
import { FALLBACK_ORDER } from '../apps/api/src/reasoning-service.js';

/**
 * The backup chain: OpenAI, then Groq, then OpenRouter, for Automatic runs only.
 * A model a person pinned is never swapped for another provider, and a provider
 * outside the chain is never swapped in silently.
 */

const owner = { 'x-veltravia-owner-ref': 'fallback-owner' };

/** The replies a successful run needs, in order: classify, answer, final text. */
const REPLIES = [
  JSON.stringify({ taskType: 'question', needsTools: false, rationale: 'Simple.' }),
  JSON.stringify({ type: 'answer', answer: 'Done.', complete: true, summary: 'Done.' }),
  'Done.',
];

/** Which maker a request was sent to, read from its host. */
function maker(request: TransportRequest): string {
  const url = request.url;
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('api.groq.com')) return 'groq';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('api.mistral.ai')) return 'mistral';
  return 'other';
}

function setup(failing: readonly string[]) {
  const servedBy: string[] = [];
  let replyIndex = 0;
  const transport = new FixtureProviderTransport({
    models: ['gpt-test-mini'],
    override: (request) => {
      if (request.method !== 'POST') return undefined;
      const who = maker(request);
      if (failing.includes(who)) return errorResponse(503, 'unavailable');
      servedBy.push(who);
      const content = REPLIES[Math.min(replyIndex, REPLIES.length - 1)] ?? 'Done.';
      replyIndex += 1;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          id: 'chatcmpl-1',
          model: 'gpt-test-mini',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
        text: '',
      };
    },
  });
  const aiGateway = createGatewayService({ keyring: createTestKeyring([1]), transport });
  // buildApp wires the router that picks a model for Automatic runs.
  const app = buildApp({ aiGateway });
  return { app, servedBy };
}

async function connect(app: ReturnType<typeof buildApp>, providerId: string, key: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers: owner,
    payload: { providerId, apiKey: key, displayName: `${providerId} key` },
  });
  expect(response.statusCode).toBeLessThan(300);
}

async function connections(app: ReturnType<typeof buildApp>) {
  const body = (
    await app.inject({ method: 'GET', url: '/api/ai/providers', headers: owner })
  ).json() as { providers: { id: string; providerId: string }[] };
  return body.providers;
}

async function finish(app: ReturnType<typeof buildApp>, runId: string) {
  for (let i = 0; i < 80; i += 1) {
    const r = (
      await app.inject({ method: 'GET', url: `/api/reasoning/runs/${runId}`, headers: owner })
    ).json().run as { status: string; answer?: string };
    if (['completed', 'failed', 'limit_reached'].includes(r.status)) return r;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not finish');
}

async function startRun(app: ReturnType<typeof buildApp>, extra: Record<string, unknown> = {}) {
  const started = await app.inject({
    method: 'POST',
    url: '/api/reasoning/runs',
    headers: owner,
    payload: { task: 'Say done.', profile: 'workspace', mode: 'gateway', ...extra },
  });
  if (started.statusCode !== 202) throw new Error(`start ${started.statusCode}: ${started.body}`);
  return finish(app, started.json().run.id as string);
}

describe('the backup chain', () => {
  it('is OpenAI, then Groq, then OpenRouter, and nothing else', () => {
    expect([...FALLBACK_ORDER]).toEqual(['openai', 'groq', 'openrouter']);
  });

  it('on Automatic, moves to Groq when OpenAI is down', async () => {
    const { app, servedBy } = setup(['openai']);
    await connect(app, 'openai', TEST_OPENAI_KEY);
    await connect(app, 'groq', `gsk_${TEST_CUSTOM_KEY}`);
    await connect(app, 'openrouter', `sk-or-v1-${TEST_CUSTOM_KEY}`);

    const run = await startRun(app);
    expect(run.status).toBe('completed');
    expect(servedBy[0]).toBe('groq');
    expect(servedBy).not.toContain('openrouter');
  });

  it('reaches OpenRouter only after both OpenAI and Groq fail', async () => {
    const { app, servedBy } = setup(['openai', 'groq']);
    await connect(app, 'openai', TEST_OPENAI_KEY);
    await connect(app, 'groq', `gsk_${TEST_CUSTOM_KEY}`);
    await connect(app, 'openrouter', `sk-or-v1-${TEST_CUSTOM_KEY}`);

    const run = await startRun(app);
    expect(run.status).toBe('completed');
    expect(servedBy[0]).toBe('openrouter');
  });

  it('never uses a provider outside the chain as a silent backup', async () => {
    const { app, servedBy } = setup(['openai']);
    await connect(app, 'openai', TEST_OPENAI_KEY);
    await connect(app, 'mistral', `mistral-${TEST_CUSTOM_KEY}`);
    const openai = (await connections(app)).find((c) => c.providerId === 'openai')!;

    // OpenAI is named, so it is the run's only provider, and it is down. Mistral
    // works, but it is not in the chain, so the failure is shown instead.
    const run = await startRun(app, { connectionId: openai.id, modelId: 'gpt-test-mini' });
    expect(run.status).not.toBe('completed');
    expect(servedBy).not.toContain('mistral');
  });

  it('gives a pinned model no backup: the failure is shown, not hidden', async () => {
    const { app, servedBy } = setup(['openai']);
    await connect(app, 'openai', TEST_OPENAI_KEY);
    await connect(app, 'groq', `gsk_${TEST_CUSTOM_KEY}`);
    const openai = (await connections(app)).find((c) => c.providerId === 'openai')!;

    const run = await startRun(app, { connectionId: openai.id, modelId: 'gpt-test-mini' });
    expect(run.status).not.toBe('completed');
    expect(servedBy).not.toContain('groq');
  });
});
