import type { FastifyInstance } from 'fastify';
import { isConnectorError, type ConnectorManager } from '@veltravia/connector-core';

/** Maps normalized connector error codes to HTTP status codes. */
const ERROR_STATUS: Record<string, number> = {
  CONNECTOR_NOT_FOUND: 404,
  DUPLICATE_CONNECTOR: 409,
  INVALID_CONNECTOR: 400,
  CONNECTOR_CONFIGURATION: 500,
  CONNECTOR_AUTHENTICATION: 500,
  CONNECTOR_PERMISSION: 403,
  CONNECTOR_OPERATION: 400,
  CONNECTOR_CONNECTION: 502,
};

/** List entry: metadata + status only. */
function listEntry(manager: ConnectorManager, id: string) {
  const connector = manager.get(id);
  return {
    id: connector.metadata.id,
    name: connector.metadata.name,
    version: connector.metadata.version,
    description: connector.metadata.description,
    category: connector.metadata.category,
    capabilities: [...connector.metadata.capabilities],
    status: manager.getStatus(id).status,
    permissionCount: connector.permissions.length,
    operationCount: connector.operations.length,
  };
}

/**
 * Read-only connector endpoints - Step 4 proves the architecture, nothing
 * here can mutate connectors, credentials, or external services.
 *
 * SECURITY: responses contain metadata, capabilities, permissions, and
 * operations ONLY. Credential references are intentionally omitted from API
 * responses entirely, and no raw secret can exist anywhere in this payload.
 */
export function registerConnectorRoutes(app: FastifyInstance, manager: ConnectorManager): void {
  app.get('/api/connectors', async () => ({
    connectors: manager.list().map((connector) => listEntry(manager, connector.metadata.id)),
  }));

  app.get('/api/connectors/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const inspection = manager.inspect(id);
      return reply.send({
        metadata: inspection.metadata,
        capabilities: inspection.capabilities,
        permissions: inspection.permissions,
        grantedPermissions: inspection.grantedPermissions,
        operations: inspection.operations,
        status: inspection.status,
        // NOTE: the credential REFERENCE is omitted from API responses by
        // design - nothing credential-shaped crosses the HTTP boundary.
      });
    } catch (error) {
      if (!isConnectorError(error)) throw error;
      const status = ERROR_STATUS[error.code] ?? 500;
      // Typed error surface: { error: { code, message } } - no stack, no secrets.
      return reply.code(status).send({ error: error.toJSON() });
    }
  });
}
