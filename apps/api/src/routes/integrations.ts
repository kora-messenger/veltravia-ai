import type { FastifyInstance } from 'fastify';

import {
  integrationToSafeView,
  isIntegrationError,
  type Connection,
  type IntegrationError,
} from '@veltravia/integration-core';

import type { ApiIntegrationSystem } from '../integrations.js';

/**
 * Integration / plugin surface (Step 12).
 *
 * Read-only for the CATALOG (integrations, scopes, tools, risk metadata)
 * and owner-scoped for CONNECTIONS (create / list / disable / enable /
 * disconnect / status-check). No endpoint executes anything, grants
 * anything, or touches credentials: connection records are metadata only,
 * secrets never leave the boundary, and the safe views are scrubbed.
 *
 * Error mapping is stable and typed: unknown ids are 404, invalid
 * requests 400, disabled/limit/credential states 409, missing grants 403,
 * and framework failures never leak implementation detail.
 */

const listIntegrationsSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {},
};

const createConnectionSchema = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['scopes'],
  properties: {
    scopes: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 128 },
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    },
    accountRef: { type: 'string', minLength: 1, maxLength: 120 },
  },
};

function statusForError(error: IntegrationError): number {
  switch (error.code) {
    case 'INTEGRATION_NOT_FOUND':
    case 'CONNECTION_NOT_FOUND':
      return 404;
    case 'INTEGRATION_INVALID':
    case 'INTEGRATION_CONFIGURATION_INVALID':
      return 400;
    case 'INTEGRATION_DISABLED':
    case 'INTEGRATION_DUPLICATE':
    case 'INTEGRATION_IN_USE':
    case 'CONNECTION_LIMIT_REACHED':
    case 'INTEGRATION_CREDENTIAL_UNAVAILABLE':
      return 409;
    case 'MISSING_SCOPE':
    case 'CONNECTION_NOT_AUTHORIZED':
      return 403;
    default:
      return 502;
  }
}

/** A scrubbed, serializable connection view - metadata only, never secrets. */
function connectionView(connection: Connection): Record<string, unknown> {
  return {
    connectionId: connection.connectionId,
    integrationId: connection.integrationId,
    status: connection.status,
    ...(connection.statusDetail !== undefined ? { statusDetail: connection.statusDetail } : {}),
    accountRef: connection.accountRef,
    grantedScopes: [...connection.grantedScopes],
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    ...(connection.lastStatusCheckAt !== undefined
      ? { lastStatusCheckAt: connection.lastStatusCheckAt }
      : {}),
    operationCount: connection.operationCount,
  };
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  system: ApiIntegrationSystem,
): void {
  // ---------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------
  app.get(
    '/api/integrations',
    { schema: { querystring: listIntegrationsSchema } },
    async (): Promise<Record<string, unknown>> => ({
      integrations: system.registry.list().map((definition) => {
        const connections = system.connections
          .listOwnedBy(definition.id, system.owner)
          .map(connectionView);
        return {
          ...integrationToSafeView(definition),
          enabled: system.registry.isEnabled(definition.id),
          connections,
        };
      }),
    }),
  );

  app.get('/api/integrations/:integrationId', async (request, reply): Promise<void> => {
    const { integrationId } = request.params as { integrationId: string };
    if (!system.registry.has(integrationId)) {
      reply.code(404).send({
        error: 'INTEGRATION_NOT_FOUND',
        message: `Integration "${integrationId}" is not registered.`,
      });
      return;
    }
    const definition = system.registry.get(integrationId);
    const connections = system.connections
      .listOwnedBy(integrationId, system.owner)
      .map(connectionView);
    reply.send({
      ...integrationToSafeView(definition),
      enabled: system.registry.isEnabled(integrationId),
      connections,
    });
  });

  // ---------------------------------------------------------------
  // Connections (owner-scoped lifecycle)
  // ---------------------------------------------------------------
  app.post(
    '/api/integrations/:integrationId/connections',
    { schema: { body: createConnectionSchema } },
    async (request, reply): Promise<void> => {
      const { integrationId } = request.params as { integrationId: string };
      const body = request.body as { scopes: string[]; accountRef?: string };
      if (!system.registry.has(integrationId)) {
        reply.code(404).send({
          error: 'INTEGRATION_NOT_FOUND',
          message: `Integration "${integrationId}" is not registered.`,
        });
        return;
      }
      if (!system.registry.isEnabled(integrationId)) {
        reply.code(409).send({
          error: 'INTEGRATION_DISABLED',
          message: `Integration "${integrationId}" is disabled.`,
        });
        return;
      }
      try {
        const connection = system.connections.create(system.registry.get(integrationId), {
          integrationId,
          owner: system.owner,
          scopes: body.scopes,
          ...(body.accountRef !== undefined ? { accountRef: body.accountRef } : {}),
        });
        reply.code(201).send(connectionView(connection));
      } catch (error) {
        if (isIntegrationError(error)) {
          reply.code(statusForError(error)).send({ error: error.code, message: error.message });
          return;
        }
        request.log.error(error);
        reply.code(500).send({
          error: 'INTEGRATION_EXECUTION_FAILED',
          message: 'The connection could not be created.',
        });
      }
    },
  );

  app.get(
    '/api/integrations/:integrationId/connections/:connectionId',
    async (request, reply): Promise<void> => {
      const { integrationId, connectionId } = request.params as {
        integrationId: string;
        connectionId: string;
      };
      if (!system.registry.has(integrationId)) {
        reply.code(404).send({
          error: 'INTEGRATION_NOT_FOUND',
          message: `Integration "${integrationId}" is not registered.`,
        });
        return;
      }
      try {
        const connection = system.connections.get(connectionId, system.owner);
        if (connection.integrationId !== integrationId) {
          reply.code(404).send({
            error: 'CONNECTION_NOT_FOUND',
            message: `Connection "${connectionId}" does not belong to "${integrationId}".`,
          });
          return;
        }
        reply.send(connectionView(connection));
      } catch (error) {
        if (isIntegrationError(error)) {
          reply.code(statusForError(error)).send({ error: error.code, message: error.message });
          return;
        }
        request.log.error(error);
        reply.code(500).send({
          error: 'INTEGRATION_EXECUTION_FAILED',
          message: 'The connection could not be read.',
        });
      }
    },
  );

  app.post(
    '/api/integrations/:integrationId/connections/:connectionId/disable',
    async (request, reply): Promise<void> => {
      await withOwnedConnection(
        app,
        system,
        request,
        reply,
        (connection) => system.connections.disable(connection.connectionId, system.owner),
        'disable',
      );
    },
  );

  app.post(
    '/api/integrations/:integrationId/connections/:connectionId/enable',
    async (request, reply): Promise<void> => {
      await withOwnedConnection(
        app,
        system,
        request,
        reply,
        (connection) => system.connections.enable(connection.connectionId, system.owner),
        'enable',
      );
    },
  );

  app.delete(
    '/api/integrations/:integrationId/connections/:connectionId',
    async (request, reply): Promise<void> => {
      await withOwnedConnection(
        app,
        system,
        request,
        reply,
        (connection) => {
          system.connections.disconnect(connection.connectionId, system.owner);
          return undefined;
        },
        'disconnect',
      );
    },
  );

  app.post(
    '/api/integrations/:integrationId/connections/:connectionId/status-check',
    async (request, reply): Promise<void> => {
      const { integrationId, connectionId } = request.params as {
        integrationId: string;
        connectionId: string;
      };
      if (!system.registry.has(integrationId)) {
        reply.code(404).send({
          error: 'INTEGRATION_NOT_FOUND',
          message: `Integration "${integrationId}" is not registered.`,
        });
        return;
      }
      // Resolves inside the owner boundary (fail closed) - the value itself
      // is not needed here, only the boundary enforcement.
      try {
        system.connections.get(connectionId, system.owner);
      } catch (error) {
        if (isIntegrationError(error)) {
          reply.code(statusForError(error)).send({ error: error.code, message: error.message });
          return;
        }
        throw error;
      }
      const checker = system.healthCheckers[integrationId];
      if (checker === undefined) {
        reply.code(502).send({
          error: 'INTEGRATION_EXECUTION_FAILED',
          message: 'No health checker is available for this integration.',
        });
        return;
      }
      const outcome = await checker();
      const updated = system.connections.recordStatusCheck(connectionId, system.owner, outcome);
      reply.send(connectionView(updated));
    },
  );
}

/** Shared owner-scoped connection action helper (disable/enable/disconnect). */
async function withOwnedConnection(
  app: FastifyInstance,
  system: ApiIntegrationSystem,
  request: { readonly params: unknown; readonly log: { error: (error: unknown) => void } },
  reply: {
    code(status: number): { send(payload: unknown): void };
    send(payload: unknown): void;
  },
  action: (connection: Connection) => Connection | undefined,
  actionName: string,
): Promise<void> {
  void app;
  const { integrationId, connectionId } = request.params as {
    integrationId: string;
    connectionId: string;
  };
  if (!system.registry.has(integrationId)) {
    reply.code(404).send({
      error: 'INTEGRATION_NOT_FOUND',
      message: `Integration "${integrationId}" is not registered.`,
    });
    return;
  }
  try {
    const connection = system.connections.get(connectionId, system.owner);
    if (connection.integrationId !== integrationId) {
      reply.code(404).send({
        error: 'CONNECTION_NOT_FOUND',
        message: `Connection "${connectionId}" does not belong to "${integrationId}".`,
      });
      return;
    }
    const result = action(connection);
    reply.send(result === undefined ? { disconnected: true } : connectionView(result));
  } catch (error) {
    if (isIntegrationError(error)) {
      reply.code(statusForError(error)).send({ error: error.code, message: error.message });
      return;
    }
    request.log.error(error);
    reply.code(500).send({
      error: 'INTEGRATION_EXECUTION_FAILED',
      message: `The connection could not be ${actionName}d.`,
    });
  }
}
