import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';
import { pickModelFor, type UsableModel } from '../apps/api/src/model-preferences.js';

const owner = { 'x-veltravia-owner-ref': 'auto-owner' };

const REPLIES = [
  JSON.stringify({ taskType: 'question', needsTools: false, rationale: 'Simple.' }),
  JSON.stringify({ type: 'answer', answer: 'Done.', complete: true, summary: 'Done.' }),
  'Done.',
];

/** Builds an app whose provider lists the given models and records which one answered. */
function setup(models: readonly string[]) {
  const answeredBy: string[] = [];
  let reply = 0;
  const transport = new FixtureProviderTransport({
    models,
    override: (request) => {
      if (request.method !== 'POST') return undefined;
      const sent = (request.body ?? {}) as { model?: string };
      if (reply % REPLIES.length === 0) answeredBy.push(String(sent.model));
      const content = REPLIES[reply % REPLIES.length] ?? 'Done.';
      reply += 1;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          id: 'c1',
          model: sent.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
        text: '',
      };
    },
  });
  const aiGateway = createGatewayService({ keyring: createTestKeyring([1]), transport });
  return { app: buildApp({ aiGateway }), answeredBy };
}

async function connect(app: ReturnType<typeof buildApp>) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers: owner,
    payload: { providerId: 'openai', apiKey: TEST_OPENAI_KEY, displayName: 'Work key' },
  });
  expect(r.statusCode).toBeLessThan(300);
}

async function ask(app: ReturnType<typeof buildApp>, task: string) {
  const started = await app.inject({
    method: 'POST',
    url: '/api/reasoning/runs',
    headers: owner,
    payload: { task, profile: 'workspace', mode: 'gateway' },
  });
  if (started.statusCode !== 202) throw new Error(`start ${started.statusCode}: ${started.body}`);
  const id = started.json().run.id as string;
  for (let i = 0; i < 80; i += 1) {
    const run = (
      await app.inject({ method: 'GET', url: `/api/reasoning/runs/${id}`, headers: owner })
    ).json().run as { status: string };
    if (['completed', 'failed', 'limit_reached'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not finish');
}

describe('pickModelFor', () => {
  const have = (providerId: string, modelId: string): UsableModel => ({
    connectionId: `c-${providerId}`,
    providerId,
    modelId,
  });

  it('prefers the first listed model the owner has', () => {
    const usable = [have('groq', 'openai/gpt-oss-120b'), have('openai', 'gpt-4.1')];
    expect(pickModelFor('coding', usable)?.modelId).toBe('gpt-4.1');
  });

  it('skips models that are not connected and takes the next one', () => {
    expect(pickModelFor('coding', [have('groq', 'openai/gpt-oss-120b')])?.modelId).toBe(
      'openai/gpt-oss-120b',
    );
  });

  it('returns null when nothing preferred is connected, so the router decides', () => {
    expect(pickModelFor('coding', [have('openai', 'gpt-3.5-turbo')])).toBeNull();
    expect(pickModelFor('general-conversation', [])).toBeNull();
  });

  it('only matches a model on the provider it is listed for', () => {
    expect(pickModelFor('general-conversation', [have('mistral', 'gpt-4o-mini')])).toBeNull();
  });
});

describe('Automatic matches the model to the prompt', () => {
  it('answers chat with gpt-4o-mini and code with gpt-4.1', async () => {
    const { app, answeredBy } = setup(['gpt-4o-mini', 'gpt-4.1', 'gpt-4o']);
    await connect(app);

    expect((await ask(app, 'What is the capital of Nigeria?')).status).toBe('completed');
    expect((await ask(app, 'Fix the bug in my React component')).status).toBe('completed');

    expect(answeredBy).toEqual(['gpt-4o-mini', 'gpt-4.1']);
  });

  it('uses the stronger model for a multi-part analytical prompt', async () => {
    const { app, answeredBy } = setup(['gpt-4o-mini', 'gpt-4.1']);
    await connect(app);

    await ask(app, 'Compare renting versus buying in Lagos and explain the trade-offs.');
    expect(answeredBy).toEqual(['gpt-4.1']);
  });

  it('still answers when none of the preferred models is connected', async () => {
    const { app, answeredBy } = setup(['some-other-model']);
    await connect(app);

    expect((await ask(app, 'hello there')).status).toBe('completed');
    expect(answeredBy).toEqual(['some-other-model']);
  });

  it('keeps a pinned model for every prompt, whatever the prompt is', async () => {
    const { app, answeredBy } = setup(['gpt-4o-mini', 'gpt-4.1']);
    await connect(app);
    const models = (
      await app.inject({ method: 'GET', url: '/api/reasoning/models', headers: owner })
    ).json() as { models: { connectionId: string; modelId: string }[] };
    const mini = models.models.find((m) => m.modelId === 'gpt-4o-mini')!;
    const put = await app.inject({
      method: 'PUT',
      url: '/api/reasoning/model',
      headers: owner,
      payload: { connectionId: mini.connectionId, modelId: mini.modelId },
    });
    expect(put.statusCode).toBe(200);

    await ask(app, 'Fix the bug in my React component');
    expect(answeredBy).toEqual(['gpt-4o-mini']);
  });
});

describe('the chat model choice endpoint', () => {
  it('rejects a body that names neither Automatic nor a model, instead of resetting', async () => {
    const { app } = setup(['gpt-4o-mini']);
    await connect(app);
    const models = (
      await app.inject({ method: 'GET', url: '/api/reasoning/models', headers: owner })
    ).json() as { models: { connectionId: string; modelId: string }[] };
    const first = models.models[0]!;
    await app.inject({
      method: 'PUT',
      url: '/api/reasoning/model',
      headers: owner,
      payload: { connectionId: first.connectionId, modelId: first.modelId },
    });

    // A JSON string literal is what a client that stringified its body twice sends.
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/reasoning/model',
      headers: { ...owner, 'content-type': 'application/json' },
      payload: JSON.stringify(JSON.stringify({ connectionId: 'x', modelId: 'y' })),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('REASONING_MODEL_CHOICE_INVALID');

    // And the earlier choice is still in place.
    const caps = (
      await app.inject({ method: 'GET', url: '/api/reasoning', headers: owner })
    ).json() as { model: { modelId: string } | null };
    expect(caps.model?.modelId).toBe(first.modelId);
  });

  it('still lets a client go back to Automatic explicitly', async () => {
    const { app } = setup(['gpt-4o-mini']);
    await connect(app);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/reasoning/model',
      headers: owner,
      payload: { automatic: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().choice).toBeNull();
  });
});
