import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readEnv } from '@veltravia/config';
import {
  GatewayError,
  isGatewayError,
  type AIProviderGateway,
  type CreateConnectionInput,
  type UpdateConnectionInput,
} from '@veltravia/ai-gateway';

import { isTaskCategory } from '@veltravia/ai-router';
import type { GatewayService } from '../ai-gateway-service.js';
import type { ModelRouterService } from '../model-router-service.js';

/**
 * AI provider gateway routes (Step 26).
 *
 * Owner-scoped, and credential-safe by construction: no response ever contains
 * a credential, a credential reference or anything an attacker could replay.
 * The only credential-derived values that cross this boundary are the masked
 * hint (`••••1234`) and a boolean "a key is stored".
 *
 * A real deployment reads the owner from an authenticated session. This build
 * derives it from `x-veltravia-owner-ref` (falling back to
 * `x-veltravia-owner`, then the configured default owner). That header is a
 * development stand-in for authentication - it is documented as such and must
 * never be treated as proof of identity in production.
 */

const STATUS: Readonly<Record<string, number>> = {
  GATEWAY_INVALID_REQUEST: 400,
  GATEWAY_PROVIDER_UNKNOWN: 404,
  GATEWAY_CONNECTION_NOT_FOUND: 404,
  GATEWAY_CONNECTION_FORBIDDEN: 404,
  GATEWAY_CONNECTION_DUPLICATE: 409,
  GATEWAY_CREDENTIAL_MISSING: 404,
  GATEWAY_CREDENTIAL_INVALID: 400,
  GATEWAY_VAULT_UNAVAILABLE: 503,
  GATEWAY_VAULT_DECRYPT_FAILED: 409,
  GATEWAY_UNSAFE_ENDPOINT: 400,
  GATEWAY_CAPABILITY_UNSUPPORTED: 400,
  GATEWAY_MODEL_UNKNOWN: 404,
  GATEWAY_NO_PROVIDER_CONFIGURED: 409,
  GATEWAY_RATE_LIMITED: 429,
  GATEWAY_TIMEOUT: 504,
  GATEWAY_PROVIDER_UNAVAILABLE: 502,
  GATEWAY_AUTH_FAILED: 401,
  GATEWAY_PROVIDER_ERROR: 502,
  GATEWAY_LIMIT_EXCEEDED: 413,
};

function toError(error: unknown): { status: number; body: unknown } {
  if (isGatewayError(error)) {
    return {
      status: STATUS[error.code] ?? 500,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'GATEWAY_INTERNAL', message: 'Unexpected failure.' } },
  };
}

function ownerOf(request: FastifyRequest): { ownerRef: string } {
  const prefer = request.headers['x-veltravia-owner-ref'];
  const fallback = request.headers['x-veltravia-owner'];
  const raw =
    (Array.isArray(prefer) ? prefer[0] : prefer) ??
    (Array.isArray(fallback) ? fallback[0] : fallback);
  if (typeof raw === 'string' && raw.length > 0) return { ownerRef: raw.slice(0, 256) };
  return { ownerRef: readEnv('VELTRAVIA_DEFAULT_OWNER_REF') ?? 'veltravia-dev-user' };
}

function requireGateway(service: GatewayService): AIProviderGateway {
  if (!service.gateway) {
    throw new GatewayError(
      'GATEWAY_VAULT_UNAVAILABLE',
      service.blockedReason ?? 'Credential encryption is not configured.',
    );
  }
  return service.gateway;
}

function parseStrings(value: unknown, field: string, max = 500): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new GatewayError('GATEWAY_INVALID_REQUEST', `${field} must be an array.`);
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new GatewayError('GATEWAY_INVALID_REQUEST', `${field} must contain strings only.`);
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) cleaned.push(trimmed.slice(0, 200));
    if (cleaned.length >= max) break;
  }
  return cleaned;
}

export interface AiGatewayRouteDeps {
  readonly service: GatewayService;
  /**
   * Step 28: the platform's model router. When a generation request names no
   * model, the router decides which one runs and why, and its refusal is
   * reported instead of a silent substitution. Explicit picks skip the router.
   */
  readonly router?: ModelRouterService;
  /** Honest note about where routing preferences live. */
  readonly persistenceNote?: string;
}

export function registerAiGatewayRoutes(app: FastifyInstance, deps: AiGatewayRouteDeps): void {
  const { service } = deps;

  /** Service availability + provider catalog. Safe for the settings page to
   *  read before anything is connected. */
  app.get('/api/ai/providers', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      if (!service.gateway) {
        return reply.send({
          ready: false,
          blockedReason: service.blockedReason,
          encryption: { algorithm: null, keyVersions: [] },
          providers: [],
          preferences: { defaultConnectionId: null, defaultModelId: null, projects: {} },
          catalog: [],
        });
      }
      const gateway = service.gateway;
      const [connections, preferences] = await Promise.all([
        gateway.listConnections(owner),
        gateway.getPreferences(owner),
      ]);
      return reply.send({
        ready: true,
        blockedReason: null,
        encryption: { algorithm: 'aes-256-gcm', keyVersions: [...service.keyVersions] },
        providers: connections.map((entry) => ({
          ...entry.connection,
          models: entry.models,
          isDefault: entry.isDefault,
          healthy: entry.healthy,
        })),
        preferences: {
          defaultConnectionId: preferences.defaultConnectionId ?? null,
          defaultModelId: preferences.defaultModelId ?? null,
          projects: preferences.projects,
        },
        catalog: gateway.catalog(),
      });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/ai/providers/catalog', async (_request, reply) => {
    if (!service.gateway) {
      return reply.send({ ready: false, catalog: [], blockedReason: service.blockedReason });
    }
    return reply.send({ ready: true, catalog: service.gateway.catalog() });
  });

  app.post('/api/ai/providers/connections', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const providerId = typeof body.providerId === 'string' ? body.providerId : '';
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
      const input: CreateConnectionInput = {
        providerId,
        apiKey,
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
        ...(typeof body.baseUrl === 'string' && body.baseUrl.length > 0
          ? { baseUrl: body.baseUrl }
          : {}),
        ...(parseStrings(body.modelIds, 'modelIds')
          ? { modelIds: parseStrings(body.modelIds, 'modelIds') }
          : {}),
        ...(typeof body.defaultModelId === 'string' ? { defaultModelId: body.defaultModelId } : {}),
        ...(body.authFormat === 'bearer' ||
        body.authFormat === 'x-api-key' ||
        body.authFormat === 'query-key'
          ? { authFormat: body.authFormat }
          : {}),
        ...(body.skipDiscovery === true ? { skipDiscovery: true } : {}),
      };
      const view = await gateway.createConnection(owner, input);
      return reply.status(201).send({ connection: view });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/ai/providers/connections/:id/validate', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const { id } = request.params as { id: string };
      const result = await gateway.validateConnection(owner, id);
      // Re-read the connection so the caller sees the status this check produced.
      const listed = (await gateway.listConnections(owner)).find(
        (entry) => entry.connection.id === id,
      );
      return reply.send({
        valid: result.valid,
        errorCategory: result.errorCategory ?? null,
        connection: listed?.connection ?? null,
      });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/ai/providers/connections/:id/models', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as { refresh?: string };
      const models =
        query.refresh === 'true'
          ? await gateway.discoverModels(owner, id)
          : ((await gateway.listConnections(owner)).find((entry) => entry.connection.id === id)
              ?.models ?? null);
      if (models === null) {
        throw new GatewayError(
          'GATEWAY_CONNECTION_NOT_FOUND',
          'That provider connection does not exist.',
        );
      }
      return reply.send({ models });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.patch('/api/ai/providers/connections/:id', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const patch: UpdateConnectionInput = {
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
        ...(body.modelIds !== undefined
          ? { modelIds: parseStrings(body.modelIds, 'modelIds') ?? [] }
          : {}),
        ...(body.defaultModelId === null
          ? { defaultModelId: null }
          : typeof body.defaultModelId === 'string'
            ? { defaultModelId: body.defaultModelId }
            : {}),
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
        ...(body.status === 'active' || body.status === 'disabled' ? { status: body.status } : {}),
      };
      const view = await gateway.updateConnection(owner, id, patch);
      return reply.send({ connection: view });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  /** Replaces the stored secret without changing the connection id. */
  app.post('/api/ai/providers/connections/:id/credential', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { apiKey?: unknown };
      if (typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) {
        throw new GatewayError('GATEWAY_INVALID_REQUEST', 'An API key is required.');
      }
      const view = await gateway.replaceCredential(owner, id, body.apiKey);
      return reply.send({ connection: view });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.delete('/api/ai/providers/connections/:id', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const { id } = request.params as { id: string };
      await gateway.deleteConnection(owner, id);
      return reply.status(204).send();
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/ai/providers/preferences', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const preferences = await gateway.getPreferences(owner);
      return reply.send({
        defaultConnectionId: preferences.defaultConnectionId ?? null,
        defaultModelId: preferences.defaultModelId ?? null,
        projects: preferences.projects,
      });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  app.put('/api/ai/providers/preferences', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const projects: Record<string, { connectionId: string; modelId: string } | null> = {};
      if (body.projects && typeof body.projects === 'object' && !Array.isArray(body.projects)) {
        for (const [projectId, value] of Object.entries(body.projects as Record<string, unknown>)) {
          if (projectId.trim().length === 0) continue;
          if (value === null) {
            projects[projectId] = null;
            continue;
          }
          if (value && typeof value === 'object') {
            const record = value as { connectionId?: unknown; modelId?: unknown };
            if (typeof record.connectionId === 'string' && typeof record.modelId === 'string') {
              projects[projectId] = { connectionId: record.connectionId, modelId: record.modelId };
            }
          }
        }
      }
      const preferences = await gateway.setPreferences(owner, {
        ...(body.defaultConnectionId === null
          ? { defaultConnectionId: null }
          : typeof body.defaultConnectionId === 'string'
            ? { defaultConnectionId: body.defaultConnectionId }
            : {}),
        ...(body.defaultModelId === null
          ? { defaultModelId: null }
          : typeof body.defaultModelId === 'string'
            ? { defaultModelId: body.defaultModelId }
            : {}),
        ...(Object.keys(projects).length > 0 ? { projects } : {}),
      });
      return reply.send({
        defaultConnectionId: preferences.defaultConnectionId ?? null,
        defaultModelId: preferences.defaultModelId ?? null,
        projects: preferences.projects,
      });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  /** Usage metadata: provider, model, status, tokens the provider reported and
   *  latency. Never prompt text, never credentials, and no invented cost. */
  app.get('/api/ai/providers/usage', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const query = (request.query ?? {}) as { limit?: string };
      const limit = Number(query.limit ?? 25);
      const records = await gateway.listUsage(owner, Number.isFinite(limit) ? limit : 25);
      return reply.send({ usage: records, costAvailable: false });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });

  /** Generates through the owner's own provider. Used by the settings page's
   *  "test connection" action and by any reasoning service that opts in. */
  app.post('/api/ai/providers/generate', async (request, reply) => {
    try {
      const gateway = requireGateway(service);
      const owner = ownerOf(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const messages = Array.isArray(body.messages)
        ? body.messages
            .filter(
              (message): message is { role: string; content: string } =>
                Boolean(message) &&
                typeof message === 'object' &&
                typeof (message as { content?: unknown }).content === 'string' &&
                ['user', 'assistant', 'system'].includes(
                  String((message as { role?: unknown }).role),
                ),
            )
            .slice(0, 40)
            .map((message) => ({
              role: (message.role === 'system' ? 'system' : message.role) as
                'user' | 'assistant' | 'system',
              content: message.content.slice(0, 20_000),
            }))
        : [];
      if (messages.length === 0) {
        throw new GatewayError('GATEWAY_INVALID_REQUEST', 'At least one message is required.');
      }
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.slice(0, 128) : undefined;
      let connectionId = typeof body.connectionId === 'string' ? body.connectionId : undefined;
      let modelId = typeof body.modelId === 'string' ? body.modelId : undefined;
      let routing: { decisionId: string; summary: string } | null = null;

      // No model named: the router decides, once, before anything is billed.
      if ((connectionId === undefined || modelId === undefined) && deps.router !== undefined) {
        const category = isTaskCategory(body.category) ? body.category : 'general-conversation';
        const decision = await deps.router.routeFor(owner.ownerRef, {
          category,
          ...(projectId !== undefined ? { projectId } : {}),
          purpose: 'provider generation',
        });
        if (decision.outcome !== 'routed' || decision.selected === null) {
          return reply.status(409).send({
            error: { code: 'GATEWAY_NO_PROVIDER_CONFIGURED', message: decision.summary },
            decision,
          });
        }
        connectionId = decision.selected.connectionId;
        modelId = decision.selected.modelId;
        routing = { decisionId: decision.id, summary: decision.summary };
      }

      const outcome = await gateway.generate(
        { ownerRef: owner.ownerRef, ...(projectId ? { projectId } : {}) },
        {
          messages,
          ...(typeof body.system === 'string' ? { system: body.system.slice(0, 8000) } : {}),
          connectionId,
          modelId,
          ...(projectId !== undefined ? { projectId } : {}),
        },
      );

      // Execution evidence for outage pausing and the speed preference.
      if (deps.router !== undefined) {
        await deps.router
          .recordOutcome(owner.ownerRef, {
            providerId: outcome.providerId,
            modelId: outcome.modelId,
            status: 'success',
            latencyMs: outcome.latencyMs,
          })
          .catch(() => undefined);
      }

      return reply.send({
        content: outcome.content,
        providerId: outcome.providerId,
        modelId: outcome.modelId,
        connectionId: outcome.connectionId,
        finishReason: outcome.finishReason,
        usage: outcome.usage,
        latencyMs: outcome.latencyMs,
        live: outcome.live,
        ...(routing !== null ? { routing } : {}),
        ...(deps.persistenceNote ? { routingPersistence: deps.persistenceNote } : {}),
      });
    } catch (error) {
      const mapped = toError(error);
      return reply.status(mapped.status).send(mapped.body);
    }
  });
}
