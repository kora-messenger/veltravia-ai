import { describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';
import { createIntegrationSystem, integrationOwner } from '../integrations.js';
import { createGitHubApiConnector } from '../github.js';

/**
 * Step 12: the integration / plugin surface.
 *
 * Catalog endpoints are read-only and scrubbed; connection endpoints are
 * owner-scoped lifecycle operations with typed error mapping. No endpoint
 * executes anything, grants anything, or can surface a secret. The final
 * block proves the agent story end to end: a scripted demo agent discovers
 * and invokes an integration tool through the same Tool System pipeline,
 * with no connector-specific agent code anywhere.
 */

const SECRET_MARKERS = [
  'offline-mock-storage-dev-credential',
  'demo-fixture-credential-no-external-service',
];

async function buildIntegrationApp() {
  const github = createGitHubApiConnector({ now: () => new Date('2026-01-01T00:00:00Z') });
  const integrations = createIntegrationSystem({
    now: () => new Date('2026-01-01T00:00:00Z'),
    github,
  });
  const app = buildApp({ integrations });
  return app;
}

function integrationList(body: unknown): Array<Record<string, unknown>> {
  return (body as { integrations: Array<Record<string, unknown>> }).integrations;
}

describe('GET /api/integrations', () => {
  it('lists the catalog with enabled state and owner connections', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({ method: 'GET', url: '/api/integrations' });
    expect(response.statusCode).toBe(200);
    const integrations = integrationList(response.json());
    expect(integrations.map((entry) => entry['id'])).toEqual(
      expect.arrayContaining(['github-demo', 'mock-storage', 'mock-database']),
    );
    for (const entry of integrations) {
      expect(entry['enabled']).toBe(true);
      expect(Array.isArray(entry['scopes'])).toBe(true);
      expect(Array.isArray(entry['tools'])).toBe(true);
      expect(Array.isArray(entry['connections'])).toBe(true);
    }
    // Every boot connection belongs to the operator owner and is connected.
    const storage = integrations.find((entry) => entry['id'] === 'mock-storage');
    expect(storage).toBeDefined();
    const connections = storage!['connections'] as Array<Record<string, unknown>>;
    expect(connections.length).toBe(1);
    expect(connections[0]!['status']).toBe('connected');
    expect(connections[0]!['grantedScopes']).toEqual(
      expect.arrayContaining(['storage.objects.read', 'storage.objects.write']),
    );
    await app.close();
  });

  it('never surfaces credential material', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({ method: 'GET', url: '/api/integrations' });
    const raw = response.body;
    for (const marker of SECRET_MARKERS) {
      expect(raw.includes(marker)).toBe(false);
    }
    await app.close();
  });
});

describe('GET /api/integrations/:integrationId', () => {
  it('returns one integration detail', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({ method: 'GET', url: '/api/integrations/github-demo' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['id']).toBe('github-demo');
    expect(body['enabled']).toBe(true);
    expect(Array.isArray(body['tools'])).toBe(true);
    await app.close();
  });

  it('404s unknown integrations with no existence detail', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({ method: 'GET', url: '/api/integrations/does-not-exist' });
    expect(response.statusCode).toBe(404);
    const body = response.json() as Record<string, unknown>;
    expect(body['error']).toBe('INTEGRATION_NOT_FOUND');
    await app.close();
  });
});

describe('POST /api/integrations/:integrationId/connections', () => {
  it('creates an owner-scoped connection with requested scopes', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/mock-storage/connections',
      payload: { scopes: ['storage.objects.read'], accountRef: 'second store' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, unknown>;
    expect(body['status']).toBe('connected');
    expect(body['accountRef']).toBe('second store');
    expect(body['grantedScopes']).toEqual(['storage.objects.read']);
    await app.close();
  });

  it('rejects unknown integrations with 404', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/nope/connections',
      payload: { scopes: ['storage.objects.read'] },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('rejects undeclared scopes as invalid configuration with 400', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/mock-storage/connections',
      payload: { scopes: ['storage.objects.nope'] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as Record<string, unknown>;
    expect(body['error']).toBe('INTEGRATION_CONFIGURATION_INVALID');
    await app.close();
  });

  it('rejects malformed bodies with 400 (strict schema, no unknown fields)', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/mock-storage/connections',
      payload: { scopes: ['storage.objects.read'], extra: 'not allowed' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects empty scope lists with 400', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/mock-storage/connections',
      payload: { scopes: [] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('connection lifecycle', () => {
  it('reads, disables, enables, and disconnects one connection', async () => {
    const app = await buildIntegrationApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/integrations/mock-database/connections',
      payload: { scopes: ['database.rows.read'] },
    });
    const connectionId = (created.json() as Record<string, unknown>)['connectionId'] as string;

    const read = await app.inject({
      method: 'GET',
      url: `/api/integrations/mock-database/connections/${connectionId}`,
    });
    expect(read.statusCode).toBe(200);

    // A connection does not belong to another integration's namespace.
    const wrongIntegration = await app.inject({
      method: 'GET',
      url: `/api/integrations/mock-storage/connections/${connectionId}`,
    });
    expect(wrongIntegration.statusCode).toBe(404);

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/integrations/mock-database/connections/${connectionId}/disable`,
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as Record<string, unknown>)['status']).toBe('disabled');

    const enabled = await app.inject({
      method: 'POST',
      url: `/api/integrations/mock-database/connections/${connectionId}/enable`,
    });
    expect(enabled.statusCode).toBe(200);
    expect((enabled.json() as Record<string, unknown>)['status']).toBe('connected');

    const disconnected = await app.inject({
      method: 'DELETE',
      url: `/api/integrations/mock-database/connections/${connectionId}`,
    });
    expect(disconnected.statusCode).toBe(200);
    expect((disconnected.json() as Record<string, unknown>)['disconnected']).toBe(true);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/integrations/mock-database/connections/${connectionId}`,
    });
    expect(gone.statusCode).toBe(404);
    await app.close();
  });

  it('records an honest status-check outcome on a connection', async () => {
    const app = await buildIntegrationApp();
    const list = await app.inject({ method: 'GET', url: '/api/integrations/mock-storage' });
    const connections = (list.json() as Record<string, unknown>)['connections'] as Array<
      Record<string, unknown>
    >;
    const connectionId = connections[0]!['connectionId'] as string;
    const response = await app.inject({
      method: 'POST',
      url: `/api/integrations/mock-storage/connections/${connectionId}/status-check`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['lastStatusCheckAt']).toBeDefined();
    await app.close();
  });

  it('404s unknown connections with the typed error', async () => {
    const app = await buildIntegrationApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/mock-storage/connections/conn_unknown',
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as Record<string, unknown>)['error']).toBe('CONNECTION_NOT_FOUND');
    await app.close();
  });
});

describe('agent -> integration tool execution (no connector-specific agent code)', () => {
  it('runs the demo storage agent end to end through the Tool System', async () => {
    const app = await buildIntegrationApp();

    // One scripted run per API process for this agent (documented
    // development-only limitation): this is the FIRST run, so it succeeds.
    const started = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'agent.demo.storage', task: 'Store and re-read the demo object.' },
    });
    expect(started.statusCode).toBe(200);
    const run = started.json() as Record<string, unknown>;
    expect(typeof run['runId']).toBe('string');

    // Poll the run view until it terminates (bounded).
    let final: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && final === undefined; attempt += 1) {
      const polled = await app.inject({
        method: 'GET',
        url: `/api/agents/runs/${run['runId'] as string}`,
      });
      const body = polled.json() as Record<string, unknown>;
      if (['completed', 'failed', 'cancelled'].includes(body['status'] as string)) {
        final = body;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(final).toBeDefined();
    expect(final!['status']).toBe('completed');
    expect(final!['finalOutput']).toBeDefined();
    const raw = JSON.stringify(final);
    // Both tool calls executed through the integration runtime.
    expect(raw.includes('storage.object.put')).toBe(true);
    expect(raw.includes('storage.object.get')).toBe(true);
    await app.close();
  });
});

describe('owner boundary surface', () => {
  it('exposes the operator owner identity for the demo API (documented single tenant)', async () => {
    expect(integrationOwner().kind).toBe('user');
    expect(integrationOwner().id.length).toBeGreaterThan(0);
  });
});
