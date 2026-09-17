import { describe, expect, it } from 'vitest';

import {
  ConnectionManager,
  IntegrationRegistry,
  IntegrationRuntime,
  InMemorySecretStore,
  integrationToSafeView,
  type ConnectionOwner,
  type IntegrationAuditEvent,
} from './index.js';
import { validIntegrationDefinition as validDefinition } from './testing/index.js';

/**
 * THE SECRET-BOUNDARY PROOFS.
 *
 * These tests plant a live raw secret in the platform's SecretStore, run
 * real connections and operations through the runtime, and then assert
 * that the secret value can NEVER be found in any of the surfaces the
 * spec forbids: tool metadata, connection records, audit events, error
 * messages, safe views, or serialized state.
 */

const OWNER: ConnectionOwner = { kind: 'user', id: 'operator' };
const RAW_SECRET = 'ghp_SUPER_SECRET_TOKEN_ABCDEFGHIJKLMNOP';

function boundarySystem() {
  const audit: IntegrationAuditEvent[] = [];
  const registry = new IntegrationRegistry({ onAudit: (event) => audit.push(event) });
  registry.register(validDefinition());
  const connections = new ConnectionManager({ onAudit: (event) => audit.push(event) });
  const secrets = new InMemorySecretStore();
  const runtime = new IntegrationRuntime({
    registry,
    connections,
    secrets,
    executors: {
      'demo-store': (input, context) => {
        // Read the secret inside the boundary (proves it exists).
        const secret = context.getSecret();
        if (input['boom'] === true) {
          throw new Error(`provider failure, auth was Bearer ${secret}`);
        }
        return { read: true, secretLength: secret?.length ?? 0 };
      },
    },
    now: () => new Date(0),
    onAudit: (event) => audit.push(event),
  });
  const connection = connections.create(validDefinition(), {
    integrationId: 'demo-store',
    owner: OWNER,
    scopes: ['storage.objects.read', 'storage.objects.write', 'storage.objects.delete'],
  });
  secrets.setSecret(
    { integrationId: 'demo-store', secretId: `connection:${connection.connectionId}` },
    RAW_SECRET,
  );
  return { registry, connections, secrets, runtime, connection, audit };
}

describe('secret boundary', () => {
  it('the secret is live and used by the executor (proof of work)', async () => {
    const { runtime, connection } = boundarySystem();
    const result = await runtime.execute({
      integrationId: 'demo-store',
      connectionId: connection.connectionId,
      owner: OWNER,
      operationId: 'storage.objects.get',
      input: { key: 'a' },
    });
    // The output may describe the secret (length) but never carry it.
    expect(JSON.stringify(result.output)).not.toContain(RAW_SECRET);
    expect((result.output['secretLength'] as number) ?? 0).toBeGreaterThan(0);
  });

  it('never appears in connection records', async () => {
    const { runtime, connections, connection } = boundarySystem();
    await runtime.execute({
      integrationId: 'demo-store',
      connectionId: connection.connectionId,
      owner: OWNER,
      operationId: 'storage.objects.get',
      input: { key: 'a' },
    });
    const record = connections.get(connection.connectionId, OWNER);
    expect(JSON.stringify(record)).not.toContain(RAW_SECRET);
  });

  it('never appears in integration definitions or safe views', async () => {
    const { runtime, registry, connection } = boundarySystem();
    await runtime.execute({
      integrationId: 'demo-store',
      connectionId: connection.connectionId,
      owner: OWNER,
      operationId: 'storage.objects.get',
      input: { key: 'a' },
    });
    expect(JSON.stringify(registry.get('demo-store'))).not.toContain(RAW_SECRET);
    expect(JSON.stringify(integrationToSafeView(registry.get('demo-store')))).not.toContain(
      RAW_SECRET,
    );
  });

  it('never appears in audit events after real executions', async () => {
    const { runtime, connection, audit } = boundarySystem();
    await runtime.execute({
      integrationId: 'demo-store',
      connectionId: connection.connectionId,
      owner: OWNER,
      operationId: 'storage.objects.get',
      input: { key: 'a' },
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(RAW_SECRET);
  });

  it('never appears in error messages when a provider leaks its auth header', async () => {
    const { runtime, connection } = boundarySystem();
    let message: string | undefined;
    try {
      await runtime.execute({
        integrationId: 'demo-store',
        connectionId: connection.connectionId,
        owner: OWNER,
        operationId: 'storage.objects.get',
        input: { boom: true },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBeDefined();
    expect(message).not.toContain(RAW_SECRET);
    // Provider errors never pass through: the runtime surfaces only its
    // own sanitized summary (stronger than redaction).
    expect(message).toMatch(/the integration operation failed|\[REDACTED\]/);
  });

  it("never appears in the store's diagnostic surface", () => {
    const { secrets } = boundarySystem();
    const described = JSON.stringify(secrets.describe());
    expect(described).not.toContain(RAW_SECRET);
  });

  it('connection JSON contains only metadata-shape fields', () => {
    const { connection } = boundarySystem();
    const serialized = JSON.stringify(connection);
    for (const forbidden of ['token', 'password', 'apiKey', 'api_key', 'clientSecret', 'refresh']) {
      expect(serialized).not.toMatch(new RegExp(forbidden, 'i'));
    }
  });

  it('serialized runtime results are inert (plain JSON only)', async () => {
    const { runtime, connection } = boundarySystem();
    const result = await runtime.execute({
      integrationId: 'demo-store',
      connectionId: connection.connectionId,
      owner: OWNER,
      operationId: 'storage.objects.get',
      input: { key: 'a' },
    });
    expect(JSON.parse(JSON.stringify(result.output))).toEqual(result.output);
  });
});
