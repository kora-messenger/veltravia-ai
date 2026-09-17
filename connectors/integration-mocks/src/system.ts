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
  MOCK_DATABASE_ID,
  createMockDatabaseExecutor,
  mockDatabaseDefinition,
} from './database.js';
import { MOCK_STORAGE_ID, createMockStorageExecutor, mockStorageDefinition } from './storage.js';

/**
 * Assembles the two mock integrations into one running multi-connector
 * system - the reuse seam for tests and the demo API wiring.
 *
 * The system proves architectural coexistence: two different categories,
 * two different scope catalogs, two different risk profiles, one shared
 * pipeline (registry -> connection manager -> secret boundary ->
 * runtime). Nothing in the pipeline knows which integration it serves.
 */
export interface MultiConnectorSystem {
  readonly registry: IntegrationRegistry;
  readonly connections: ConnectionManager;
  readonly secrets: InMemorySecretStore;
  readonly runtime: IntegrationRuntime;
  readonly audit: readonly IntegrationAuditEvent[];
  /** Creates demo connections for one owner and returns them. */
  connectOwner(owner: ConnectionOwner): {
    readonly storage: Connection;
    readonly database: Connection;
  };
}

export function createMultiConnectorSystem(
  options: {
    readonly now?: () => Date;
    readonly onAudit?: (event: IntegrationAuditEvent) => void;
  } = {},
): MultiConnectorSystem {
  const now = options.now ?? (() => new Date());
  const audit: IntegrationAuditEvent[] = [];
  const sink = (event: IntegrationAuditEvent): void => {
    audit.push(event);
    options.onAudit?.(event);
  };

  const registry = new IntegrationRegistry({ onAudit: sink });
  registry.register(mockStorageDefinition());
  registry.register(mockDatabaseDefinition());

  const connections = new ConnectionManager({ now, onAudit: sink });
  const secrets = new InMemorySecretStore();
  const runtime = new IntegrationRuntime({
    registry,
    connections,
    secrets,
    executors: {
      [MOCK_STORAGE_ID]: createMockStorageExecutor(),
      [MOCK_DATABASE_ID]: createMockDatabaseExecutor(),
    },
    now,
    onAudit: sink,
  });

  return {
    registry,
    connections,
    secrets,
    runtime,
    audit,
    connectOwner(owner: ConnectionOwner) {
      const storage = connections.create(mockStorageDefinition(), {
        integrationId: MOCK_STORAGE_ID,
        owner,
        scopes: ['storage.objects.read', 'storage.objects.write', 'storage.objects.delete'],
        accountRef: 'demo-storage-account',
      });
      const database = connections.create(mockDatabaseDefinition(), {
        integrationId: MOCK_DATABASE_ID,
        owner,
        scopes: ['database.rows.read', 'database.rows.write', 'database.tables.manage'],
        accountRef: 'demo-database',
      });
      // Development-only credentials for the credential-bearing mock so the
      // secret boundary is exercised end to end (storage only - the
      // database mock is credential-free by design).
      secrets.setSecret(
        { integrationId: MOCK_STORAGE_ID, secretId: `connection:${storage.connectionId}` },
        'dev-mock-storage-credential-0123456789',
      );
      return { storage, database };
    },
  };
}
