import {
  ConnectionManager,
  IntegrationRegistry,
  IntegrationRuntime,
  InMemorySecretStore,
  type Connection,
  type ConnectionOwner,
  type IntegrationAuditEvent,
} from '@veltravia/integration-core';
import {
  createMockDatabaseExecutor,
  createMockStorageExecutor,
  mockDatabaseConnector,
  mockDatabaseDefinition,
  mockDatabaseToolDefinitions,
  MOCK_DATABASE_ID,
  mockStorageConnector,
  mockStorageDefinition,
  mockStorageToolDefinitions,
  MOCK_STORAGE_ID,
} from '@veltravia/integration-mocks';
import type { ToolDefinition, ToolManager } from '@veltravia/tool-core';
import type { ConnectorOperationExecutor } from '@veltravia/tool-core';

import type { GitHubApiConnector } from './github.js';
import { githubIntegrationDefinition, GITHUB_INTEGRATION_ID } from '@veltravia/connector-github';

/**
 * API wiring for the integration / plugin system (Step 12).
 *
 * Assembles ONE running multi-connector system:
 *
 *   registry (catalog)  ->  connection manager (owner boundaries)
 *   ->  secret store (the boundary)  ->  connector runtime (execution)
 *
 * Three integrations are registered - GitHub (migrated from Step 10;
 * discovery only, execution stays on its existing Tool System path) and
 * the two offline mocks (storage + database), which ride the integration
 * runtime end to end: their tools are registered into the agent Tool
 * System with server-side operator grants, so a run can discover and
 * invoke them like any other tool - with NO connector-specific agent code
 * anywhere. The agent sees tool metadata (now carrying `integrationId`)
 * and a connection id; the runtime enforces scopes, state, risk, and the
 * secret boundary.
 *
 * DEVELOPMENT-ONLY LIMITATIONS (documented in docs/integrations.md):
 * - connections live in memory; a future phase adds persistence
 * - the API is single-tenant: every connection belongs to the operator
 *   owner below; cross-owner protection is enforced and tested at the
 *   package level and will surface when authentication lands
 * - the secret store is the in-memory development provider
 */

/** The single-tenant operator owner for the demo API. */
export function integrationOwner(): ConnectionOwner {
  const ref = process.env['VELTRAVIA_DEFAULT_OWNER_REF'];
  return { kind: 'user', id: typeof ref === 'string' && ref.length > 0 ? ref : 'veltravia-demo' };
}

export interface ApiIntegrationSystem {
  readonly registry: IntegrationRegistry;
  readonly connections: ConnectionManager;
  readonly secrets: InMemorySecretStore;
  readonly runtime: IntegrationRuntime;
  readonly audit: readonly IntegrationAuditEvent[];
  readonly owner: ConnectionOwner;
  /** Health checkers per integration (offline for the mocks). */
  readonly healthCheckers: Readonly<
    Record<string, () => Promise<{ healthy: boolean; detail?: string }>>
  >;
  /** Registers the mock-integration tools into a ToolManager (operator grants). */
  registerAgentTools(tools: ToolManager): readonly string[];
  /**
   * The Step 10 connector execution seam for integration-backed tools:
   * receives ALREADY-AUTHORIZED, schema-validated invocations and routes
   * them through the integration runtime (owner boundary + scopes + risk +
   * secret boundary). Never re-runs the confirmation flow.
   */
  connectorExecutor(): ConnectorOperationExecutor;
  /** The boot-time demo connections, keyed by integration id. */
  readonly demoConnections: Readonly<Record<string, Connection>>;
}

export interface IntegrationSystemOptions {
  readonly now?: () => Date;
  /** The existing GitHub API connector (env-decided real/demo mode). */
  readonly github: GitHubApiConnector;
  /** Audit sink for the whole integration system. */
  readonly onAudit?: (event: IntegrationAuditEvent) => void;
}

export function createIntegrationSystem(options: IntegrationSystemOptions): ApiIntegrationSystem {
  const now = options.now ?? (() => new Date());
  const owner = integrationOwner();
  const audit: IntegrationAuditEvent[] = [];
  const sink = (event: IntegrationAuditEvent): void => {
    audit.push(event);
    options.onAudit?.(event);
  };

  const registry = new IntegrationRegistry({ onAudit: sink });
  const connections = new ConnectionManager({ now, onAudit: sink });
  const secrets = new InMemorySecretStore();
  const github = options.github;

  const runtime = new IntegrationRuntime({
    registry,
    connections,
    secrets,
    executors: {
      // GitHub: the integration runtime delegates to the EXISTING Step 10
      // runtime (scope enforcement + transport stay exactly where they
      // were). Registration changes discovery, not execution.
      [GITHUB_INTEGRATION_ID]: (input, context) =>
        github.runtime.executeOperation(context.operationId, input),
      [MOCK_STORAGE_ID]: createMockStorageExecutor(),
      [MOCK_DATABASE_ID]: createMockDatabaseExecutor(),
    },
    now,
    onAudit: sink,
  });

  // ---------------------------------------------------------------------
  // Catalog registration
  // ---------------------------------------------------------------------
  registry.register(githubIntegrationDefinition());
  registry.register(mockStorageDefinition());
  registry.register(mockDatabaseDefinition());

  // ---------------------------------------------------------------------
  // Boot-time demo connections (honest, offline/documented)
  // ---------------------------------------------------------------------
  const demoConnections: Record<string, Connection> = {};

  // GitHub: one connection mirroring the env-decided mode. In REAL mode the
  // env token enters the in-memory secret boundary at boot (never
  // serialized, never returned); in DEMO mode the credential is a clearly
  // labeled development fixture because the offline fake transport needs
  // no real credential - the connection state is the honest one.
  const githubDefinition = registry.get(GITHUB_INTEGRATION_ID);
  const githubScopes = githubDefinition.scopes.map((scope) => scope.id);
  if (github.isDemo) {
    secrets.setSecret(
      { integrationId: GITHUB_INTEGRATION_ID, secretId: 'boot:github-demo' },
      'demo-fixture-credential-no-external-service',
    );
  } else {
    const token = process.env['GITHUB_API_TOKEN'];
    if (typeof token === 'string' && token.length > 0) {
      secrets.setSecret(
        { integrationId: GITHUB_INTEGRATION_ID, secretId: 'boot:github-demo' },
        token,
      );
    }
  }
  demoConnections[GITHUB_INTEGRATION_ID] = connections.create(githubDefinition, {
    integrationId: GITHUB_INTEGRATION_ID,
    owner,
    scopes: githubScopes,
    accountRef: github.isDemo
      ? 'veltravia-demo/fixture-repo (demo mode)'
      : 'configured via GITHUB_REPOSITORIES',
  });

  // Mocks: offline integrations; the storage mock exercises the credential
  // boundary with a labeled development credential, the database mock is
  // credential-free by design.
  const storageDefinition = registry.get(MOCK_STORAGE_ID);
  const storageConnection = connections.create(storageDefinition, {
    integrationId: MOCK_STORAGE_ID,
    owner,
    scopes: storageDefinition.scopes.map((scope) => scope.id),
    accountRef: 'offline-mock-store (development fixture)',
  });
  secrets.setSecret(
    { integrationId: MOCK_STORAGE_ID, secretId: `connection:${storageConnection.connectionId}` },
    'offline-mock-storage-dev-credential-0123456789',
  );
  demoConnections[MOCK_STORAGE_ID] = storageConnection;

  const databaseDefinition = registry.get(MOCK_DATABASE_ID);
  const databaseConnection = connections.create(databaseDefinition, {
    integrationId: MOCK_DATABASE_ID,
    owner,
    scopes: databaseDefinition.scopes.map((scope) => scope.id),
    accountRef: 'offline-mock-database (development fixture)',
  });
  demoConnections[MOCK_DATABASE_ID] = databaseConnection;

  const healthCheckers: Record<string, () => Promise<{ healthy: boolean; detail?: string }>> = {
    [GITHUB_INTEGRATION_ID]: () => github.runtime.connector.checkHealth(),
    [MOCK_STORAGE_ID]: () => mockStorageConnector(now).checkHealth(),
    [MOCK_DATABASE_ID]: () => mockDatabaseConnector(now).checkHealth(),
  };

  function registerAgentTools(tools: ToolManager): readonly string[] {
    const definitions: readonly ToolDefinition[] = [
      ...mockStorageToolDefinitions(),
      ...mockDatabaseToolDefinitions(),
    ];
    for (const definition of definitions) {
      tools.register(definition);
    }
    // Operator grants, server-side - registration grants nothing.
    for (const definition of definitions) {
      for (const permission of definition.requiredPermissions) {
        tools.grantPermission(definition.id, permission);
      }
    }
    return definitions.map((definition) => definition.id);
  }

  function connectorExecutor(): ConnectorOperationExecutor {
    return {
      // Runs ONLY after the Tool System pipeline (existence, availability,
      // input schema, permissions, connector authorization, confirmation)
      // passed. The runtime re-enforces its own boundary: connection state,
      // granted scopes, risk gate, and the secret boundary.
      executeConnectorOperation: async (tool, input) => {
        const integrationId = tool.integrationId;
        const connectionId = typeof input['connectionId'] === 'string' ? input['connectionId'] : '';
        if (integrationId === undefined || connectionId.length === 0) {
          throw new Error(
            'An integration tool invocation requires its integration and a connectionId.',
          );
        }
        const operationId = tool.connector?.operationId ?? tool.id;
        const result = await runtime.execute({
          integrationId,
          connectionId,
          owner,
          operationId,
          input,
          confirmationGated: true,
        });
        return result.output;
      },
    };
  }

  return {
    registry,
    connections,
    secrets,
    runtime,
    audit,
    owner,
    healthCheckers,
    registerAgentTools,
    connectorExecutor,
    demoConnections,
  };
}
