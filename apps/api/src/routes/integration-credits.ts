/**
 * Integration-credit routes (Step 56).
 *
 * All charging decisions are made on the server: the browser may ask what an
 * operation would cost, list what was charged, hold and release credit, but it
 * never names a price and never says "charge me". A refusal carries the numbers
 * it refused on, so the UI can say "you need 3 more" instead of "something went
 * wrong".
 *
 * Every route is owner-scoped by the caller's resolved owner ref; a workspace is a
 * reporting and purse scope inside that owner, never a way to read someone else's
 * charges.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  isBillingClass,
  isChargeState,
  isIntegrationOperationKind,
  type BillingClass,
  type ChargeState,
  type IntegrationOperationKind,
  type MeasurementUnit,
} from '@veltravia/integration-credits-core';

import { resolveCallerOwnerRef } from '../project-access.js';
import type { IntegrationCreditService } from '../integration-credit-service.js';

export interface IntegrationCreditRouteDeps {
  readonly integrationCredits: IntegrationCreditService;
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
    env.VELTRAVIA_INTEGRATION_CREDIT_ADMIN_TOKEN?.trim() ??
    env.VELTRAVIA_WALLET_ADMIN_TOKEN?.trim() ??
    '';
  if (expected === '') {
    reply.status(503).send({
      error: {
        code: 'INTEGRATION_CREDIT_ADMIN_DISABLED',
        message: 'This deployment has no operator token, so refunds are closed.',
      },
    });
    return false;
  }
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
      error: {
        code: 'INTEGRATION_CREDIT_ADMIN_DENIED',
        message: 'That operator token is not valid.',
      },
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

const isTypedError = (
  error: unknown,
): error is Error & { code: string; status: number; details: Record<string, unknown> } =>
  error instanceof Error &&
  typeof (error as { code?: unknown }).code === 'string' &&
  typeof (error as { status?: unknown }).status === 'number';

export function integrationCreditErrorBody(error: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: Record<string, unknown> } };
} {
  if (isTypedError(error)) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(Object.keys(error.details ?? {}).length === 0 ? {} : { details: error.details }),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTEGRATION_CREDITS_INTERNAL',
        message: 'The integration-credit request could not be completed.',
      },
    },
  };
}

const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
  const mapped = integrationCreditErrorBody(error);
  return reply.status(mapped.status).send(mapped.body);
};

const CHARGE_ID_PARAMS = {
  type: 'object',
  required: ['chargeId'],
  additionalProperties: false,
  properties: { chargeId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

const QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', maxLength: 128 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 },
    kind: { type: 'string', maxLength: 32 },
    state: { type: 'string', maxLength: 16 },
    billingClass: { type: 'string', maxLength: 24 },
    integrationId: { type: 'string', maxLength: 160 },
    connectorId: { type: 'string', maxLength: 160 },
    operationId: { type: 'string', maxLength: 160 },
    executionId: { type: 'string', maxLength: 160 },
    projectId: { type: 'string', maxLength: 128 },
    dimension: { type: 'string', maxLength: 24 },
  },
} as const;

const UNITS = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    ['request', 'record', 'byte', 'page', 'token', 'second', 'call'].map((unit) => [
      unit,
      { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000_000 },
    ]),
  ),
} as const;

const MEASUREMENT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requests: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000 },
    units: UNITS,
    durationMs: { type: ['integer', 'null'], minimum: 0, maximum: 86_400_000 },
    source: { type: 'string', enum: ['platform', 'connector', 'unavailable'] },
    credential: { type: ['string', 'null'], enum: ['platform', 'user', null] },
    byok: { type: 'boolean' },
  },
} as const;

const CONTEXT_PROPERTIES = {
  kind: { type: 'string', maxLength: 32 },
  operationId: { type: 'string', minLength: 1, maxLength: 160 },
  integrationId: { type: 'string', maxLength: 160 },
  connectorId: { type: 'string', maxLength: 160 },
  pluginId: { type: 'string', maxLength: 160 },
  connectionId: { type: 'string', maxLength: 160 },
  workspaceId: { type: 'string', maxLength: 128 },
  projectId: { type: 'string', maxLength: 128 },
  executionId: { type: 'string', maxLength: 160 },
  requestId: { type: 'string', maxLength: 160 },
  idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  byok: { type: 'boolean' },
  credential: { type: ['string', 'null'], enum: ['platform', 'user', null] },
  ttlSeconds: { type: 'integer', minimum: 30, maximum: 3_600 },
} as const;

interface ContextBody {
  readonly kind: string;
  readonly operationId: string;
  readonly integrationId?: string;
  readonly connectorId?: string;
  readonly pluginId?: string;
  readonly connectionId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly executionId?: string;
  readonly requestId?: string;
  readonly idempotencyKey?: string;
  readonly byok?: boolean;
  readonly credential?: 'platform' | 'user' | null;
  readonly ttlSeconds?: number;
}

export function registerIntegrationCreditRoutes(
  app: FastifyInstance,
  deps: IntegrationCreditRouteDeps,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { integrationCredits } = deps;

  const contextOf = (request: FastifyRequest, body: ContextBody) => {
    const workspaceId = body.workspaceId ?? workspaceOf(request);
    if (!isIntegrationOperationKind(body.kind)) {
      throw Object.assign(new Error(`Unknown integration operation kind: ${body.kind}`), {
        code: 'INVALID_KIND',
        status: 400,
        details: { kind: body.kind },
      });
    }
    return {
      ownerRef: owner(request),
      kind: body.kind as IntegrationOperationKind,
      operationId: body.operationId,
      ...(body.integrationId === undefined ? {} : { integrationId: body.integrationId }),
      ...(body.connectorId === undefined ? {} : { connectorId: body.connectorId }),
      ...(body.pluginId === undefined ? {} : { pluginId: body.pluginId }),
      ...(body.connectionId === undefined ? {} : { connectionId: body.connectionId }),
      ...(workspaceId === null ? {} : { workspaceId }),
      ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
      ...(body.executionId === undefined ? {} : { executionId: body.executionId }),
      ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
      ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
      ...(body.byok === undefined ? {} : { byok: body.byok }),
      ...(body.credential === undefined ? {} : { credential: body.credential }),
      ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: body.ttlSeconds }),
    };
  };

  app.get('/api/integration-credits', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      return reply.send(
        await integrationCredits.summary({
          ownerRef: owner(request),
          ...(workspaceId === null ? {} : { workspaceId }),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/integration-credits/policy', async (_request, reply) =>
    reply.send(integrationCredits.catalogView()),
  );

  app.get(
    '/api/integration-credits/charges',
    { schema: { querystring: QUERY } },
    async (request, reply) => {
      const query = request.query as {
        workspaceId?: string;
        limit?: number;
        offset?: number;
        kind?: string;
        state?: string;
        billingClass?: string;
        integrationId?: string;
        connectorId?: string;
        operationId?: string;
        executionId?: string;
        projectId?: string;
      };
      if (query.kind !== undefined && !isIntegrationOperationKind(query.kind)) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_KIND',
            message: `Unknown integration operation kind: ${query.kind}`,
          },
        });
      }
      if (query.state !== undefined && !isChargeState(query.state)) {
        return reply.status(400).send({
          error: { code: 'INVALID_STATE', message: `Unknown charge state: ${query.state}` },
        });
      }
      if (query.billingClass !== undefined && !isBillingClass(query.billingClass)) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_BILLING_CLASS',
            message: `Unknown billing class: ${query.billingClass}`,
          },
        });
      }
      try {
        const workspaceId = workspaceOf(request);
        return reply.send(
          await integrationCredits.charges(
            { ownerRef: owner(request), ...(workspaceId === null ? {} : { workspaceId }) },
            {
              ...(query.limit === undefined ? {} : { limit: query.limit }),
              ...(query.offset === undefined ? {} : { offset: query.offset }),
              ...(query.kind === undefined ? {} : { kind: query.kind as IntegrationOperationKind }),
              ...(query.state === undefined ? {} : { state: query.state as ChargeState }),
              ...(query.billingClass === undefined
                ? {}
                : { billingClass: query.billingClass as BillingClass }),
              ...(query.integrationId === undefined ? {} : { integrationId: query.integrationId }),
              ...(query.connectorId === undefined ? {} : { connectorId: query.connectorId }),
              ...(query.operationId === undefined ? {} : { operationId: query.operationId }),
              ...(query.executionId === undefined ? {} : { executionId: query.executionId }),
              ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
            },
          ),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/integration-credits/usage',
    { schema: { querystring: QUERY } },
    async (request, reply) => {
      const query = request.query as { dimension?: string };
      const dimension = query.dimension ?? 'integration';
      const allowed = ['integration', 'connector', 'operation', 'project', 'billingClass'] as const;
      if (!(allowed as readonly string[]).includes(dimension)) {
        return reply.status(400).send({
          error: { code: 'INVALID_DIMENSION', message: `Unknown dimension: ${dimension}` },
        });
      }
      try {
        const workspaceId = workspaceOf(request);
        return reply.send({
          dimension,
          groups: await integrationCredits.usage(
            { ownerRef: owner(request), ...(workspaceId === null ? {} : { workspaceId }) },
            dimension as (typeof allowed)[number],
          ),
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get('/api/integration-credits/integrity', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      return reply.send(
        await integrationCredits.integrity({
          ownerRef: owner(request),
          ...(workspaceId === null ? {} : { workspaceId }),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * What would this operation cost, and who pays? Read-only: no charge is
   * written, no credit is held. The dashboard uses it to label an integration
   * free, paid or billed to the user's own account before anything runs.
   */
  app.post(
    '/api/integration-credits/classify',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'operationId'],
          properties: {
            kind: { type: 'string', maxLength: 32 },
            operationId: { type: 'string', minLength: 1, maxLength: 160 },
            integrationId: { type: 'string', maxLength: 160 },
            connectorId: { type: 'string', maxLength: 160 },
            workspaceId: { type: 'string', maxLength: 128 },
            byok: { type: 'boolean' },
            credential: { type: ['string', 'null'], enum: ['platform', 'user', null] },
            expectedRequests: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000 },
            expectedUnits: UNITS,
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as ContextBody & {
        expectedRequests?: number | null;
        expectedUnits?: Partial<Record<MeasurementUnit, number | null>>;
      };
      try {
        const context = contextOf(request, body);
        return reply.send(
          await integrationCredits.estimate({
            ...context,
            ...(body.expectedRequests === undefined
              ? {}
              : { expectedRequests: body.expectedRequests }),
            ...(body.expectedUnits === undefined ? {} : { expectedUnits: body.expectedUnits }),
          }),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/integration-credits/reservations',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'operationId'],
          properties: CONTEXT_PROPERTIES,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as ContextBody;
      try {
        const result = await integrationCredits.reserve(contextOf(request, body));
        return reply.status(result.created ? 201 : 200).send(result);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/integration-credits/charges/:chargeId/commit',
    {
      schema: {
        params: CHARGE_ID_PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { measurement: MEASUREMENT },
        },
      },
    },
    async (request, reply) => {
      const { chargeId } = request.params as { chargeId: string };
      const body = request.body as { measurement?: Record<string, unknown> };
      try {
        const workspaceId = workspaceOf(request);
        return reply.send(
          await integrationCredits.commit({
            ownerRef: owner(request),
            ...(workspaceId === null ? {} : { workspaceId }),
            chargeId,
            measurement: (body.measurement ?? {}) as never,
          }),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/integration-credits/charges/:chargeId/release',
    {
      schema: {
        params: CHARGE_ID_PARAMS,
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
          await integrationCredits.release({
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
    '/api/integration-credits/charges/:chargeId/refund',
    {
      schema: {
        params: CHARGE_ID_PARAMS,
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
          await integrationCredits.refund({
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

  app.post('/api/integration-credits/sweep', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      const released = await integrationCredits.sweep({
        ownerRef: owner(request),
        ...(workspaceId === null ? {} : { workspaceId }),
      });
      return reply.send({ released: released.length, charges: released });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/integration-credits/settings', async (request, reply) => {
    try {
      const workspaceId = workspaceOf(request);
      return reply.send(
        await integrationCredits.settings({
          ownerRef: owner(request),
          ...(workspaceId === null ? {} : { workspaceId }),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put(
    '/api/integration-credits/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            monthlyLimit: { type: ['number', 'null'], minimum: 0, maximum: 10_000_000 },
            perOperationLimit: { type: ['number', 'null'], minimum: 0, maximum: 1_000_000 },
            workspaceId: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        monthlyLimit?: number | null;
        perOperationLimit?: number | null;
        workspaceId?: string;
      };
      try {
        return reply.send(
          await integrationCredits.updateSettings({
            ownerRef: owner(request),
            ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
            monthlyLimit: body.monthlyLimit ?? null,
            perOperationLimit: body.perOperationLimit ?? null,
          }),
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
