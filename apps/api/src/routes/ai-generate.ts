import { isAIError, type AICore, type AIRequest } from '@veltravia/ai-core';
import type { FastifyInstance } from 'fastify';

/**
 * Client-facing schema for POST /api/ai/generate. This is deliberately NOT
 * the internal AIRequest: the API layer owns its own contract, validates it
 * with Fastify, and maps it to the AI Core request. No provider
 * configuration, no secrets, no registry internals cross this boundary.
 */
const generateSchema = {
  body: {
    type: 'object',
    required: ['messages'],
    additionalProperties: false,
    properties: {
      system: { type: 'string', minLength: 1, maxLength: 8000 },
      messages: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          required: ['role', 'content'],
          additionalProperties: false,
          properties: {
            role: { type: 'string', enum: ['system', 'user', 'assistant'] },
            content: { type: 'string', minLength: 1, maxLength: 8000 },
          },
        },
      },
      model: { type: 'string', minLength: 1, maxLength: 100 },
      temperature: { type: 'number', minimum: 0, maximum: 2 },
      maxOutputTokens: { type: 'integer', minimum: 1, maximum: 32_768 },
    },
  },
} as const;

/** Maps normalized AI Core error codes to HTTP status codes. */
const ERROR_STATUS: Record<string, number> = {
  AI_INVALID_REQUEST: 400,
  AI_MODEL_NOT_FOUND: 404,
  AI_CAPABILITY_NOT_SUPPORTED: 422,
  AI_PROVIDER_NOT_FOUND: 503,
  AI_PROVIDER_ERROR: 502,
  AI_CONFIGURATION_ERROR: 500,
};

export function registerAIRoutes(app: FastifyInstance, core: AICore): void {
  app.post('/api/ai/generate', { schema: generateSchema }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    // API contract -> internal AIRequest. The client never sees this shape.
    const aiRequest: AIRequest = {
      messages: body.messages as AIRequest['messages'],
      system: body.system as string | undefined,
      model: body.model as string | undefined,
      temperature: body.temperature as number | undefined,
      maxOutputTokens: body.maxOutputTokens as number | undefined,
    };

    try {
      return reply.send(await core.generate(aiRequest));
    } catch (error) {
      if (!isAIError(error)) throw error;
      const status = ERROR_STATUS[error.code] ?? 500;
      // Typed error surface: { error: { code, message } } - no stack, no secrets.
      return reply.code(status).send({ error: error.toJSON() });
    }
  });
}
