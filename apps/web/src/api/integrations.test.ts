import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkConnectionStatus,
  createConnection,
  disableConnection,
  disconnectConnection,
  enableConnection,
  getIntegration,
  listIntegrations,
} from './integrations';
import { ApiError, apiRequest } from './client';

vi.mock('./client', async (importOriginal) => ({
  // Keep the real ApiError; only the transport is mocked.
  ...(await importOriginal<typeof import('./client')>()),
  apiRequest: vi.fn(),
}));

const mockedRequest = vi.mocked(apiRequest);

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const RAW_INTEGRATION = {
  id: 'mock-storage',
  name: 'Mock Storage',
  description: 'Offline deterministic storage integration.',
  version: '1.2.0',
  publisher: 'Veltravia',
  category: 'storage',
  capabilities: ['storage'],
  enabled: true,
  scopes: [
    { id: 'storage.objects.read', description: 'Read objects', riskLevel: 'low' },
    { id: 'storage.objects.write', description: 'Write objects', riskLevel: 'medium' },
  ],
  tools: [
    {
      id: 'storage.objects.list',
      name: 'List objects',
      description: 'Lists objects.',
      requiredScopes: ['storage.objects.read'],
      riskLevel: 'low',
      requiresConfirmation: false,
    },
  ],
  connections: [
    {
      connectionId: 'conn_1',
      status: 'connected',
      accountRef: 'demo bucket',
      grantedScopes: ['storage.objects.read'],
      createdAt: '2026-09-17T08:00:00.000Z',
      lastStatusCheckAt: '2026-09-17T08:05:00.000Z',
      operationCount: 3,
    },
  ],
};

const RAW_CONNECTION = {
  connectionId: 'conn_1',
  status: 'connected',
  accountRef: 'demo bucket',
  grantedScopes: ['storage.objects.read'],
  createdAt: '2026-09-17T08:00:00.000Z',
  operationCount: 0,
};

describe('integration api client', () => {
  it('maps the catalog into strict view models', async () => {
    mockedRequest.mockResolvedValue({ integrations: [RAW_INTEGRATION] });
    const integrations = await listIntegrations();

    expect(integrations.length).toBe(1);
    const integration = integrations[0];
    if (integration === undefined) throw new Error('missing integration');
    expect(integration.id).toBe('mock-storage');
    expect(integration.scopes.length).toBe(2);
    expect(integration.tools[0]?.riskLevel).toBe('low');
    expect(integration.connections[0]?.status).toBe('connected');
    expect(integration.connections[0]?.operationCount).toBe(3);
  });

  it('rejects malformed payloads instead of rendering unknown data', async () => {
    mockedRequest.mockResolvedValue({ integrations: [{ id: 42 }] });
    await expect(listIntegrations()).rejects.toThrow(/Invalid integration payload/);
  });

  it('rejects a non-array catalog', async () => {
    mockedRequest.mockResolvedValue({ integrations: 'nope' });
    await expect(listIntegrations()).rejects.toThrow(/Invalid integration list payload/);
  });

  it('falls back safely on optional fields with unexpected shapes', async () => {
    mockedRequest.mockResolvedValue({
      ...RAW_INTEGRATION,
      version: 3,
      capabilities: 'storage',
      connections: [{ connectionId: 'conn_2', status: 'weird', operationCount: 'many' }],
    });
    const integration = await getIntegration('mock-storage');

    expect(integration.version).toBe('');
    expect(integration.capabilities.length).toBe(0);
    expect(integration.connections[0]?.status).toBe('error');
    expect(integration.connections[0]?.operationCount).toBe(0);
  });

  it('creates a connection with explicit scopes', async () => {
    mockedRequest.mockResolvedValue(RAW_CONNECTION);
    const connection = await createConnection('mock-storage', {
      scopes: ['storage.objects.read'],
      accountRef: 'demo bucket',
    });

    expect(mockedRequest).toHaveBeenCalledWith('/api/integrations/mock-storage/connections', {
      method: 'POST',
      body: { scopes: ['storage.objects.read'], accountRef: 'demo bucket' },
    });
    expect(connection.connectionId).toBe('conn_1');
  });

  it('surfaces typed API errors untouched', async () => {
    mockedRequest.mockRejectedValue(
      new ApiError(409, 'CONNECTION_LIMIT_REACHED', 'Connection limit reached.'),
    );
    await expect(
      createConnection('mock-storage', { scopes: ['storage.objects.read'] }),
    ).rejects.toThrow(/Connection limit reached/);
  });

  it('encodes ids into lifecycle paths', async () => {
    mockedRequest.mockResolvedValue(RAW_CONNECTION);
    await disableConnection('mock storage', 'conn 1');
    await enableConnection('mock-storage', 'conn_1');
    await checkConnectionStatus('mock-storage', 'conn_1');
    await disconnectConnection('mock-storage', 'conn_1');

    expect(mockedRequest).toHaveBeenNthCalledWith(
      1,
      '/api/integrations/mock%20storage/connections/conn%201/disable',
      { method: 'POST' },
    );
    expect(mockedRequest).toHaveBeenNthCalledWith(
      4,
      '/api/integrations/mock-storage/connections/conn_1',
      { method: 'DELETE' },
    );
  });
});
