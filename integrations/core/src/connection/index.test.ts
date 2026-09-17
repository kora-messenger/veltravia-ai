import { describe, expect, it } from 'vitest';

import {
  ConnectionLimitReachedError,
  ConnectionNotFoundError,
  IntegrationConfigurationInvalidError,
} from '../errors/index.js';
import { InMemorySecretStore } from '../secrets/index.js';
import {
  assertCredentialAvailable,
  ConnectionManager,
  isSameOwner,
  type ConnectionOwner,
} from './index.js';
import { validIntegrationDefinition as validDefinition } from '../testing/index.js';
import type { IntegrationDefinition } from './types/integration.js';

const USER_A: ConnectionOwner = { kind: 'user', id: 'user-a' };
const USER_B: ConnectionOwner = { kind: 'user', id: 'user-b' };
const PROJECT_1: ConnectionOwner = { kind: 'project', id: 'prj-1' };
const PROJECT_2: ConnectionOwner = { kind: 'project', id: 'prj-2' };

function clock(startMs: number): () => Date {
  let current = startMs;
  return () => {
    current += 1000;
    return new Date(current);
  };
}

function managerWithConnection(definition: IntegrationDefinition = validDefinition()) {
  const events: unknown[] = [];
  const manager = new ConnectionManager({
    now: clock(0),
    onAudit: (event) => events.push(event),
  });
  const connection = manager.create(definition, {
    integrationId: definition.id,
    owner: USER_A,
    scopes: ['storage.objects.read', 'storage.objects.write'],
    accountRef: 'demo-account',
  });
  return { manager, connection, events, definition };
}

describe('ConnectionManager', () => {
  it('creates a connection granting exactly the requested scopes', () => {
    const { connection } = managerWithConnection();
    expect(connection.integrationId).toBe('demo-store');
    expect(connection.grantedScopes).toEqual(['storage.objects.read', 'storage.objects.write']);
    expect(connection.status).toBe('connected');
    expect(connection.accountRef).toBe('demo-account');
    expect(connection.operationCount).toBe(0);
  });

  it('deduplicates requested scopes', () => {
    const { manager, definition } = managerWithConnection();
    const connection = manager.create(definition, {
      integrationId: definition.id,
      owner: USER_A,
      scopes: ['storage.objects.read', 'storage.objects.read'],
    });
    expect(connection.grantedScopes).toEqual(['storage.objects.read']);
  });

  it('rejects undeclared scopes', () => {
    const { manager, definition } = managerWithConnection();
    expect(() =>
      manager.create(definition, {
        integrationId: definition.id,
        owner: USER_A,
        scopes: ['storage.admin.purge'],
      }),
    ).toThrow(IntegrationConfigurationInvalidError);
  });

  it('rejects an empty scope request', () => {
    const { manager, definition } = managerWithConnection();
    expect(() =>
      manager.create(definition, { integrationId: definition.id, owner: USER_A, scopes: [] }),
    ).toThrow(IntegrationConfigurationInvalidError);
  });

  it('enforces the per-owner-per-integration connection limit', () => {
    const events: unknown[] = [];
    const manager = new ConnectionManager({
      now: clock(0),
      limits: { maxConnectionsPerOwnerIntegration: 2 },
      onAudit: (event) => events.push(event),
    });
    const definition = validDefinition();
    for (let index = 0; index < 2; index += 1) {
      manager.create(definition, {
        integrationId: definition.id,
        owner: USER_A,
        scopes: ['storage.objects.read'],
      });
    }
    expect(() =>
      manager.create(definition, {
        integrationId: definition.id,
        owner: USER_A,
        scopes: ['storage.objects.read'],
      }),
    ).toThrow(ConnectionLimitReachedError);
    // A different owner still has budget: ownership is the boundary.
    expect(() =>
      manager.create(definition, {
        integrationId: definition.id,
        owner: USER_B,
        scopes: ['storage.objects.read'],
      }),
    ).not.toThrow();
  });

  it("lists only the requesting owner's connections", () => {
    const { manager, definition } = managerWithConnection();
    manager.create(definition, {
      integrationId: definition.id,
      owner: USER_B,
      scopes: ['storage.objects.read'],
    });
    expect(manager.listOwnedBy(undefined, USER_A)).toHaveLength(1);
    expect(manager.listOwnedBy(undefined, USER_B)).toHaveLength(1);
    expect(manager.listOwnedBy(definition.id, USER_A)).toHaveLength(1);
  });

  it("reports another owner's connection as NOT FOUND (fail closed)", () => {
    const { manager, connection } = managerWithConnection();
    expect(() => manager.get(connection.connectionId, USER_B)).toThrow(ConnectionNotFoundError);
  });

  it('blocks cross-project access attempts', () => {
    const events: unknown[] = [];
    const manager = new ConnectionManager({
      now: clock(0),
      onAudit: (event) => events.push(event),
    });
    const definition = validDefinition();
    const connection = manager.create(definition, {
      integrationId: definition.id,
      owner: PROJECT_1,
      scopes: ['storage.objects.read'],
    });
    expect(() => manager.get(connection.connectionId, PROJECT_2)).toThrow(ConnectionNotFoundError);
    expect(() => manager.disconnect(connection.connectionId, PROJECT_2)).toThrow(
      ConnectionNotFoundError,
    );
    // The attempt is audited - it never falls through silently.
    expect(
      events.some((event) => (event as { type: string }).type === 'integration.ownership_denied'),
    ).toBe(true);
    // And the connection still exists for its real owner.
    expect(manager.get(connection.connectionId, PROJECT_1).connectionId).toBe(
      connection.connectionId,
    );
  });

  it('blocks cross-workspace access attempts', () => {
    const manager = new ConnectionManager({ now: clock(0) });
    const definition = validDefinition();
    const wsA = { kind: 'workspace' as const, id: 'ws-a' };
    const wsB = { kind: 'workspace' as const, id: 'ws-b' };
    const connection = manager.create(definition, {
      integrationId: definition.id,
      owner: wsA,
      scopes: ['storage.objects.read'],
    });
    expect(() => manager.get(connection.connectionId, wsB)).toThrow(ConnectionNotFoundError);
  });

  it('disconnect removes the connection and audits honestly', () => {
    const events: unknown[] = [];
    const manager = new ConnectionManager({
      now: clock(0),
      onAudit: (event) => events.push(event),
    });
    const definition = validDefinition();
    const connection = manager.create(definition, {
      integrationId: definition.id,
      owner: USER_A,
      scopes: ['storage.objects.read'],
    });
    manager.disconnect(connection.connectionId, USER_A);
    expect(() => manager.get(connection.connectionId, USER_A)).toThrow(ConnectionNotFoundError);
    const disconnected = events.find(
      (event) => (event as { type: string }).type === 'integration.disconnected',
    ) as { summary: string } | undefined;
    expect(disconnected).toBeDefined();
    // Honest wording: platform-side revocation only, no provider claims.
    expect(disconnected?.summary).toMatch(/NOT performed/);
  });

  it('disable/enable toggles fail-closed execution state', () => {
    const { manager, connection } = managerWithConnection();
    manager.disable(connection.connectionId, USER_A);
    expect(manager.get(connection.connectionId, USER_A).status).toBe('disabled');
    manager.enable(connection.connectionId, USER_A);
    expect(manager.get(connection.connectionId, USER_A).status).toBe('connected');
  });

  it('recordStatusCheck stores health outcome metadata only', () => {
    const { manager, connection } = managerWithConnection();
    const updated = manager.recordStatusCheck(connection.connectionId, USER_A, {
      healthy: false,
      detail: 'quota exceeded',
    });
    expect(updated.status).toBe('error');
    expect(updated.statusDetail).toBe('quota exceeded');
    expect(updated.lastStatusCheckAt).toBeDefined();
  });

  it('reports active connections for in-use guards', () => {
    const { manager, connection, definition } = managerWithConnection();
    expect(manager.hasActiveConnections(definition.id)).toBe(true);
    manager.disconnect(connection.connectionId, USER_A);
    expect(manager.hasActiveConnections(definition.id)).toBe(false);
  });

  it('sanitizes the account display reference', () => {
    const { manager, definition } = managerWithConnection();
    const connection = manager.create(definition, {
      integrationId: definition.id,
      owner: USER_A,
      scopes: ['storage.objects.read'],
      accountRef: '   an\n  account\twith whitespace   ',
    });
    expect(connection.accountRef).toBe('an account with whitespace');
  });
});

describe('isSameOwner', () => {
  it('matches only on kind AND id', () => {
    expect(isSameOwner(PROJECT_1, { kind: 'project', id: 'prj-1' })).toBe(true);
    expect(isSameOwner(PROJECT_1, PROJECT_2)).toBe(false);
    expect(isSameOwner(PROJECT_1, { kind: 'user', id: 'prj-1' })).toBe(false);
  });
});

describe('assertCredentialAvailable', () => {
  it('passes for none-auth integrations without any stored secret', () => {
    const store = new InMemorySecretStore();
    const definition = { ...validDefinition(), authenticationType: 'none' as const };
    expect(() => assertCredentialAvailable(definition, store)).not.toThrow();
  });

  it('throws the typed error when no credential is stored', () => {
    const store = new InMemorySecretStore();
    expect(() => assertCredentialAvailable(validDefinition(), store)).toThrow(
      /INTEGRATION_CREDENTIAL_UNAVAILABLE|credential/i,
    );
  });

  it('passes when a secret exists - without ever reading its value', () => {
    const store = new InMemorySecretStore();
    store.setSecret({ integrationId: 'demo-store', secretId: 'operator' }, 'raw-value');
    expect(() => assertCredentialAvailable(validDefinition(), store)).not.toThrow();
  });
});
