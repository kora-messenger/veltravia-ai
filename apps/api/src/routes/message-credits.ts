/**
 * Message-credit routes (Step 54).
 *
 * All charging decisions are made here, on the server: the browser may ask for an
 * estimate, hold credit, settle a hold or release it, but it never names a price
 * and never says "charge me". A refusal carries the numbers it refused on, so the
 * UI can say "you need 3 more" instead of "something went wrong".
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  isMessageCreditError,
  isInteractionKind,
  type ChargeState,
  type InteractionKind,
} from '@veltravia/message-credits-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import { UsageLimitError } from '../usage-service.js';
import type { MessageCreditService } from '../message-credit-service.js';

export interface MessageCreditRouteDeps {
  readonly messageCredits: MessageCreditService;
}

/**
 * Refunds move money, so only an operator may ask for one. The gate fails closed:
 * a deployment with no token configured closes the route rather than trusting
 * the caller.
 */
function requireOperator(
  request: FastifyRequest,
  reply: FastifyReply,
  env: NodeJS.ProcessEnv,
): boolean {
  const expected =
    env.VELTRAVIA_MESSAGE_CREDIT_ADMIN_TOKEN?.trim() ??
    env.VELTRAVIA_WALLET_ADMIN_TOKEN?.trim() ??
    '';
  if (expected === '') {
    reply.status(503).send({
      error: {
        code: 'MESSAGE_CREDIT_ADMIN_DISABLED',
        message: 'This deployment has no operator token, so refunds are closed.',
      },
    });
    return false;
  }
  // Operators present the token the same way the wallet routes take it, and the
  // older short header is still accepted so one deployment has one habit.
  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const header = request.headers['x-veltravia-admin'];
  const token =
    bearer.length > 0
      ? bearer
      : typeof header === 'string'
        ? header
        : Array.isArray(header)
          ? header[0]
          : undefined;
  if (token !== expected) {
    reply.status(403).send({
      error: { code: 'MESSAGE_CREDIT_ADMIN_DENIED', message: 'That operator token is not valid.' },
    });
    return false;
  }
  return true;
}

const owner = (request: FastifyRequest): string => resolveCallerOwnerRef(request);

const workspaceOf = (request: FastifyRequest): string | null => {
  const query = request.query as { workspaceId?: string } | undefined;
  const header = request.headers['x-veltravia-workspace'];
  const raw = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  const value = query?.workspaceId ?? raw;
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null;
};

const isWalletError = (
  error: unknown,
): error is Error & {
  code: string;
  status: number;
  details: Record<string, unknown>;
} =>
  error instanceof Error &&
  typeof (error as { code?: unknown }).code === 'string' &&
  typeof (error as { status?: unknown }).status === 'number';

export function messageCreditErrorBody(error: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: Record<string, unknown> } };
} {
  if (isMessageCreditError(error)) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
        },
      },
    };
  }
  if (error instanceof UsageLimitError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.decision === null ? {} : { decision: error.decision }),
        },
      },
    };
  }
  if (isWalletError(error)) {
    return {
      status: error.status,
      body: {
        error: { code: error.code, message: error.message, details: error.details },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'MESSAGE_CREDITS_INTERNAL',
        message: 'The message-credit request could not be completed.',
      },
    },
  };
}

const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
  const mapped = messageCreditErrorBody(error);
  return reply.status(mapped.status).send(mapped.body);
};

const stateQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', maxLength: 128 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 },
    kind: { type: 'string', maxLength: 32 },
    state: { type: 'string', maxLength: 16 },
    conversationId: { type: 'string', maxLength: 128 },
    projectId: { type: 'string', maxLength: 128 },
    runId: { type: 'string', maxLength: 128 },
  },
} as const;

const RESERVE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'idempotencyKey'],
  properties: {
    kind: { type: 'string', maxLength: 32 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
    workspaceId: { type: 'string', maxLength: 128 },
    projectId: { type: 'string', maxLength: 128 },
    conversationId: { type: 'string', maxLength: 128 },
    runId: { type: 'string', maxLength: 128 },
    modelId: { type: 'string', maxLength: 160 },
    providerId: { type: 'string', maxLength: 64 },
    byok: { type: 'boolean' },
    ttlSeconds: { type: 'integer', minimum: 30, maximum: 3_600 },
  },
} as const;

const MEASUREMENT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inputTokens: { type: 'integer', minimum: 0, maximum: 50_000_000 },
    outputTokens: { type: 'integer', minimum: 0, maximum: 50_000_000 },
    cachedTokens: { type: 'integer', minimum: 0, maximum: 50_000_000 },
    durationMs: { type: 'integer', minimum: 0, maximum: 86_400_000 },
    toolCalls: { type: 'integer', minimum: 0, maximum: 10_000 },
    modelId: { type: 'string', maxLength: 160 },
    providerId: { type: 'string', maxLength: 64 },
    byok: { type: 'boolean' },
  },
} as const;

export function registerMessageCreditRoutes(
  app: FastifyInstance,
  deps: MessageCreditRouteDeps,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { messageCredits } = deps;

  app.get('/api/message-credits', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      return reply.send(
        await messageCredits.summary({
          ownerRef: owner(request),
          ...(workspaceId === null ? {} : { workspaceId }),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/message-credits/policy', async (_request, reply) =>
    reply.send(messageCredits.catalogView()),
  );

  app.get(
    '/api/message-credits/charges',
    { schema: { querystring: stateQuery } },
    async (request, reply) => {
      const query = request.query as {
        workspaceId?: string;
        limit?: number;
        offset?: number;
        kind?: string;
        state?: string;
        conversationId?: string;
        projectId?: string;
        runId?: string;
      };
      if (query.kind !== undefined && !isInteractionKind(query.kind)) {
        return reply.status(400).send({
          error: { code: 'INVALID_KIND', message: `Unknown interaction kind: ${query.kind}` },
        });
      }
      try {
        const workspaceId = workspaceOf(request);
        return reply.send(
          await messageCredits.charges(
            { ownerRef: owner(request), ...(workspaceId === null ? {} : { workspaceId }) },
            {
              ...(query.limit === undefined ? {} : { limit: query.limit }),
              ...(query.offset === undefined ? {} : { offset: query.offset }),
              ...(query.kind === undefined ? {} : { kind: query.kind as InteractionKind }),
              ...(query.state === undefined ? {} : { state: query.state as ChargeState }),
              ...(query.conversationId === undefined
                ? {}
                : { conversationId: query.conversationId }),
              ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
              ...(query.runId === undefined ? {} : { runId: query.runId }),
            },
          ),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/message-credits/usage', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      const ref = { ownerRef: owner(request), ...(workspaceId === null ? {} : { workspaceId }) };
      const [byModel, byProject, byConversation, byKind] = await Promise.all([
        messageCredits.usage(ref, 'model'),
        messageCredits.usage(ref, 'project'),
        messageCredits.usage(ref, 'conversation'),
        messageCredits.usage(ref, 'kind'),
      ]);
      return reply.send({ byModel, byProject, byConversation, byKind });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/message-credits/integrity', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      return reply.send(
        await messageCredits.integrity({
          ownerRef: owner(request),
          ...(workspaceId === null ? {} : { workspaceId }),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    '/api/message-credits/estimate',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', maxLength: 32 },
            modelId: { type: 'string', maxLength: 160 },
            workspaceId: { type: 'string', maxLength: 128 },
            maxOutputTokens: { type: 'integer', minimum: 1, maximum: 8_192 },
            byok: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        kind: string;
        modelId?: string;
        workspaceId?: string;
        maxOutputTokens?: number;
        byok?: boolean;
      };
      if (!isInteractionKind(body.kind)) {
        return reply.status(400).send({
          error: { code: 'INVALID_KIND', message: `Unknown interaction kind: ${body.kind}` },
        });
      }
      try {
        return reply.send(
          await messageCredits.estimate({
            ownerRef: owner(request),
            kind: body.kind,
            idempotencyKey: 'estimate-only',
            ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
            ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
            ...(body.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: body.maxOutputTokens }),
            ...(body.byok === undefined ? {} : { byok: body.byok }),
          }),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/message-credits/reservations',
    { schema: { body: RESERVE_BODY } },
    async (request, reply) => {
      const body = request.body as {
        kind: string;
        idempotencyKey: string;
        workspaceId?: string;
        projectId?: string;
        conversationId?: string;
        runId?: string;
        modelId?: string;
        providerId?: string;
        byok?: boolean;
        ttlSeconds?: number;
      };
      if (!isInteractionKind(body.kind)) {
        return reply.status(400).send({
          error: { code: 'INVALID_KIND', message: `Unknown interaction kind: ${body.kind}` },
        });
      }
      try {
        const result = await messageCredits.reserve({
          ownerRef: owner(request),
          kind: body.kind,
          idempotencyKey: body.idempotencyKey,
          ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
          ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
          ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
          ...(body.runId === undefined ? {} : { runId: body.runId }),
          ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
          ...(body.providerId === undefined ? {} : { providerId: body.providerId }),
          ...(body.byok === undefined ? {} : { byok: body.byok }),
          ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: body.ttlSeconds }),
        });
        return reply.status(result.created ? 201 : 200).send(result);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/message-credits/charges/:chargeId/commit',
    {
      schema: {
        params: {
          type: 'object',
          required: ['chargeId'],
          additionalProperties: false,
          properties: { chargeId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { measurement: MEASUREMENT },
        },
      },
    },
    async (request, reply) => {
      const { chargeId } = request.params as { chargeId: string };
      const body = request.body as { measurement?: Record<string, number | string | boolean> };
      try {
        const workspaceId = workspaceOf(request);
        const result = await messageCredits.commit({
          ownerRef: owner(request),
          ...(workspaceId === null ? {} : { workspaceId }),
          chargeId,
          measurement: (body.measurement ?? {}) as never,
        });
        return reply.send(result);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/message-credits/charges/:chargeId/release',
    {
      schema: {
        params: {
          type: 'object',
          required: ['chargeId'],
          additionalProperties: false,
          properties: { chargeId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const { chargeId } = request.params as { chargeId: string };
      const body = request.body as { reason?: string };
      try {
        const workspaceId = workspaceOf(request);
        return reply.send(
          await messageCredits.release({
            ownerRef: owner(request),
            ...(workspaceId === null ? {} : { workspaceId }),
            chargeId,
            reason: body.reason ?? 'The caller released the reservation.',
          }),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/message-credits/charges/:chargeId/refund',
    {
      schema: {
        params: {
          type: 'object',
          required: ['chargeId'],
          additionalProperties: false,
          properties: { chargeId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ownerRef'],
          properties: {
            ownerRef: { type: 'string', minLength: 1, maxLength: 200 },
            reason: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireOperator(request, reply, env)) return reply;
      const { chargeId } = request.params as { chargeId: string };
      const body = request.body as { ownerRef: string; reason?: string };
      // An operator refund acts on a named owner, and the wallet store writes
      // under the bound owner. A body naming somebody else is refused rather
      // than filed against the operator's own account.
      if (owner(request) !== body.ownerRef) {
        return reply.status(400).send({
          error: {
            code: 'OWNER_MISMATCH',
            message: `ownerRef ${body.ownerRef} does not match the caller owner ${owner(request)}.`,
          },
        });
      }
      const actorHeader = request.headers['x-veltravia-actor'];
      const actor =
        typeof actorHeader === 'string' && actorHeader.length > 0 ? actorHeader : 'operator';
      try {
        return reply.send(
          await messageCredits.refund({
            ownerRef: body.ownerRef,
            chargeId,
            reason: body.reason ?? 'Refunded by an operator.',
            actor,
          }),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post('/api/message-credits/sweep', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      const released = await messageCredits.sweep({
        ownerRef: owner(request),
        ...(workspaceId === null ? {} : { workspaceId }),
      });
      return reply.send({ released: released.length, charges: released });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/message-credits/settings', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      return reply.send(
        await messageCredits.settings({
          ownerRef: owner(request),
          ...(workspaceId === null ? {} : { workspaceId }),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put(
    '/api/message-credits/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            monthlyLimit: { type: ['number', 'null'], minimum: 0, maximum: 10_000_000 },
            perRequestLimit: { type: ['number', 'null'], minimum: 0, maximum: 1_000_000 },
            workspaceId: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        monthlyLimit?: number | null;
        perRequestLimit?: number | null;
        workspaceId?: string;
      };
      try {
        return reply.send(
          await messageCredits.updateSettings({
            ownerRef: owner(request),
            ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
            monthlyLimit: body.monthlyLimit ?? null,
            perRequestLimit: body.perRequestLimit ?? null,
          }),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
