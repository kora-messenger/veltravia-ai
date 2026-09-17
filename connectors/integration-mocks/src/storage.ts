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
 * MOCK STORAGE - a deterministic, offline object-store integration.
 *
 * It exists to prove the multi-connector architecture: registration,
 * scoping, per-connection isolation, risk gating, and execution all work
 * identically for a second, completely different connector - with no
 * connector-specific agent code anywhere. It never contacts a network and
 * holds no credentials.
 */

export const MOCK_STORAGE_ID = 'mock-storage';

/** Scope catalog - grants start empty, always. */
export function mockStorageScopes(): readonly Permission[] {
  return [
    definePermission('storage.objects.read', 'Read objects from the mock store.', 'low'),
    definePermission('storage.objects.write', 'Write objects to the mock store.', 'medium'),
    definePermission('storage.objects.delete', 'Delete objects from the mock store.', 'high'),
  ];
}

/** The integration's catalog definition (identity card, metadata only). */
export function mockStorageDefinition(): IntegrationDefinition {
  return defineIntegration({
    id: MOCK_STORAGE_ID,
    name: 'Mock Object Storage',
    description:
      'A deterministic offline object store proving the multi-connector foundation. It talks to no external service.',
    version: '1.0.0',
    publisher: 'Veltravia',
    category: 'storage',
    iconRef: 'initial:S',
    authenticationType: 'api_key',
    capabilities: ['read', 'write', 'delete', 'manage_files'],
    scopes: mockStorageScopes(),
    tools: [
      {
        id: 'storage.object.get',
        name: 'Get Object',
        description: 'Reads one object from the offline mock store.',
        operationId: 'storage.objects.get',
        requiredScopes: ['storage.objects.read'],
        riskLevel: 'low',
        requiresConfirmation: false,
      },
      {
        id: 'storage.object.put',
        name: 'Put Object',
        description: 'Writes one object to the offline mock store.',
        operationId: 'storage.objects.put',
        requiredScopes: ['storage.objects.write'],
        riskLevel: 'medium',
        requiresConfirmation: false,
      },
      {
        id: 'storage.object.delete',
        name: 'Delete Object',
        description: 'Deletes one object from the offline mock store. Deletion is high risk.',
        operationId: 'storage.objects.delete',
        requiredScopes: ['storage.objects.delete'],
        riskLevel: 'high',
        requiresConfirmation: false,
      },
    ],
    environments: ['development'],
  });
}

/** The connector object implementing the Step 4 contract for this mock. */
export function mockStorageConnector(now: () => Date = () => new Date()): Connector {
  const started = now().toISOString();
  return {
    metadata: {
      id: MOCK_STORAGE_ID,
      name: 'Mock Object Storage',
      version: '1.0.0',
      description:
        'Deterministic offline object-storage connector. No network, no credentials, per-connection in-memory state.',
      category: 'storage',
      capabilities: ['read', 'write', 'delete', 'manage_files'],
    },
    permissions: mockStorageScopes(),
    operations: [
      defineOperation({
        id: 'storage.objects.get',
        name: 'Get Object',
        description: 'Reads one object from the mock store.',
        requiredPermissions: ['storage.objects.read'],
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
        requiresConfirmation: false,
      }),
      defineOperation({
        id: 'storage.objects.put',
        name: 'Put Object',
        description: 'Writes one object to the mock store.',
        requiredPermissions: ['storage.objects.write'],
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' }, content: { type: 'string' } },
          required: ['key', 'content'],
        },
        requiresConfirmation: false,
      }),
      defineOperation({
        id: 'storage.objects.delete',
        name: 'Delete Object',
        description: 'Deletes one object from the mock store. High risk: deletion.',
        requiredPermissions: ['storage.objects.delete'],
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
        requiresConfirmation: false,
      }),
    ],
    getStatus: () => ({ status: 'connected', since: started }),
    async checkHealth() {
      return {
        healthy: true,
        detail: 'mock store is offline and healthy',
        checkedAt: now().toISOString(),
      };
    },
    async connect() {},
    async disconnect() {},
  };
}

/** Tool definitions the wiring layer registers through the Tool System. */
export function mockStorageToolDefinitions(): readonly ToolDefinition[] {
  return [
    defineTool({
      id: 'storage.object.get',
      name: 'Get Object',
      description: 'Reads one object from the offline mock store.',
      version: '1.0.0',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, connectionId: { type: 'string' } },
        required: ['key', 'connectionId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          found: { type: 'boolean' },
          content: { type: 'string' },
        },
        required: ['key', 'found'],
      },
      requiredPermissions: ['storage.objects.read'],
      connector: { connectorId: MOCK_STORAGE_ID, operationId: 'storage.objects.get' },
      integrationId: MOCK_STORAGE_ID,
      riskLevel: 'low',
      requiresConfirmation: false,
    }),
    defineTool({
      id: 'storage.object.put',
      name: 'Put Object',
      description: 'Writes one object to the offline mock store.',
      version: '1.0.0',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          content: { type: 'string' },
          connectionId: { type: 'string' },
        },
        required: ['key', 'content', 'connectionId'],
      },
      outputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, written: { type: 'boolean' } },
        required: ['key', 'written'],
      },
      requiredPermissions: ['storage.objects.write'],
      connector: { connectorId: MOCK_STORAGE_ID, operationId: 'storage.objects.put' },
      integrationId: MOCK_STORAGE_ID,
      riskLevel: 'medium',
      requiresConfirmation: false,
    }),
    defineTool({
      id: 'storage.object.delete',
      name: 'Delete Object',
      description: 'Deletes one object from the offline mock store. Deletion is high risk.',
      version: '1.0.0',
      category: 'data',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, connectionId: { type: 'string' } },
        required: ['key', 'connectionId'],
      },
      outputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, deleted: { type: 'boolean' } },
        required: ['key', 'deleted'],
      },
      requiredPermissions: ['storage.objects.delete'],
      connector: { connectorId: MOCK_STORAGE_ID, operationId: 'storage.objects.delete' },
      integrationId: MOCK_STORAGE_ID,
      riskLevel: 'high',
      requiresConfirmation: false,
    }),
  ];
}

/**
 * The operation executor: per-connection in-memory object state. The same
 * bundle instance serves any number of connections; each connection sees
 * only its own objects (per-connection isolation is structural: state is
 * keyed by connection id).
 */
export function createMockStorageExecutor(): IntegrationOperationExecutor {
  const stores = new Map<string, Map<string, string>>();
  const storeFor = (connectionId: string): Map<string, string> => {
    let store = stores.get(connectionId);
    if (store === undefined) {
      store = new Map<string, string>();
      stores.set(connectionId, store);
    }
    return store;
  };
  return (input, context) => {
    const store = storeFor(context.connection.connectionId);
    const key = String(input['key'] ?? '');
    switch (context.operationId) {
      case 'storage.objects.put': {
        const content = String(input['content'] ?? '');
        store.set(key, content);
        return { key, written: true };
      }
      case 'storage.objects.delete': {
        const deleted = store.delete(key);
        return { key, deleted };
      }
      case 'storage.objects.get':
      default: {
        return { key, found: store.has(key), content: store.get(key) ?? '' };
      }
    }
  };
}
