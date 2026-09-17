import {
  defineOperation,
  definePermission,
  type Connector,
  type Permission,
} from '@veltravia/connector-core';
import {
  defineIntegration,
  type IntegrationDefinition,
  type IntegrationOperationExecutor,
} from '@veltravia/integration-core';
import { defineTool, type ToolDefinition } from '@veltravia/tool-core';

/**
 * MOCK DATABASE - a deterministic, offline relational-store integration.
 *
 * The third connector proving multi-connector coexistence: different
 * category, different scopes, a CRITICAL-risk operation (table drop) that
 * the framework must force through human confirmation regardless of what
 * any declaration says. It never contacts a network and holds no
 * credentials.
 */

export const MOCK_DATABASE_ID = 'mock-database';

export function mockDatabaseScopes(): readonly Permission[] {
  return [
    definePermission('database.rows.read', 'Read rows from the mock database.', 'low'),
    definePermission('database.rows.write', 'Insert rows into the mock database.', 'medium'),
    definePermission('database.tables.manage', 'Drop tables in the mock database.', 'critical'),
  ];
}

export function mockDatabaseDefinition(): IntegrationDefinition {
  return defineIntegration({
    id: MOCK_DATABASE_ID,
    name: 'Mock Database',
    description:
      'A deterministic offline row store proving critical-risk gating in the multi-connector foundation. It talks to no external service.',
    version: '1.0.0',
    publisher: 'Veltravia',
    category: 'databases',
    iconRef: 'initial:D',
    authenticationType: 'none',
    capabilities: ['read', 'write', 'delete'],
    scopes: mockDatabaseScopes(),
    tools: [
      {
        id: 'database.rows.select',
        name: 'Select Rows',
        description: 'Reads rows from one table in the offline mock database.',
        operationId: 'database.rows.select',
        requiredScopes: ['database.rows.read'],
        riskLevel: 'low',
        requiresConfirmation: false,
      },
      {
        id: 'database.rows.insert',
        name: 'Insert Row',
        description: 'Inserts one row into a table in the offline mock database.',
        operationId: 'database.rows.insert',
        requiredScopes: ['database.rows.write'],
        riskLevel: 'medium',
        requiresConfirmation: false,
      },
      {
        id: 'database.tables.drop',
        name: 'Drop Table',
        description: 'Drops one table from the offline mock database. Critical risk.',
        operationId: 'database.tables.drop',
        requiredScopes: ['database.tables.manage'],
        riskLevel: 'critical',
        requiresConfirmation: false,
      },
    ],
    environments: ['development'],
  });
}

export function mockDatabaseConnector(now: () => Date = () => new Date()): Connector {
  const started = now().toISOString();
  return {
    metadata: {
      id: MOCK_DATABASE_ID,
      name: 'Mock Database',
      version: '1.0.0',
      description:
        'Deterministic offline database connector. No network, no credentials, per-connection in-memory state.',
      category: 'database',
      capabilities: ['read', 'write', 'delete'],
    },
    permissions: mockDatabaseScopes(),
    operations: [
      defineOperation({
        id: 'database.rows.select',
        name: 'Select Rows',
        description: 'Reads rows from one table.',
        requiredPermissions: ['database.rows.read'],
        inputSchema: {
          type: 'object',
          properties: { table: { type: 'string' }, limit: { type: 'number' } },
          required: ['table'],
        },
        requiresConfirmation: false,
      }),
      defineOperation({
        id: 'database.rows.insert',
        name: 'Insert Row',
        description: 'Inserts one row into a table.',
        requiredPermissions: ['database.rows.write'],
        inputSchema: {
          type: 'object',
          properties: { table: { type: 'string' }, values: { type: 'object', properties: {} } },
          required: ['table', 'values'],
        },
        requiresConfirmation: false,
      }),
      defineOperation({
        id: 'database.tables.drop',
        name: 'Drop Table',
        description: 'Drops one table. Critical risk: production data destruction.',
        requiredPermissions: ['database.tables.manage'],
        inputSchema: {
          type: 'object',
          properties: { table: { type: 'string' } },
          required: ['table'],
        },
        requiresConfirmation: false,
      }),
    ],
    getStatus: () => ({ status: 'connected', since: started }),
    async checkHealth() {
      return {
        healthy: true,
        detail: 'mock database is offline and healthy',
        checkedAt: now().toISOString(),
      };
    },
    async connect() {},
    async disconnect() {},
  };
}

export function mockDatabaseToolDefinitions(): readonly ToolDefinition[] {
  return [
    defineTool({
      id: 'database.rows.select',
      name: 'Select Rows',
      description: 'Reads rows from one table in the offline mock database.',
      version: '1.0.0',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { table: { type: 'string' }, connectionId: { type: 'string' } },
        required: ['table', 'connectionId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          rows: { type: 'array', items: { type: 'object', properties: {} } },
        },
        required: ['table', 'rows'],
      },
      requiredPermissions: ['database.rows.read'],
      connector: { connectorId: MOCK_DATABASE_ID, operationId: 'database.rows.select' },
      integrationId: MOCK_DATABASE_ID,
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    defineTool({
      id: 'database.rows.insert',
      name: 'Insert Row',
      description: 'Inserts one row into a table in the offline mock database.',
      version: '1.0.0',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          values: { type: 'object', properties: {} },
          connectionId: { type: 'string' },
        },
        required: ['table', 'values', 'connectionId'],
      },
      outputSchema: {
        type: 'object',
        properties: { table: { type: 'string' }, inserted: { type: 'boolean' } },
        required: ['table', 'inserted'],
      },
      requiredPermissions: ['database.rows.write'],
      connector: { connectorId: MOCK_DATABASE_ID, operationId: 'database.rows.insert' },
      integrationId: MOCK_DATABASE_ID,
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    defineTool({
      id: 'database.tables.drop',
      name: 'Drop Table',
      description:
        'Drops one table from the offline mock database. Critical risk: the framework always demands human confirmation.',
      version: '1.0.0',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { table: { type: 'string' }, connectionId: { type: 'string' } },
        required: ['table', 'connectionId'],
      },
      outputSchema: {
        type: 'object',
        properties: { table: { type: 'string' }, dropped: { type: 'boolean' } },
        required: ['table', 'dropped'],
      },
      requiredPermissions: ['database.tables.manage'],
      connector: { connectorId: MOCK_DATABASE_ID, operationId: 'database.tables.drop' },
      integrationId: MOCK_DATABASE_ID,
      riskLevel: 'critical',
      requiresConfirmation: false,
    }),
  ];
}

/** Per-connection in-memory table state - deterministic, offline. */
export function createMockDatabaseExecutor(): IntegrationOperationExecutor {
  const databases = new Map<string, Map<string, Record<string, unknown>[]>>();
  const tablesFor = (connectionId: string): Map<string, Record<string, unknown>[]> => {
    let tables = databases.get(connectionId);
    if (tables === undefined) {
      tables = new Map<string, Record<string, unknown>[]>();
      databases.set(connectionId, tables);
    }
    return tables;
  };
  return (input, context) => {
    const tables = tablesFor(context.connection.connectionId);
    const table = String(input['table'] ?? '');
    const rows = tables.get(table);
    switch (context.operationId) {
      case 'database.rows.insert': {
        const values = (input['values'] ?? {}) as Record<string, unknown>;
        const next = [...(rows ?? []), values];
        tables.set(table, next);
        return { table, inserted: true };
      }
      case 'database.tables.drop': {
        const dropped = tables.delete(table);
        return { table, dropped };
      }
      case 'database.rows.select':
      default: {
        const limit = typeof input['limit'] === 'number' ? input['limit'] : undefined;
        const all = rows ?? [];
        return { table, rows: limit === undefined ? [...all] : all.slice(0, limit) };
      }
    }
  };
}
