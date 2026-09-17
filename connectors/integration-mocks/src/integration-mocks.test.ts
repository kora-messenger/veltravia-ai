import { describe, expect, it } from 'vitest';

import { IntegrationExecutionFailedError, type ConnectionOwner } from '@veltravia/integration-core';

import {
  createMultiConnectorSystem,
  mockDatabaseConnector,
  mockDatabaseDefinition,
  mockDatabaseToolDefinitions,
  mockStorageConnector,
  mockStorageDefinition,
  mockStorageToolDefinitions,
} from './index.js';

const OWNER: ConnectionOwner = { kind: 'user', id: 'operator' };
const OTHER: ConnectionOwner = { kind: 'user', id: 'someone-else' };

describe('mock integrations: definitions and connectors', () => {
  it('the storage definition declares its scopes and tools consistently', () => {
    const definition = mockStorageDefinition();
    expect(definition.id).toBe('mock-storage');
    expect(definition.category).toBe('storage');
    expect(definition.scopes).toHaveLength(3);
    expect(definition.tools).toHaveLength(3);
  });

  it('the database definition declares a critical-risk table-drop tool', () => {
    const definition = mockDatabaseDefinition();
    const drop = definition.tools.find((tool) => tool.id === 'database.tables.drop');
    expect(drop?.riskLevel).toBe('critical');
  });

  it('the connector contract objects mirror the integration declarations', () => {
    const storage = mockStorageConnector();
    expect(storage.metadata.id).toBe('mock-storage');
    expect(storage.operations.map((operation) => operation.id)).toEqual([
      'storage.objects.get',
      'storage.objects.put',
      'storage.objects.delete',
    ]);
    const database = mockDatabaseConnector();
    expect(database.metadata.id).toBe('mock-database');
    expect(database.permissions).toHaveLength(3);
  });

  it('tool definitions reference their connector operations', () => {
    for (const tool of mockStorageToolDefinitions()) {
      expect(tool.connector?.connectorId).toBe('mock-storage');
    }
    for (const tool of mockDatabaseToolDefinitions()) {
      expect(tool.connector?.connectorId).toBe('mock-database');
    }
    // High-risk tool flags can only RAISE the bar; the framework computes
    // the effective requirement.
    const drop = mockDatabaseToolDefinitions().find((tool) => tool.id === 'database.tables.drop');
    expect(drop?.riskLevel).toBe('critical');
  });
});

describe('multi-connector system', () => {
  it('two different integrations coexist on one shared pipeline', async () => {
    const system = createMultiConnectorSystem();
    const { storage, database } = system.connectOwner(OWNER);
    expect(system.registry.ids()).toEqual(['mock-storage', 'mock-database']);

    const stored = await system.runtime.execute({
      integrationId: 'mock-storage',
      connectionId: storage.connectionId,
      owner: OWNER,
      operationId: 'storage.objects.put',
      input: { key: 'notes.txt', content: 'hello' },
    });
    expect(stored.output).toEqual({ key: 'notes.txt', written: true });

    const inserted = await system.runtime.execute({
      integrationId: 'mock-database',
      connectionId: database.connectionId,
      owner: OWNER,
      operationId: 'database.rows.insert',
      input: { table: 'users', values: { name: 'ada' } },
    });
    expect(inserted.output).toEqual({ table: 'users', inserted: true });

    const selected = await system.runtime.execute({
      integrationId: 'mock-database',
      connectionId: database.connectionId,
      owner: OWNER,
      operationId: 'database.rows.select',
      input: { table: 'users' },
    });
    expect(selected.output).toEqual({ table: 'users', rows: [{ name: 'ada' }] });
  });

  it('executions are deterministic (same input, same output)', async () => {
    const first = createMultiConnectorSystem();
    const second = createMultiConnectorSystem();
    const a = first.connectOwner(OWNER);
    const b = second.connectOwner(OWNER);
    const run = (
      system: ReturnType<typeof createMultiConnectorSystem>,
      connection: { connectionId: string },
    ) =>
      system.runtime.execute({
        integrationId: 'mock-database',
        connectionId: connection.connectionId,
        owner: OWNER,
        operationId: 'database.rows.select',
        input: { table: 'empty' },
      });
    expect((await run(first, a.database)).output).toEqual((await run(second, b.database)).output);
  });

  it("state is isolated per connection - owners never see each other's data", async () => {
    const system = createMultiConnectorSystem();
    const mine = system.connectOwner(OWNER);
    const theirs = system.connectOwner(OTHER);
    await system.runtime.execute({
      integrationId: 'mock-storage',
      connectionId: mine.storage.connectionId,
      owner: OWNER,
      operationId: 'storage.objects.put',
      input: { key: 'secret-notes', content: 'only-mine' },
    });
    const theirView = await system.runtime.execute({
      integrationId: 'mock-storage',
      connectionId: theirs.storage.connectionId,
      owner: OTHER,
      operationId: 'storage.objects.get',
      input: { key: 'secret-notes' },
    });
    expect(theirView.output).toEqual({ key: 'secret-notes', found: false, content: '' });
  });

  it('the critical-risk table drop refuses to run ungated', async () => {
    const system = createMultiConnectorSystem();
    const { database } = system.connectOwner(OWNER);
    await expect(
      system.runtime.execute({
        integrationId: 'mock-database',
        connectionId: database.connectionId,
        owner: OWNER,
        operationId: 'database.tables.drop',
        input: { table: 'users' },
      }),
    ).rejects.toThrow(IntegrationExecutionFailedError);
  });

  it('a missing scope fails closed even on the same connection', async () => {
    const system = createMultiConnectorSystem();
    const connection = system.connections.create(mockDatabaseDefinition(), {
      integrationId: 'mock-database',
      owner: OWNER,
      scopes: ['database.rows.read'],
    });
    await expect(
      system.runtime.execute({
        integrationId: 'mock-database',
        connectionId: connection.connectionId,
        owner: OWNER,
        operationId: 'database.rows.insert',
        input: { table: 'users', values: { name: 'ada' } },
      }),
    ).rejects.toThrow(/missing granted scope/i);
  });

  it('audit events cover both integrations without secret material', async () => {
    const system = createMultiConnectorSystem();
    const { storage, database } = system.connectOwner(OWNER);
    await system.runtime.execute({
      integrationId: 'mock-storage',
      connectionId: storage.connectionId,
      owner: OWNER,
      operationId: 'storage.objects.put',
      input: { key: 'k', content: 'v' },
    });
    await system.runtime.execute({
      integrationId: 'mock-database',
      connectionId: database.connectionId,
      owner: OWNER,
      operationId: 'database.rows.select',
      input: { table: 'users' },
    });
    const executed = system.audit.filter((event) => event.type === 'integration.tool_executed');
    expect(executed.map((event) => event.integrationId).sort()).toEqual([
      'mock-database',
      'mock-storage',
    ]);
    expect(JSON.stringify(system.audit)).not.toMatch(/dev-mock-storage-credential/);
  });
});
