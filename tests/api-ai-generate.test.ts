import { describe, expect, it } from 'vitest';
import { buildApp } from '@veltravia/api';

const post = (app: Awaited<ReturnType<typeof buildApp>>, body: unknown) =>
  app.inject({ method: 'POST', url: '/api/ai/generate', payload: body });

const validBody = {
  messages: [{ role: 'user', content: 'Hello, Veltravia!' }],
};

describe('POST /api/ai/generate', () => {
  it('routes a valid request through the AI Core to the mock provider', async () => {
    const app = buildApp();
    const response = await post(app, validBody);
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      content: string;
      providerId: string;
      modelId: string;
      usage: unknown;
      finishReason: string;
      requestId: string;
      generatedAt: string;
    }>();
    expect(body.providerId).toBe('mock');
    expect(body.modelId).toBe('mock-text-small');
    expect(body.content).toContain('Hello, Veltravia!');
    expect(body.usage).not.toBeNull();
    expect(body.finishReason).toBe('stop');
  });

  it('honours an explicit model selection', async () => {
    const app = buildApp();
    const response = await post(app, {
      ...validBody,
      model: 'mock-multimodal',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().modelId).toBe('mock-multimodal');
  });

  it('rejects schema-invalid bodies with 400', async () => {
    const app = buildApp();
    const cases: unknown[] = [
      {}, // missing messages
      { messages: [] }, // empty messages
      { messages: [{ role: 'robot', content: 'hi' }] }, // bad role
      { messages: [{ role: 'user', content: '' }] }, // empty content
      { messages: validBody.messages, temperature: 9 }, // out of range
      { messages: validBody.messages, surprise: 'extra key' }, // unknown field
    ];
    for (const badBody of cases) {
      const response = await post(app, badBody);
      expect(response.statusCode).toBe(400);
    }
    // A non-JSON-parsable body is also rejected with 400.
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/ai/generate',
      headers: { 'content-type': 'application/json' },
      payload: 'not-an-object',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('maps ModelNotFoundError to 404 with a typed error code', async () => {
    const app = buildApp();
    const response = await post(app, { ...validBody, model: 'no-such-model' });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('AI_MODEL_NOT_FOUND');
    expect(body.error.message).toContain('no-such-model');
  });

  it('maps CapabilityNotSupportedError to 422 (embeddings model on a text task)', async () => {
    const app = buildApp();
    const response = await post(app, { ...validBody, model: 'mock-embed' });
    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('AI_CAPABILITY_NOT_SUPPORTED');
  });

  it('never leaks secret-shaped fields in success or error responses', async () => {
    const app = buildApp();
    const success = (await post(app, validBody)).json<Record<string, unknown>>();
    expect(Object.keys(success).sort()).toEqual(
      [
        'content',
        'finishReason',
        'generatedAt',
        'modelId',
        'providerId',
        'requestId',
        'usage',
      ].sort(),
    );

    const failure = (await post(app, { ...validBody, model: 'no-such-model' })).json<
      Record<string, unknown>
    >();
    const serialized = JSON.stringify(failure).toLowerCase();
    expect(serialized).not.toContain('key');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('password');
  });

  it('keeps the health check working alongside the AI route', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});
