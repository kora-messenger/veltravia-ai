import type {
  Connector,
  ConnectorHealth,
  ConnectorMetadata,
  ConnectorOperation,
  ConnectorStatusInfo,
  CredentialReference,
  Permission,
} from '@veltravia/connector-core';
import { defineOperation, definePermission } from '@veltravia/connector-core';

/**
 * A deterministic, offline, credential-free mock connector.
 *
 * It exists ONLY to prove the connector framework works: registration,
 * validation, permissions, operations, lifecycle, and health reporting.
 * It simulates NO external service (not GitHub, not a database) - it is a
 * plain object with pure behavior, safe for CI and fully deterministic.
 */

/** Injectable clock for deterministic timestamps. */
export interface MockConnectorOptions {
  readonly now?: () => Date;
}

export class MockConnector implements Connector {
  readonly metadata: ConnectorMetadata = {
    id: 'mock',
    name: 'Mock Connector',
    version: '1.0.0',
    description:
      'A deterministic, offline mock connector used to test the connector framework. It talks to no external service.',
    category: 'other',
    capabilities: ['read', 'write', 'search'],
  };

  readonly permissions: readonly Permission[] = [
    definePermission('resources.read', 'Read mock resources.', 'low'),
    definePermission('resources.write', 'Write mock resources.', 'medium'),
    definePermission('resources.search', 'Search mock resources.', 'low'),
    definePermission('resources.admin', 'Administrative access to mock resources.', 'critical'),
  ];

  readonly operations: readonly ConnectorOperation[] = [
    defineOperation({
      id: 'mock.read',
      name: 'Read Resource',
      description: 'Reads one deterministic mock resource.',
      requiredPermissions: ['resources.read'],
      inputSchema: {
        type: 'object',
        properties: { resourceId: { type: 'string' } },
        required: ['resourceId'],
      },
      requiresConfirmation: false,
    }),
    defineOperation({
      id: 'mock.write',
      name: 'Write Resource',
      description: 'Writes one deterministic mock resource.',
      requiredPermissions: ['resources.write'],
      requiresConfirmation: true,
    }),
    defineOperation({
      id: 'mock.search',
      name: 'Search Resources',
      description: 'Searches deterministic mock resources.',
      requiredPermissions: ['resources.search'],
      requiresConfirmation: false,
    }),
    defineOperation({
      id: 'mock.administer',
      name: 'Administer Resources',
      description: 'Performs a critical-risk administrative action.',
      requiredPermissions: ['resources.admin'],
      requiresConfirmation: false,
    }),
  ];

  private status: ConnectorStatusInfo = {
    status: 'registered',
    since: new Date(0).toISOString(),
  };
  private readonly now: () => Date;

  constructor(options: MockConnectorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.status = { status: 'registered', since: this.now().toISOString() };
  }

  getStatus(): ConnectorStatusInfo {
    return this.status;
  }

  async checkHealth(): Promise<ConnectorHealth> {
    return {
      healthy: true,
      detail: 'mock connector is healthy',
      checkedAt: this.now().toISOString(),
    };
  }

  async connect(): Promise<void> {
    this.status = { status: 'connected', since: this.now().toISOString() };
  }

  async disconnect(): Promise<void> {
    this.status = { status: 'disconnected', since: this.now().toISOString() };
  }

  /** Test affordance: set the connector's own reported status. */
  setStatusForTesting(status: ConnectorStatusInfo): void {
    this.status = status;
  }

  /** Test affordance: a metadata-only credential reference, never a secret. */
  withCredentialForTesting(credential: CredentialReference): MockConnector {
    (this as { credential?: CredentialReference }).credential = credential;
    return this;
  }
}

export function createMockConnector(options: MockConnectorOptions = {}): MockConnector {
  return new MockConnector(options);
}
