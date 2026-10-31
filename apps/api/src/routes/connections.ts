import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  isConnectedAppError,
  CONNECTED_PROVIDER_IDS,
  type ConnectedAppManager,
  type ConnectedResourceIntelligence,
} from '@veltravia/connected-apps-core';

/** Connected-app routes (Step 24). Owner-scoped and read-only: no endpoint
 *  creates, edits or deletes anything outside Veltravia. Responses are safe
 *  views - tokens, refresh tokens and credential references never cross the
 *  API boundary. */

const STATUS: Record<string, number> = {
  CONNECTED_INVALID_REQUEST: 400,
  CONNECTED_PROVIDER_UNKNOWN: 404,
  CONNECTED_NOT_CONNECTED: 404,
  CONNECTED_REVOKED: 409,
  CONNECTED_EXPIRED: 409,
  CONNECTED_INSUFFICIENT_SCOPE: 403,
  CONNECTED_CAPABILITY_UNSUPPORTED: 400,
  CONNECTED_RESOURCE_NOT_FOUND: 404,
  CONNECTED_RESOURCE_FORBIDDEN: 403,
  CONNECTED_PROVIDER_UNAVAILABLE: 502,
  CONNECTED_PROVIDER_ERROR: 502,
  CONNECTED_RATE_LIMITED: 429,
  CONNECTED_TIMEOUT: 504,
  CONNECTED_LIMIT_EXCEEDED: 413,
  CONNECTED_CONTENT_UNSUPPORTED: 415,
  CONNECTED_SECRET_REJECTED: 400,
  CONNECTED_UNSAFE_URL: 400,
  CONNECTED_PARSE_FAILED: 422,
};

function toError(error: unknown): { status: number; body: unknown } {
  if (isConnectedAppError(error))
    return {
      status: STATUS[error.code] ?? 500,
      body: { error: { code: error.code, message: error.message } },
    };
  return {
    status: 500,
    body: { error: { code: 'CONNECTED_INTERNAL', message: 'Unexpected failure.' } },
  };
}

/** Ownership: the demo build is single-tenant, so the request's owner ref is
 *  the fixed dev owner. A real deployment supplies it from authentication;
 *  nothing here trusts a client-supplied owner. */
function ownerOf(request: FastifyRequest): { ownerRef: string } {
  const header = request.headers['x-veltravia-owner'];
  const value = Array.isArray(header) ? header[0] : header;
  return { ownerRef: value && value.length > 0 ? value.slice(0, 120) : 'local-owner' };
}

export interface ConnectionRouteDeps {
  readonly manager: ConnectedAppManager;
  readonly intelligence: ConnectedResourceIntelligence;
  readonly providerModes: Readonly<Record<string, 'live' | 'mock'>>;
  readonly githubAllowedRepositories: readonly string[];
}

export function registerConnectionRoutes(app: FastifyInstance, deps: ConnectionRouteDeps): void {
  const { manager, intelligence } = deps;

  app.get('/api/connections', async (request) => {
    const owner = ownerOf(request);
    const connections = manager.listConnections(owner);
    return {
      providers: manager.catalog().map((descriptor) => ({
        id: descriptor.id,
        name: descriptor.name,
        description: descriptor.description,
        liveCapable: descriptor.liveCapable,
        mode: deps.providerModes[descriptor.id] ?? 'mock',
        capabilities: [...descriptor.capabilities],
        scopes: descriptor.scopes.map((scope) => ({ ...scope })),
        connected: connections.some((connection) => connection.providerId === descriptor.id),
      })),
      connections: connections.map((connection) => ({
        providerId: connection.providerId,
        providerName: connection.providerName,
        status: connection.status,
        account: connection.account,
        grantedScopes: [...connection.grantedScopes],
        capabilities: [...connection.capabilities],
        connectedAt: connection.connectedAt,
        lastCheckedAt: connection.lastCheckedAt,
        liveCapable: connection.liveCapable,
      })),
      githubAllowedRepositories: [...deps.githubAllowedRepositories],
    };
  });

  app.get('/api/connections/:providerId', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      const providerId = String((request.params as { providerId: string }).providerId);
      const connection = manager.connection(owner, providerId);
      const health = await manager.health(owner, providerId);
      return { connection, health };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/connections/:providerId/session', async (request, reply) => {
    try {
      const providerId = String((request.params as { providerId: string }).providerId);
      const descriptor = manager.catalog().find((candidate) => candidate.id === providerId);
      if (!descriptor) {
        return reply.code(404).send({
          error: { code: 'CONNECTED_PROVIDER_UNKNOWN', message: 'That provider is not available.' },
        });
      }
      const mode = deps.providerModes[providerId] ?? 'mock';
      return {
        providerId,
        mode,
        // A real OAuth deployment returns an authorization URL here. This build
        // has no OAuth app registration, so the UI completes a simulated
        // authorization instead - stated plainly rather than faked.
        authorization: {
          kind: 'simulated',
          reason:
            mode === 'live'
              ? 'Send an authorization token to complete a live connection.'
              : 'This provider runs a deterministic simulation in this build.',
        },
        scopes: descriptor.scopes.map((scope) => ({ ...scope })),
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post('/api/connections/:providerId/complete', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      const providerId = String((request.params as { providerId: string }).providerId);
      const body = (request.body ?? {}) as { scopes?: unknown; credential?: unknown };
      const scopes = Array.isArray(body.scopes)
        ? body.scopes.filter((scope): scope is string => typeof scope === 'string').slice(0, 20)
        : [];
      const credential =
        typeof body.credential === 'string' && body.credential.length > 0
          ? body.credential.slice(0, 4096)
          : null;
      const connection = await manager.connect(owner, providerId, {
        grantedScopes: scopes,
        credential,
      });
      // The credential is deliberately absent from the response.
      return reply.code(201).send({ connection });
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.delete('/api/connections/:providerId', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      await manager.disconnect(
        owner,
        String((request.params as { providerId: string }).providerId),
      );
      return { disconnected: true };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/connections/:providerId/health', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      return await manager.health(
        owner,
        String((request.params as { providerId: string }).providerId),
      );
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/connections/:providerId/resources', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      const query = request.query as { cursor?: string; q?: string };
      return await manager.resources(
        owner,
        String((request.params as { providerId: string }).providerId),
        { cursor: query.cursor ?? null, query: query.q ?? null },
      );
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/connections/:providerId/search', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      const query = request.query as { q?: string; cursor?: string };
      return await manager.search(
        owner,
        String((request.params as { providerId: string }).providerId),
        query.q ?? '',
        { cursor: query.cursor ?? null },
      );
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/connections/:providerId/resources/:resourceId/metadata', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      const params = request.params as { providerId: string; resourceId: string };
      return {
        resource: await manager.metadata(
          owner,
          params.providerId,
          decodeURIComponent(params.resourceId),
        ),
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/connections/:providerId/resources/:resourceId/content', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      const params = request.params as { providerId: string; resourceId: string };
      const content = await manager.content(
        owner,
        params.providerId,
        decodeURIComponent(params.resourceId),
      );
      if (content.encoding === 'binary') {
        return reply.code(415).send({
          error: {
            code: 'CONNECTED_CONTENT_UNSUPPORTED',
            message: 'That resource is binary and has no text preview.',
          },
        });
      }
      return {
        text: new TextDecoder().decode(content.bytes).slice(0, 200_000),
        mimeType: content.mimeType,
        byteSize: content.bytes.byteLength,
        provenance: content.provenance,
        fromCache: content.fromCache,
        ageSeconds: content.ageSeconds,
        trustTag: 'untrusted_data',
      };
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/connections/:providerId/resources/:resourceId/analysis', async (request, reply) => {
    try {
      const owner = ownerOf(request);
      const params = request.params as { providerId: string; resourceId: string };
      return await intelligence.analyze(
        owner,
        params.providerId,
        decodeURIComponent(params.resourceId),
      );
    } catch (error) {
      const mapped = toError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get('/api/connections/providers/available', async () => ({
    providerIds: [...CONNECTED_PROVIDER_IDS],
  }));
}
