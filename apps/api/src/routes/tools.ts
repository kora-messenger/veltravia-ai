import type { FastifyInstance } from 'fastify';
import { isToolError, type ToolManager } from '@veltravia/tool-core';

/** Maps normalized tool error codes to HTTP status codes. */
const TOOL_ERROR_STATUS: Record<string, number> = {
  TOOL_NOT_FOUND: 404,
  DUPLICATE_TOOL: 409,
  INVALID_TOOL_DEFINITION: 400,
  INVALID_TOOL_INPUT: 400,
  TOOL_PERMISSION: 403,
  TOOL_CONFIRMATION_REQUIRED: 403,
  TOOL_CONFIRMATION_REJECTED: 403,
  TOOL_UNAVAILABLE: 409,
  TOOL_EXECUTION: 500,
  TOOL_OUTPUT_VALIDATION: 500,
};

/** List entry: safe metadata only. */
function listEntry(manager: ToolManager, toolId: string) {
  const tool = manager.getDefinition(toolId);
  const availability = manager.getAvailability(toolId);
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    version: tool.version,
    category: tool.category,
    requiredPermissions: [...tool.requiredPermissions],
    riskLevel: tool.riskLevel,
    confirmationRequired:
      tool.requiresConfirmation || tool.riskLevel === 'high' || tool.riskLevel === 'critical',
    availability: availability.state,
    ...(availability.detail !== undefined ? { availabilityDetail: availability.detail } : {}),
    ...(tool.connector !== undefined
      ? {
          connector: {
            connectorId: tool.connector.connectorId,
            operationId: tool.connector.operationId,
          },
        }
      : {}),
  };
}

/**
 * Read-only tool inspection endpoints - Step 5 proves the Tool System, and
 * NOTHING here can execute a tool, grant a permission, approve a
 * confirmation, or touch a credential. Invocation endpoints arrive only
 * with the future agent layer, behind the full permission gate.
 */
export function registerToolRoutes(app: FastifyInstance, manager: ToolManager): void {
  app.get('/api/tools', async () => ({
    tools: manager.list().map((tool) => listEntry(manager, tool.id)),
  }));

  app.get('/api/tools/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const inspection = manager.inspect(id);
      return reply.send({
        definition: {
          id: inspection.definition.id,
          name: inspection.definition.name,
          description: inspection.definition.description,
          version: inspection.definition.version,
          category: inspection.definition.category,
          riskLevel: inspection.definition.riskLevel,
          requiresConfirmation: inspection.definition.requiresConfirmation,
        },
        requiredPermissions: inspection.requiredPermissions,
        grantedPermissions: inspection.grantedPermissions,
        confirmationRequired: inspection.confirmationRequired,
        availability: inspection.availability,
        hasConnectorReference: inspection.hasConnectorReference,
        hasLocalImplementation: inspection.hasLocalImplementation,
        // NOTE: schemas are intentionally omitted from the list/detail
        // payloads as a minimal surface; execution is not exposed at all.
      });
    } catch (error) {
      if (!isToolError(error)) throw error;
      const status = TOOL_ERROR_STATUS[error.code] ?? 500;
      return reply.code(status).send({ error: error.toJSON() });
    }
  });
}
