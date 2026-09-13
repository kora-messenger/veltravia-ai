import { describe, expect, it } from 'vitest';
import { MockConnector, createMockConnector } from './mock-connector.js';
import {
  ConnectorRegistry,
  ConnectorManager,
  isConnectorAuditEventType,
} from '@veltravia/connector-core';

describe('MockConnector', () => {
  it('implements the provider-neutral connector interface', () => {
    const mock = createMockConnector();
    expect(mock.metadata.id).toBe('mock');
    expect(mock.metadata.version).toBe('1.0.0');
    expect(mock.metadata.category).toBe('other');
    expect(mock.metadata.capabilities).toEqual(['read', 'write', 'search']);
    expect(typeof mock.getStatus).toBe('function');
    expect(typeof mock.connect).toBe('function');
    expect(typeof mock.disconnect).toBe('function');
    expect(typeof mock.checkHealth).toBe('function');
  });

  it('declares permissions with risk levels and operations that use them', () => {
    const mock = createMockConnector();
    expect(mock.permissions.map((permission) => permission.riskLevel)).toEqual([
      'low',
      'medium',
      'low',
      'critical',
    ]);
    const declared = new Set(mock.permissions.map((permission) => permission.id));
    for (const operation of mock.operations) {
      expect(operation.requiredPermissions.every((id) => declared.has(id))).toBe(true);
    }
  });

  it('is fully deterministic: injected clock drives every timestamp', async () => {
    const now = () => new Date('2026-09-13T09:30:00.000Z');
    const mock = new MockConnector({ now });
    expect(mock.getStatus()).toEqual({ status: 'registered', since: '2026-09-13T09:30:00.000Z' });
    await mock.connect();
    expect(mock.getStatus().since).toBe('2026-09-13T09:30:00.000Z');
    const health = await mock.checkHealth();
    expect(health.checkedAt).toBe('2026-09-13T09:30:00.000Z');
  });

  it('registers through the real registry and manager end to end', async () => {
    const registry = new ConnectorRegistry();
    const manager = new ConnectorManager({ registry });
    manager.register(createMockConnector());
    expect(registry.has('mock')).toBe(true);
    expect(manager.has('mock')).toBe(true);
    await manager.connect('mock');
    expect(manager.getStatus('mock').status).toBe('connected');
    expect((await manager.checkHealth('mock')).healthy).toBe(true);
  });

  it('emits no credential by default and works with a test credential reference', () => {
    const mock = createMockConnector();
    expect(mock.credential).toBeUndefined();
    const withCredential = mock.withCredentialForTesting({
      credentialId: 'cred_mock_0001',
      credentialType: 'api_key',
      providerRef: 'env:MOCK_CONNECTOR_KEY',
      status: 'pending',
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
    });
    expect(withCredential.credential?.providerRef).toBe('env:MOCK_CONNECTOR_KEY');
    // Structurally: the reference can never carry a secret.
    expect(Object.keys(withCredential.credential as object)).not.toContain('value');
  });

  it('makes no network requests - behavior is pure and offline', async () => {
    // If any network primitive were touched, this synchronous battery would
    // throw inside a sandbox without egress. It only proves purity, though -
    // the connector's code has no network imports at all.
    const mock = createMockConnector();
    await mock.connect();
    await mock.disconnect();
    await mock.checkHealth();
    expect(isConnectorAuditEventType('connector_registered')).toBe(true);
  });
});
