import { describe, expect, it } from 'vitest';
import type { ConnectorAuditEvent } from '../audit/index.js';
import { createCredentialReference } from '../credentials/index.js';
import {
  ConnectorNotFoundError,
  ConnectorOperationError,
  ConnectorPermissionError,
  isConnectorError,
} from '../errors/index.js';
import { ConnectorManager } from './index.js';
import { createMockConnector } from '@veltravia/connector-mock';

const NOW = () => new Date('2026-09-13T12:00:00.000Z');

function buildManager() {
  const events: ConnectorAuditEvent[] = [];
  const manager = new ConnectorManager({ now: NOW, onAudit: (event) => events.push(event) });
  return { manager, events };
}

describe('ConnectorManager', () => {
  it('registers a connector with an EMPTY granted-permission set', () => {
    const { manager, events } = buildManager();
    manager.register(createMockConnector());
    expect(manager.has('mock')).toBe(true);
    expect(manager.getGrantedPermissions('mock')).toEqual([]);
    expect(manager.getCapabilities('mock')).toEqual(['read', 'write', 'search']);
    expect(manager.getStatus('mock').status).toBe('registered');
    expect(events.map((event) => event.type)).toEqual(['connector_registered']);
  });

  it('get/list/unregister behave', () => {
    const { manager } = buildManager();
    manager.register(createMockConnector());
    expect(manager.list().map((connector) => connector.metadata.id)).toEqual(['mock']);
    expect(manager.get('mock').metadata.version).toBe('1.0.0');
    manager.unregister('mock');
    expect(() => manager.get('mock')).toThrowError(ConnectorNotFoundError);
  });

  it('lifecycle: configure -> connect -> disconnect, with deterministic timestamps', async () => {
    const { manager, events } = buildManager();
    manager.register(createMockConnector());
    manager.configure('mock');
    expect(manager.getStatus('mock')).toEqual({
      status: 'configured',
      since: '2026-09-13T12:00:00.000Z',
    });
    await manager.connect('mock');
    expect(manager.getStatus('mock').status).toBe('connected');
    await manager.disconnect('mock');
    expect(manager.getStatus('mock').status).toBe('disconnected');
    expect(events.map((event) => event.type)).toEqual([
      'connector_registered',
      'connector_configured',
      'connector_connected',
      'connector_disconnected',
    ]);
  });

  it('disable blocks connect and marks the lifecycle', async () => {
    const { manager } = buildManager();
    manager.register(createMockConnector());
    manager.disable('mock');
    await expect(manager.connect('mock')).rejects.toThrowError(/disabled/);
    expect(manager.getStatus('mock')).toMatchObject({ status: 'disabled' });
  });

  it('surfaces connector health checks', async () => {
    const { manager } = buildManager();
    manager.register(createMockConnector());
    const health = await manager.checkHealth('mock');
    expect(health.healthy).toBe(true);
    expect(health.detail).toBe('mock connector is healthy');
  });

  it('grants and revokes only DECLARED permissions', () => {
    const { manager, events } = buildManager();
    manager.register(createMockConnector());
    manager.grantPermission('mock', 'resources.read');
    expect(manager.hasPermission('mock', 'resources.read')).toBe(true);
    expect(() => manager.grantPermission('mock', 'not.declared')).toThrowError(
      ConnectorPermissionError,
    );
    expect(() => manager.grantPermission('mock', 'resources.write')).not.toThrow();
    manager.revokePermission('mock', 'resources.write');
    expect(manager.hasPermission('mock', 'resources.write')).toBe(false);
    expect(events.filter((event) => event.type === 'permission_granted').length).toBe(2);
    expect(events.filter((event) => event.type === 'permission_revoked').length).toBe(1);
  });

  it('assertPermission denies ungranted permissions and audits the denial', () => {
    const { manager, events } = buildManager();
    manager.register(createMockConnector());
    expect(() => manager.assertPermission('mock', 'resources.read')).toThrowError(/not granted/);
    expect(events.some((event) => event.type === 'permission_denied')).toBe(true);
    manager.grantPermission('mock', 'resources.read');
    expect(() => manager.assertPermission('mock', 'resources.read')).not.toThrow();
  });

  it('authorizeOperation: blocks ungranted operations and lists missing permissions', () => {
    const { manager, events } = buildManager();
    manager.register(createMockConnector());
    const decision = manager.authorizeOperation('mock', 'mock.read');
    expect(decision.authorized).toBe(false);
    expect(decision.missingPermissions).toEqual(['resources.read']);
    expect(decision.requiresConfirmation).toBe(false);
    expect(events.map((event) => event.type)).toContain('operation_requested');
    expect(events.map((event) => event.type)).toContain('operation_rejected');
  });

  it('authorizeOperation: authorizes once permissions are granted', () => {
    const { manager } = buildManager();
    manager.register(createMockConnector());
    manager.grantPermission('mock', 'resources.read');
    const decision = manager.authorizeOperation('mock', 'mock.read');
    expect(decision.authorized).toBe(true);
    expect(decision.missingPermissions).toEqual([]);
  });

  it('authorizeOperation: forces confirmation for high/critical-risk operations', () => {
    const { manager } = buildManager();
    manager.register(createMockConnector());
    manager.grantPermission('mock', 'resources.admin');
    // Declared requiresConfirmation is false, but the permission is critical.
    const decision = manager.authorizeOperation('mock', 'mock.administer');
    expect(decision.authorized).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it('authorizeOperation rejects unknown operations with a typed error', () => {
    const { manager } = buildManager();
    manager.register(createMockConnector());
    try {
      manager.authorizeOperation('mock', 'mock.fly-to-the-moon');
      expect.unreachable('must throw');
    } catch (error) {
      expect(isConnectorError(error)).toBe(true);
      expect(error).toBeInstanceOf(ConnectorOperationError);
      expect((error as ConnectorOperationError).details).toMatchObject({
        operationId: 'mock.fly-to-the-moon',
      });
    }
  });

  it('inspect returns a full read-only snapshot without secrets', () => {
    const { manager } = buildManager();
    manager.register(createMockConnector());
    manager.configure(
      'mock',
      createCredentialReference({
        credentialId: 'cred_0001',
        credentialType: 'api_key',
        providerRef: 'env:MOCK_CONNECTOR_KEY',
        createdAt: '2026-09-13T12:00:00.000Z',
      }),
    );
    const inspection = manager.inspect('mock');
    expect(inspection.metadata.id).toBe('mock');
    expect(inspection.capabilities.length).toBe(3);
    expect(inspection.permissions.length).toBe(4);
    expect(inspection.grantedPermissions).toEqual([]);
    expect(inspection.operations.length).toBe(4);
    expect(inspection.status.status).toBe('configured');
    // The credential appears only as a metadata-only reference.
    expect(inspection.credential).toBeDefined();
    expect(JSON.stringify(inspection)).not.toMatch(/AIza|ghp_|sk-|Bearer\s/);
  });

  it('connect failure marks the connector as error and throws a typed error', async () => {
    const { manager } = buildManager();
    const base = createMockConnector();
    const failing: Parameters<ConnectorManager['register']>[0] = {
      metadata: { ...base.metadata, id: 'failing-mock', name: 'Failing Mock' },
      permissions: base.permissions,
      operations: base.operations,
      getStatus: () => base.getStatus(),
      checkHealth: () => base.checkHealth(),
      connect: async () => {
        throw new Error('network unreachable');
      },
      disconnect: () => base.disconnect(),
    };
    manager.register(failing);
    await expect(manager.connect('failing-mock')).rejects.toThrowError(/network unreachable/);
    expect(manager.getStatus('failing-mock')).toMatchObject({
      status: 'error',
      detail: 'connect failed',
    });
  });
});
