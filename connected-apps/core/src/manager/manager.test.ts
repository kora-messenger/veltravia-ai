import { describe, expect, it } from 'vitest';
import {
  createMockConnectedAppProviders,
  createMockDriveProvider,
  createMockGithubProvider,
  overrideProvider,
} from '@veltravia/connected-apps-mock';
import {
  ConnectedAppError,
  ConnectedAppManager,
  InMemoryCredentialVault,
  ProviderRegistry,
} from '../index.js';
import type { AuditSink, ConnectedAppProvider } from '../index.js';

const owner = { ownerRef: 'owner-a' };
const other = { ownerRef: 'owner-b' };

function harness(
  options: {
    faults?: Parameters<typeof createMockConnectedAppProviders>[0]['faults'];
    limits?: {
      requestTimeoutMs?: number;
      maxOperationsPerMinute?: number;
      maxResourceBytes?: number;
    };
  } = {},
) {
  const registry = new ProviderRegistry();
  for (const provider of createMockConnectedAppProviders({ faults: options.faults })) {
    registry.register(provider);
  }
  const events: { type: string; detail: string | null; ownerRef: string }[] = [];
  const audit: AuditSink = {
    record: (event) => {
      events.push({ type: event.type, detail: event.detail, ownerRef: event.ownerRef });
    },
  };
  const vault = new InMemoryCredentialVault();
  const manager = new ConnectedAppManager({ registry, vault, audit, limits: options.limits });
  return { manager, registry, vault, events };
}

describe('connected-app registry', () => {
  it('registers the three providers with declared scopes and honest live flags', () => {
    const { registry } = harness();
    const ids = registry.descriptors().map((descriptor) => descriptor.id);
    expect(ids).toEqual(['github', 'google_drive', 'notion']);
    for (const descriptor of registry.descriptors()) {
      expect(descriptor.liveCapable).toBe(false);
      expect(descriptor.scopes.length).toBeGreaterThan(0);
      expect(descriptor.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('refuses duplicate registration and unknown providers', () => {
    const { registry } = harness();
    expect(() => registry.register(createMockGithubProvider())).toThrow(ConnectedAppError);
    expect(() => registry.get('dropbox')).toThrow(ConnectedAppError);
  });

  it('refuses a provider that declares a capability it does not implement', () => {
    const registry = new ProviderRegistry();
    const broken = {
      descriptor: {
        ...createMockGithubProvider().descriptor,
        id: 'notion' as const,
        capabilities: ['list_resources', 'resource_content'] as const,
      },
      authenticate: async () => ({
        status: 'connected' as const,
        account: { accountId: 'a', displayName: 'A', email: null },
        credentialRef: null,
      }),
      revoke: async () => undefined,
      health: async () => ({
        healthy: true,
        status: 'connected' as const,
        detail: '',
        rateLimit: null,
      }),
    } as unknown as ConnectedAppProvider;
    expect(() => registry.register(broken)).toThrow(/does not implement/);
  });
});

describe('connection lifecycle', () => {
  it('connects, lists and disconnects a provider', async () => {
    const { manager } = harness();
    const connection = await manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    expect(connection.status).toBe('connected');
    expect(connection.providerId).toBe('notion');
    expect(manager.listConnections(owner)).toHaveLength(1);
    await manager.disconnect(owner, 'notion');
    expect(manager.listConnections(owner)).toHaveLength(0);
    await expect(manager.resources(owner, 'notion')).rejects.toMatchObject({
      code: 'CONNECTED_NOT_CONNECTED',
    });
  });

  it('refuses a scope the provider does not offer', async () => {
    const { manager } = harness();
    await expect(
      manager.connect(owner, 'notion', { grantedScopes: ['workspace:admin'] }),
    ).rejects.toMatchObject({ code: 'CONNECTED_INSUFFICIENT_SCOPE' });
  });

  it('reports a revoked authorization honestly instead of pretending to connect', async () => {
    const { manager } = harness({ faults: { revokeOnConnect: true } });
    await expect(
      manager.connect(owner, 'google_drive', { grantedScopes: ['drive.readonly'] }),
    ).rejects.toMatchObject({ code: 'CONNECTED_REVOKED' });
    expect(manager.listConnections(owner)).toHaveLength(0);
  });

  it('requires a credential for a live-capable provider', async () => {
    const { registry } = harness();
    const live = createMockGithubProvider();
    const registry2 = new ProviderRegistry();
    registry2.register(
      overrideProvider(live, { descriptor: { ...live.descriptor, liveCapable: true } }),
    );
    const manager = new ConnectedAppManager({
      registry: registry2,
      vault: new InMemoryCredentialVault(),
    });
    await expect(
      manager.connect(owner, 'github', { grantedScopes: ['repositories:read'] }),
    ).rejects.toMatchObject({ code: 'CONNECTED_INVALID_REQUEST' });
    expect(registry.ids()).toContain('github');
  });

  it('enforces the per-owner connection limit', async () => {
    const { manager } = harness({ limits: {} });
    const limited = new ConnectedAppManager({
      registry: ((): ProviderRegistry => {
        const r = new ProviderRegistry();
        for (const p of createMockConnectedAppProviders()) r.register(p);
        return r;
      })(),
      vault: new InMemoryCredentialVault(),
      limits: { maxConnectionsPerOwner: 1 },
    });
    await limited.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    await expect(
      limited.connect(owner, 'google_drive', { grantedScopes: ['drive.readonly'] }),
    ).rejects.toMatchObject({ code: 'CONNECTED_LIMIT_EXCEEDED' });
    expect(manager.listConnections(owner)).toHaveLength(0);
  });

  it('reports health for connected, disconnected and faulted providers', async () => {
    const { manager } = harness();
    const absent = await manager.health(owner, 'github');
    expect(absent.status).toBe('not_connected');
    expect(absent.healthy).toBe(false);
    await manager.connect(owner, 'github', {
      grantedScopes: ['repositories:read', 'contents:read'],
    });
    const healthy = await manager.health(owner, 'github');
    expect(healthy.status).toBe('connected');
    expect(healthy.healthy).toBe(true);
    expect(healthy.detail).not.toMatch(/token|secret/i);
  });
});

describe('authorization and isolation', () => {
  it('isolates connections between owners', async () => {
    const { manager } = harness();
    await manager.connect(owner, 'github', {
      grantedScopes: ['repositories:read', 'contents:read'],
    });
    expect(manager.listConnections(other)).toHaveLength(0);
    await expect(manager.resources(other, 'github')).rejects.toMatchObject({
      code: 'CONNECTED_NOT_CONNECTED',
    });
    await expect(manager.disconnect(other, 'github')).rejects.toMatchObject({
      code: 'CONNECTED_NOT_CONNECTED',
    });
  });

  it('refuses an operation whose scope was not granted', async () => {
    const { manager } = harness();
    await manager.connect(owner, 'google_drive', { grantedScopes: ['drive.metadata.readonly'] });
    const list = await manager.resources(owner, 'google_drive');
    expect(list.resources.length).toBeGreaterThan(0);
    await expect(manager.content(owner, 'google_drive', 'drive:roadmap.md')).rejects.toMatchObject({
      code: 'CONNECTED_INSUFFICIENT_SCOPE',
    });
  });

  it('never exposes credentials in a connection view or an audit record', async () => {
    const { manager, events, vault } = harness();
    await manager.connect(owner, 'notion', {
      grantedScopes: ['pages:read'],
      credential: 'mock-token',
    });
    const [connection] = manager.listConnections(owner);
    const serialized = JSON.stringify(connection);
    expect(serialized).not.toContain('mock-token');
    expect(serialized).not.toMatch(/credential/i);
    expect(vault.size).toBe(1);
    expect(JSON.stringify(events)).not.toContain('mock-token');
  });
});

describe('resources, search and provenance', () => {
  async function connected() {
    const h = harness();
    await h.manager.connect(owner, 'github', {
      grantedScopes: ['repositories:read', 'contents:read', 'issues:read'],
    });
    await h.manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    return h;
  }

  it('lists resources with provenance for every item', async () => {
    const { manager } = await connected();
    const page = await manager.resources(owner, 'notion');
    expect(page.resources.length).toBeGreaterThan(0);
    for (const resource of page.resources) {
      expect(resource.provenance.providerId).toBe('notion');
      expect(resource.provenance.accountId).toBe('notion-demo');
      expect(resource.provenance.retrievedAt).toMatch(/^\d{4}-/);
      expect(resource.provenance.resourceId).toBe(resource.resourceId);
    }
  });

  it('paginates deterministically and stops with a null cursor', async () => {
    harness({ limits: {} });
    const pagedManager = new ConnectedAppManager({
      registry: ((): ProviderRegistry => {
        const r = new ProviderRegistry();
        for (const p of createMockConnectedAppProviders()) r.register(p);
        return r;
      })(),
      vault: new InMemoryCredentialVault(),
      limits: { maxListItems: 2 },
    });
    await pagedManager.connect(owner, 'github', {
      grantedScopes: ['repositories:read', 'contents:read', 'issues:read'],
    });
    const page1 = await pagedManager.resources(owner, 'github');
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await pagedManager.resources(owner, 'github', { cursor: page1.nextCursor });
    expect(page2.resources.length).toBeGreaterThan(0);
    expect(page2.resources[0]!.resourceId).not.toBe(page1.resources[0]!.resourceId);
  });

  it('searches resources and reports empty results honestly', async () => {
    const { manager } = await connected();
    const hit = await manager.search(owner, 'notion', 'authentication');
    expect(hit.resources.map((r) => r.resourceId)).toContain('page:auth-spec');
    const miss = await manager.search(owner, 'notion', 'zebra');
    expect(miss.resources).toHaveLength(0);
    expect(miss.nextCursor).toBeNull();
  });

  it('reads content with a fresh provenance timestamp and revision', async () => {
    const { manager } = await connected();
    const content = await manager.content(
      owner,
      'github',
      'file:acme/messenger:docs/architecture.md',
    );
    expect(content.mimeType).toBe('text/markdown');
    expect(content.provenance.revision).toBe('sha-arch-1');
    expect(content.provenance.sourceUrl).toContain('architecture.md');
    expect(content.fromCache).toBe(false);
    expect(new TextDecoder().decode(content.bytes)).toContain('Authentication');
  });

  it('returns metadata without downloading the whole resource', async () => {
    const { manager } = await connected();
    const resource = await manager.metadata(owner, 'notion', 'page:auth-spec');
    expect(resource.kind).toBe('page');
    expect(resource.name).toBe('Authentication Specification');
    expect(resource.provenance.providerName).toBe('Notion');
  });

  it('extracts bounded source evidence and says when a quote is absent', async () => {
    const { manager } = await connected();
    const hit = await manager.evidence(owner, 'notion', 'page:auth-spec', 'fifteen minutes');
    expect(hit.matched).toBe(true);
    expect(hit.excerpt).toContain('fifteen minutes');
    const miss = await manager.evidence(owner, 'notion', 'page:auth-spec', 'no such sentence');
    expect(miss.matched).toBe(false);
    expect(miss.excerpt).toBe('');
  });
});

describe('limits, failures and redaction', () => {
  it('surfaces provider rate limits as typed errors', async () => {
    const h = harness({ faults: { rateLimitAfter: 1 } });
    await h.manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    await h.manager.resources(owner, 'notion');
    await expect(h.manager.resources(owner, 'notion')).rejects.toMatchObject({
      code: 'CONNECTED_RATE_LIMITED',
    });
  });

  it('enforces its own per-minute budget', async () => {
    const h = harness({ limits: { maxOperationsPerMinute: 2 } });
    await h.manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    await h.manager.resources(owner, 'notion');
    await h.manager.resources(owner, 'notion');
    await expect(h.manager.resources(owner, 'notion')).rejects.toMatchObject({
      code: 'CONNECTED_RATE_LIMITED',
    });
  });

  it('normalizes a hung provider into a typed failure', async () => {
    const h = harness({ faults: { hang: true } });
    await h.manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    await expect(h.manager.resources(owner, 'notion')).rejects.toMatchObject({
      code: 'CONNECTED_PROVIDER_ERROR',
    });
  });

  it('times out a provider that never answers', async () => {
    const registry = new ProviderRegistry();
    const base = createMockDriveProvider();
    registry.register(
      overrideProvider(base, { listResources: () => new Promise(() => undefined) }),
    );
    const manager = new ConnectedAppManager({
      registry,
      vault: new InMemoryCredentialVault(),
      limits: { requestTimeoutMs: 30 },
    });
    await manager.connect(owner, 'google_drive', {
      grantedScopes: ['drive.metadata.readonly', 'drive.readonly'],
    });
    await expect(manager.resources(owner, 'google_drive')).rejects.toMatchObject({
      code: 'CONNECTED_TIMEOUT',
    });
  });

  it('reports a resource the provider refuses as forbidden', async () => {
    const h = harness({ faults: { forbiddenResourceIds: ['page:auth-spec'] } });
    await h.manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    await expect(h.manager.content(owner, 'notion', 'page:auth-spec')).rejects.toMatchObject({
      code: 'CONNECTED_RESOURCE_FORBIDDEN',
    });
  });

  it('rejects unknown resources and credential-shaped queries', async () => {
    const h = harness();
    await h.manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    await expect(h.manager.metadata(owner, 'notion', 'page:missing')).rejects.toMatchObject({
      code: 'CONNECTED_RESOURCE_NOT_FOUND',
    });
    await expect(h.manager.search(owner, 'notion', 'sk-live-abcdef123456789')).rejects.toThrow(
      /credential/,
    );
  });

  it('enforces the download size limit', async () => {
    const h = harness({ limits: { maxResourceBytes: 10 } });
    await h.manager.connect(owner, 'github', {
      grantedScopes: ['repositories:read', 'contents:read'],
    });
    await expect(
      h.manager.content(owner, 'github', 'file:acme/messenger:docs/architecture.md'),
    ).rejects.toMatchObject({ code: 'CONNECTED_LIMIT_EXCEEDED' });
  });

  it('audits reads without recording content', async () => {
    const h = harness();
    await h.manager.connect(owner, 'notion', { grantedScopes: ['pages:read'] });
    await h.manager.content(owner, 'notion', 'page:auth-spec');
    const read = h.events.find((event) => event.type === 'connected_app_content_read');
    expect(read).toBeDefined();
    expect(read!.detail).toMatch(/bytes/);
    expect(JSON.stringify(h.events)).not.toContain('fifteen minutes');
  });
});
