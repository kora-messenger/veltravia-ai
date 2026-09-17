import { describe, expect, it } from 'vitest';

import {
  ConnectionManager,
  IntegrationRegistry,
  IntegrationRuntime,
  InMemorySecretStore,
  assertIntegrationEnabled,
  IntegrationDisabledError,
  IntegrationExecutionFailedError,
  IntegrationNotFoundError,
  MissingScopeError,
  type ConnectionOwner,
  type IntegrationAuditEvent,
} from '../index.js';
import { validIntegrationDefinition as validDefinition } from '../testing/index.js';

const OWNER: ConnectionOwner = { kind: 'user', id: 'operator' };

const RAW_SECRET = 'sk-ant-api03-RAW-SECRET-VALUE-9876543210-xyz';

function buildSystem(
  options: {
    readonly enabled?: boolean;
    readonly connectionScopes?: readonly string[];
    readonly connectionStatus?: 'connected' | 'disabled';
  } = {},
) {
  const audit: IntegrationAuditEvent[] = [];
  const registry = new IntegrationRegistry({
    onAudit: (event) => audit.push(event),
  });
  registry.register(validDefinition());
  if (options.enabled === false) registry.disable('demo-store');

  const connections = new ConnectionManager({
    now: () => new Date(0),
    onAudit: (event) => audit.push(event),
  });
  const secrets = new InMemorySecretStore();

  const executed: { input: Readonly<Record<string, unknown>>; secretSeen: string | undefined }[] =
    [];
  const runtime = new IntegrationRuntime({
    registry,
    connections,
    secrets,
    executors: {
      'demo-store': (input, context) => {
        const secret =
          context.definition.authenticationType === 'none' ? undefined : context.getSecret();
        executed.push({ input, secretSeen: secret });
        if (input['fail'] === true) {
          throw new Error(`provider exploded with token ${RAW_SECRET}`);
        }
        return { ok: true, key: input['key'], accountId: 'demo' };
      },
    },
    now: () => new Date(0),
    onAudit: (event) => audit.push(event),
  });

  const connection = connections.create(validDefinition(), {
    integrationId: 'demo-store',
    owner: OWNER,
    scopes: options.connectionScopes ?? [
      'storage.objects.read',
      'storage.objects.write',
      'storage.objects.delete',
    ],
  });
  if (options.connectionStatus === 'disabled') {
    connections.disable(connection.connectionId, OWNER);
  }
  secrets.setSecret(
    { integrationId: 'demo-store', secretId: `connection:${connection.connectionId}` },
    RAW_SECRET,
  );

  return { runtime, connections, audit, executed, connection, secrets };
}

function request(
  connectionId: string,
  operationId: string,
  input: Readonly<Record<string, unknown>> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    integrationId: 'demo-store',
    connectionId,
    owner: OWNER,
    operationId,
    input,
    ...overrides,
  };
}

describe('IntegrationRuntime.execute', () => {
  it('runs the full pipeline and returns a normalized result', async () => {
    const { runtime, connection } = buildSystem();
    const result = await runtime.execute(
      request(
        connection.connectionId,
        'storage.objects.get',
        { key: 'notes.txt' },
        {
          confirmationGated: true,
        },
      ),
    );
    expect(result.output).toEqual({ ok: true, key: 'notes.txt', accountId: 'demo' });
  });

  it('passes the secret into the executor INSIDE the boundary only', async () => {
    const { runtime, connection, executed } = buildSystem();
    await runtime.execute(request(connection.connectionId, 'storage.objects.put', { key: 'a' }));
    expect(executed[0]?.secretSeen).toBe(RAW_SECRET);
  });

  it('never lets the secret into audit events or results', async () => {
    const { runtime, connection, audit } = buildSystem();
    await runtime.execute(request(connection.connectionId, 'storage.objects.get', { key: 'a' }));
    expect(JSON.stringify(audit)).not.toContain(RAW_SECRET);
  });

  it('sanitizes provider errors that contain credential material', async () => {
    const { runtime, connection } = buildSystem();
    await expect(
      runtime.execute(request(connection.connectionId, 'storage.objects.get', { fail: true })),
    ).rejects.toSatisfy((error: unknown) => {
      const message = String((error as Error).message);
      return !message.includes(RAW_SECRET);
    });
  });

  it('rejects unknown integrations with the typed not-found', async () => {
    const { runtime } = buildSystem();
    await expect(
      runtime.execute(request('conn_x', 'storage.objects.get', {}, { integrationId: 'ghost' })),
    ).rejects.toThrow(IntegrationNotFoundError);
  });

  it('rejects operations the integration does not declare', async () => {
    const { runtime, connection } = buildSystem();
    await expect(
      runtime.execute(request(connection.connectionId, 'storage.objects.grantAll')),
    ).rejects.toThrow(IntegrationExecutionFailedError);
  });

  it('rejects when a required scope is not granted to the connection', async () => {
    const { runtime, connection } = buildSystem({
      connectionScopes: ['storage.objects.read'],
    });
    await expect(
      runtime.execute(request(connection.connectionId, 'storage.objects.put', { key: 'a' })),
    ).rejects.toThrow(MissingScopeError);
  });

  it('audits authorization denials', async () => {
    const { runtime, connection, audit } = buildSystem({
      connectionScopes: ['storage.objects.read'],
    });
    await expect(
      runtime.execute(request(connection.connectionId, 'storage.objects.put')),
    ).rejects.toThrow();
    expect(audit.some((event) => event.type === 'integration.authorization_denied')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(RAW_SECRET);
  });

  it('fails closed when the integration is disabled', async () => {
    const { runtime, connection } = buildSystem({ enabled: false });
    await expect(
      runtime.execute(request(connection.connectionId, 'storage.objects.get')),
    ).rejects.toThrow(IntegrationDisabledError);
  });

  it('fails closed when the connection is disabled', async () => {
    const { runtime, connection } = buildSystem({ connectionStatus: 'disabled' });
    await expect(
      runtime.execute(request(connection.connectionId, 'storage.objects.get')),
    ).rejects.toThrow(/disabled/);
  });

  it('fails closed when the connection does not exist for the owner', async () => {
    const { runtime } = buildSystem();
    await expect(
      runtime.execute(
        request(
          'conn_missing',
          'storage.objects.get',
          {},
          {
            owner: { kind: 'project', id: 'prj-other' },
          },
        ),
      ),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses high-risk operations that bypass the confirmation gate', async () => {
    const { runtime, connection, audit } = buildSystem();
    // storage.objects.delete is high risk: without the Tool System's
    // confirmation-gated flag the runtime refuses to be a bypass.
    await expect(
      runtime.execute(request(connection.connectionId, 'storage.objects.delete')),
    ).rejects.toThrow(/confirmation gate/i);
    expect(audit.some((event) => event.type === 'integration.authorization_denied')).toBe(true);
    // With the gate flag set (the only caller that may set it is the Tool
    // System adapter), execution proceeds through the SAME pipeline.
    await expect(
      runtime.execute(
        request(connection.connectionId, 'storage.objects.delete', {}, { confirmationGated: true }),
      ),
    ).resolves.toBeDefined();
  });

  it('scrubs secret-shaped values out of tool output', async () => {
    const events: IntegrationAuditEvent[] = [];
    const registry = new IntegrationRegistry({ onAudit: (event) => events.push(event) });
    registry.register(validDefinition());
    const connections = new ConnectionManager({ now: () => new Date(0) });
    const secrets = new InMemorySecretStore();
    const runtime = new IntegrationRuntime({
      registry,
      connections,
      secrets,
      executors: {
        'demo-store': () => ({
          leaked: `value with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 inside`,
        }),
      },
      now: () => new Date(0),
    });
    const connection = connections.create(validDefinition(), {
      integrationId: 'demo-store',
      owner: OWNER,
      scopes: ['storage.objects.read'],
    });
    secrets.setSecret(
      { integrationId: 'demo-store', secretId: `connection:${connection.connectionId}` },
      RAW_SECRET,
    );
    const result = await runtime.execute(request(connection.connectionId, 'storage.objects.get'));
    expect(JSON.stringify(result.output)).toContain('[REDACTED]');
    expect(JSON.stringify(result.output)).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('counts operations through the connection (usage hook)', async () => {
    const { runtime, connections, connection } = buildSystem();
    await runtime.execute(request(connection.connectionId, 'storage.objects.get', { key: 'a' }));
    await runtime.execute(request(connection.connectionId, 'storage.objects.get', { key: 'b' }));
    expect(connections.get(connection.connectionId, OWNER).operationCount).toBe(2);
  });
});

describe('assertIntegrationEnabled', () => {
  it('throws the typed disabled error only when disabled', () => {
    expect(() => assertIntegrationEnabled(true, 'demo-store')).not.toThrow();
    expect(() => assertIntegrationEnabled(false, 'demo-store')).toThrow(IntegrationDisabledError);
  });
});
