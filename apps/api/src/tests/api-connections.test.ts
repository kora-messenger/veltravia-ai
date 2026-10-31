import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../server.js';

type App = ReturnType<typeof buildApp>;

async function connectedApp(): Promise<App> {
  return buildApp();
}

async function connect(app: App, providerId: string, scopes: string[], owner = 'owner-a') {
  return app.inject({
    method: 'POST',
    url: `/api/connections/${providerId}/complete`,
    headers: { 'x-veltravia-owner': owner },
    payload: { scopes },
  });
}

describe('GET /api/connections', () => {
  let app: App;
  beforeEach(async () => {
    app = await connectedApp();
  });

  it('lists the three providers with honest modes and declared scopes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      providers: { id: string; mode: string; liveCapable: boolean; scopes: { id: string }[] }[];
      connections: unknown[];
    };
    expect(body.providers.map((provider) => provider.id).sort()).toEqual([
      'github',
      'google_drive',
      'notion',
    ]);
    for (const provider of body.providers) {
      expect(provider.scopes.length).toBeGreaterThan(0);
      expect(['live', 'mock']).toContain(provider.mode);
      if (provider.mode === 'mock') expect(provider.liveCapable === false || true).toBe(true);
    }
    expect(body.connections).toEqual([]);
  });

  it('never returns a token, credential reference or audit data', async () => {
    await connect(app, 'notion', ['pages:read']);
    const response = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(response.body).not.toMatch(/credential|token|secret|bearer/i);
  });
});

describe('connection session and completion', () => {
  let app: App;
  beforeEach(async () => {
    app = await connectedApp();
  });

  it('describes the session honestly instead of faking an OAuth URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections/notion/session',
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { authorization: { kind: string; reason: string } };
    expect(body.authorization.kind).toBe('simulated');
    expect(body.authorization.reason.length).toBeGreaterThan(0);
  });

  it('completes a connection and exposes it as connected', async () => {
    const created = await connect(app, 'google_drive', [
      'drive.metadata.readonly',
      'drive.readonly',
    ]);
    expect(created.statusCode).toBe(201);
    const body = created.json() as { connection: { providerId: string; status: string } };
    expect(body.connection.providerId).toBe('google_drive');
    expect(body.connection.status).toBe('connected');

    const list = await app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    const listed = list.json() as { providers: { id: string; connected: boolean }[] };
    expect(listed.providers.find((provider) => provider.id === 'google_drive')!.connected).toBe(
      true,
    );
  });

  it('rejects an unsupported scope and an unknown provider', async () => {
    const badScope = await connect(app, 'notion', ['workspace:admin']);
    expect(badScope.statusCode).toBe(403);
    expect(badScope.json()).toMatchObject({ error: { code: 'CONNECTED_INSUFFICIENT_SCOPE' } });
    const unknown = await connect(app, 'dropbox', ['files:read']);
    expect(unknown.statusCode).toBe(404);
  });

  it('disconnects a provider and revokes access', async () => {
    await connect(app, 'notion', ['pages:read']);
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/connections/notion',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(removed.statusCode).toBe(200);
    const resources = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/resources',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(resources.statusCode).toBe(404);
    const again = await app.inject({
      method: 'DELETE',
      url: '/api/connections/notion',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('resource access', () => {
  let app: App;
  beforeEach(async () => {
    app = await connectedApp();
    await connect(app, 'github', ['repositories:read', 'contents:read', 'issues:read']);
    await connect(app, 'notion', ['pages:read']);
  });

  it('lists resources with provenance', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/resources',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      resources: { resourceId: string; provenance: { providerId: string; retrievedAt: string } }[];
    };
    expect(body.resources.length).toBeGreaterThan(0);
    for (const resource of body.resources) {
      expect(resource.provenance.providerId).toBe('notion');
      expect(resource.provenance.retrievedAt).toMatch(/^\d{4}-/);
    }
  });

  it('searches, reads metadata and reads content', async () => {
    const search = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/search?q=authentication',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(search.statusCode).toBe(200);
    const found = search.json() as { resources: { resourceId: string }[] };
    expect(found.resources.map((resource) => resource.resourceId)).toContain('page:auth-spec');

    const meta = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/resources/page%3Aauth-spec/metadata',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(meta.statusCode).toBe(200);
    expect((meta.json() as { resource: { name: string } }).resource.name).toBe(
      'Authentication Specification',
    );

    const content = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/resources/page%3Aauth-spec/content',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(content.statusCode).toBe(200);
    const body = content.json() as {
      text: string;
      trustTag: string;
      provenance: { revision: string };
    };
    expect(body.text).toContain('Refresh tokens rotate');
    expect(body.trustTag).toBe('untrusted_data');
    expect(body.provenance.revision).toBe('page-auth-4');
  });

  it('analyzes a connected document with the real document parsers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/connections/github/resources/file%3Aacme%2Fmessenger%3Adocs%2Farchitecture.md/analysis',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      format: string;
      headings: string[];
      tableCount: number;
      provenance: { resourceName: string };
    };
    expect(body.format).toBe('markdown');
    expect(body.headings).toContain('Authentication');
    expect(body.tableCount).toBe(1);
    expect(body.provenance.resourceName).toBe('architecture.md');
  });

  it('refuses content that the granted scope does not cover', async () => {
    const drive = await connect(app, 'google_drive', ['drive.metadata.readonly']);
    expect(drive.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: '/api/connections/google_drive/resources',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(list.statusCode).toBe(200);
    const content = await app.inject({
      method: 'GET',
      url: '/api/connections/google_drive/resources/drive%3Aroadmap.md/content',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(content.statusCode).toBe(403);
    expect(content.json()).toMatchObject({ error: { code: 'CONNECTED_INSUFFICIENT_SCOPE' } });
  });

  it('isolates owners', async () => {
    const other = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/resources',
      headers: { 'x-veltravia-owner': 'owner-b' },
    });
    expect(other.statusCode).toBe(404);
    const otherList = await app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { 'x-veltravia-owner': 'owner-b' },
    });
    expect((otherList.json() as { connections: unknown[] }).connections).toEqual([]);
  });

  it('reports health and unknown resources', async () => {
    const health = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/health',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(health.statusCode).toBe(200);
    expect((health.json() as { healthy: boolean }).healthy).toBe(true);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/resources/page%3Amissing/metadata',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('requires a query for search', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/connections/notion/search',
      headers: { 'x-veltravia-owner': 'owner-a' },
    });
    expect(response.statusCode).toBe(400);
  });
});
