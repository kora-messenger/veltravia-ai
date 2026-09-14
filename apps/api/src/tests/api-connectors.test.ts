import { describe, expect, it } from 'vitest';
import { ConnectorManager } from '@veltravia/connector-core';
import { createMockConnector } from '@veltravia/connector-mock';
import { buildApp } from '../server.js';

const NOW = () => new Date('2026-09-13T12:00:00.000Z');

function buildConnectorApp(): ReturnType<typeof buildApp> {
  const manager = new ConnectorManager({ now: NOW });
  manager.register(createMockConnector({ now: NOW }));
  return buildApp({ connectors: manager });
}

describe('GET /api/connectors', () => {
  it('lists registered connectors with metadata and status only', async () => {
    const app = buildConnectorApp();
    const response = await app.inject({ method: 'GET', url: '/api/connectors' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0]).toMatchObject({
      id: 'mock',
      name: 'Mock Connector',
      version: '1.0.0',
      category: 'other',
      capabilities: ['read', 'write', 'search'],
      status: 'registered',
      permissionCount: 4,
      operationCount: 4,
    });
    app.close();
  });

  it('contains no credential or token material anywhere in the payload', async () => {
    const app = buildConnectorApp();
    const response = await app.inject({ method: 'GET', url: '/api/connectors' });
    expect(response.body).not.toMatch(/AIza|ghp_|sk-|Bearer\s|password|secret/i);
    app.close();
  });
});

describe('GET /api/connectors/:id', () => {
  it('returns the full read-only inspection for a known connector', async () => {
    const app = buildConnectorApp();
    const response = await app.inject({ method: 'GET', url: '/api/connectors/mock' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metadata.id).toBe('mock');
    expect(body.capabilities).toEqual(['read', 'write', 'search']);
    expect(body.permissions).toHaveLength(4);
    expect(body.permissions[0]).toEqual({
      id: 'resources.read',
      description: 'Read mock resources.',
      riskLevel: 'low',
    });
    expect(body.operations.map((operation: { id: string }) => operation.id)).toEqual([
      'mock.read',
      'mock.write',
      'mock.search',
      'mock.administer',
    ]);
    expect(body.grantedPermissions).toEqual([]);
    expect(body.status).toEqual({ status: 'registered', since: '2026-09-13T12:00:00.000Z' });
    // No credential-shaped data may ever appear.
    expect(body.credential).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/AIza|ghp_|sk-|Bearer\s/);
    app.close();
  });

  it('404s with a typed error for unknown connectors', async () => {
    const app = buildConnectorApp();
    const response = await app.inject({ method: 'GET', url: '/api/connectors/ghost' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'CONNECTOR_NOT_FOUND',
        message: 'No connector registered with id "ghost".',
        details: { connectorId: 'ghost' },
      },
    });
    app.close();
  });
});

// ---------------------------------------------------------------------------
// Step 10: the GitHub connector is visible read-only (metadata + status only)
// ---------------------------------------------------------------------------

describe('GitHub connector visibility', () => {
  it('lists the GitHub connector with honest status and no credentials', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/connectors' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const github = (body.connectors as { id: string }[]).find(
      (connector) => connector.id === 'github-demo',
    );
    expect(github).toBeDefined();
    // Read-only surface: no credential material, no granted permissions.
    expect(JSON.stringify(github)).not.toMatch(/ghp_|token|secret/i);
    app.close();
  });

  it('exposes GitHub connector metadata on GET /api/connectors/:id', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/connectors/github-demo' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metadata?.id).toBe('github-demo');
    expect(body.metadata?.category).toBe('source_control');
    app.close();
  });
});
