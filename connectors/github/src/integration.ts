import { defineIntegration, type IntegrationDefinition } from '@veltravia/integration-core';

import { githubPermissionCatalog, GITHUB_CONNECTOR_ID } from './connector.js';
import { createGitHubToolDefinitions } from './tools.js';

/**
 * The GitHub integration: the migration of the Step 10 connector onto the
 * Step 12 integration framework.
 *
 * One integration maps to exactly one connector (same id,
 * GITHUB_CONNECTOR_ID). This definition is HAND-WRITTEN against the
 * connector's own declarations - the permission catalog and the tool
 * definitions are the single source of truth, so the catalog entry can
 * never drift from the executable surface:
 *
 * - scopes = the connector's declared permission catalog
 * - tools = the connector's registered Tool System definitions, each
 *   referencing its connector operation
 * - execution stays exactly where it was: through the Tool System gate,
 *   then the GitHub runtime's scope enforcement. Registration as an
 *   integration changes DISCOVERY, not execution.
 */

/** The GitHub integration definition (catalog identity card). */
export function githubIntegrationDefinition(): IntegrationDefinition {
  const tools = createGitHubToolDefinitions(GITHUB_CONNECTOR_ID);
  const operations = new Map<string, { readonly name: string; readonly description: string }>();
  for (const definition of tools) {
    if (definition.connector !== undefined) {
      operations.set(definition.connector.operationId, {
        name: definition.name,
        description: definition.description,
      });
    }
  }
  return defineIntegration({
    id: GITHUB_CONNECTOR_ID,
    name: 'GitHub',
    description:
      'Source-control integration for repositories: list repositories, read branches and file contents, create branches, and publish file changes - always scoped to the configured repositories.',
    version: '1.0.0',
    publisher: 'Veltravia',
    category: 'development',
    iconRef: 'initial:G',
    authenticationType: 'access_token',
    capabilities: ['read', 'write', 'manage_files'],
    scopes: githubPermissionCatalog(),
    tools: tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      operationId: tool.connector?.operationId ?? tool.id,
      requiredScopes: [...tool.requiredPermissions],
      riskLevel: tool.riskLevel,
      requiresConfirmation: tool.requiresConfirmation,
    })),
    environments: ['development', 'production'],
    documentation: [{ label: 'GitHub REST API docs', url: 'https://docs.github.com/rest' }],
  });
}

export { GITHUB_CONNECTOR_ID as GITHUB_INTEGRATION_ID };
