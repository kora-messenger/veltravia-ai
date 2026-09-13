import { describe, expect, it } from 'vitest';
import { InvalidConnectorError } from '../errors/index.js';
import type { Connector } from '../types/connector.js';
import { ConnectorRegistry } from './index.js';
import { createMockConnector } from '@veltravia/connector-mock';

function stubConnector(overrides: Partial<Connector['metadata']> = {}): Connector {
  return {
    metadata: {
      id: 'stub-connector',
      name: 'Stub Connector',
      version: '1.0.0',
      description: 'A structurally valid stub connector.',
      category: 'other',
      capabilities: ['read'],
      ...overrides,
    },
    permissions: [{ id: 'data.read', description: 'Read data.', riskLevel: 'low' }],
    operations: [
      {
        id: 'stub.read',
        name: 'Read',
        description: 'Reads data.',
        requiredPermissions: ['data.read'],
        requiresConfirmation: false,
      },
    ],
    getStatus: () => ({ status: 'registered', since: '2026-01-01T00:00:00.000Z' }),
    checkHealth: async () => ({ healthy: true, checkedAt: '2026-01-01T00:00:00.000Z' }),
    connect: async () => undefined,
    disconnect: async () => undefined,
  };
}

describe('ConnectorRegistry', () => {
  it('registers and retrieves a connector by id', () => {
    const registry = new ConnectorRegistry();
    const connector = stubConnector();
    registry.register(connector);
    expect(registry.has('stub-connector')).toBe(true);
    expect(registry.get('stub-connector')).toBe(connector);
    expect(registry.size).toBe(1);
  });

  it('rejects duplicate connector ids', () => {
    const registry = new ConnectorRegistry();
    registry.register(stubConnector());
    expect(() => registry.register(stubConnector())).toThrowError(/already registered/);
  });

  it('lists connectors in registration order', () => {
    const registry = new ConnectorRegistry();
    registry.register(stubConnector());
    registry.register(stubConnector({ id: 'second-one', name: 'Second' }));
    expect(registry.ids()).toEqual(['stub-connector', 'second-one']);
    expect(registry.list().map((connector) => connector.metadata.name)).toEqual([
      'Stub Connector',
      'Second',
    ]);
  });

  it('unregisters a connector and frees the id', () => {
    const registry = new ConnectorRegistry();
    registry.register(stubConnector());
    registry.unregister('stub-connector');
    expect(registry.has('stub-connector')).toBe(false);
    expect(() => registry.get('stub-connector')).toThrowError(/No connector registered/);
    // The id is free again.
    expect(() => registry.register(stubConnector())).not.toThrow();
  });

  it('throws when unregistering or getting an unknown id', () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.get('missing')).toThrowError(/No connector registered/);
    expect(() => registry.unregister('missing')).toThrowError(/No connector registered/);
  });

  it('rejects structurally invalid connectors with all reasons', () => {
    const registry = new ConnectorRegistry();
    const bad = stubConnector({ id: 'Bad_ID', version: 'one', category: 'webmail' as never });
    let error: unknown;
    try {
      registry.register(bad);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InvalidConnectorError);
    const message = (error as InvalidConnectorError).message;
    expect(message).toContain('kebab-case');
    expect(message).toContain('semver');
    expect(message).toContain('category');
    // Atomic: nothing was registered.
    expect(registry.size).toBe(0);
  });

  it('rejects operations requiring undeclared permissions', () => {
    const registry = new ConnectorRegistry();
    const sneaky = {
      ...stubConnector(),
      operations: [
        {
          id: 'stub.read',
          name: 'Read',
          description: 'Reads data.',
          requiredPermissions: ['not.declared'],
          requiresConfirmation: false,
        },
      ],
    };
    try {
      registry.register(sneaky);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as Error).message).toContain('undeclared permission "not.declared"');
    }
  });

  it('rejects raw-looking secret material in credential references', () => {
    const registry = new ConnectorRegistry();
    const leaky = {
      ...stubConnector(),
      credential: {
        credentialId: 'ghp_abcdefabcdefabcdefabcdefabcdef',
        credentialType: 'api_key',
        providerRef: 'vault:kv/veltravia/test',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    expect(() => registry.register(leaky as never)).toThrowError(/secret-like material/);
  });

  it('accepts the real mock connector package', () => {
    const registry = new ConnectorRegistry();
    registry.register(createMockConnector());
    expect(registry.get('mock').metadata.name).toBe('Mock Connector');
  });
});
