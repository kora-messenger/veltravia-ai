// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ConnectionsPage } from './ConnectionsPage';
import { ApiError } from '../api/client';
import * as api from '../api/connections';

vi.mock('../api/connections', () => ({
  getConnections: vi.fn(),
  getConnectionHealth: vi.fn(),
  createSession: vi.fn(),
  completeConnection: vi.fn(),
  disconnect: vi.fn(),
  listResources: vi.fn(),
  searchResources: vi.fn(),
  getContent: vi.fn(),
  getAnalysis: vi.fn(),
}));

const github = {
  id: 'github',
  name: 'GitHub',
  description: 'Search repositories, read files and issues.',
  liveCapable: true,
  mode: 'mock' as const,
  capabilities: ['resources.list'],
  scopes: [
    { id: 'repositories:read', description: 'List repositories.', risk: 'low' as const },
    { id: 'contents:read', description: 'Read file contents.', risk: 'low' as const },
  ],
  connected: false,
};

const notionConnected = {
  providerId: 'notion',
  providerName: 'Notion',
  status: 'connected' as const,
  account: { accountId: 'acc-1', displayName: 'Veltravia Workspace', email: null },
  grantedScopes: ['pages:read'],
  capabilities: ['resources.list'],
  connectedAt: '2026-10-30T10:00:00.000Z',
  lastCheckedAt: null,
  liveCapable: false,
};

const provenance = {
  providerId: 'notion',
  providerName: 'Notion',
  accountId: 'acc-1',
  resourceId: 'page:auth-spec',
  resourceName: 'Authentication Specification',
  sourceUrl: null,
  retrievedAt: '2026-10-30T10:01:00.000Z',
  revision: 'page-auth-4',
};

const notionProvider = {
  id: 'notion',
  name: 'Notion',
  description: 'Read pages and databases from a workspace.',
  liveCapable: false,
  mode: 'mock' as const,
  capabilities: ['resources.list'],
  scopes: [{ id: 'pages:read', description: 'Read pages.', risk: 'low' as const }],
  connected: true,
};

const connectedOverview = {
  providers: [github, notionProvider],
  connections: [notionConnected],
  githubAllowedRepositories: [] as string[],
};

const resource = {
  providerId: 'notion',
  resourceId: 'page:auth-spec',
  kind: 'page',
  name: 'Authentication Specification',
  path: null,
  mimeType: 'text/markdown',
  byteSize: 320,
  modifiedAt: null,
  revision: 'page-auth-4',
  url: null,
  provenance,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getConnections).mockResolvedValue({
    providers: [github],
    connections: [],
    githubAllowedRepositories: [],
  });
  vi.mocked(api.getConnectionHealth).mockResolvedValue({
    providerId: 'notion',
    status: 'connected',
    healthy: true,
    detail: 'Responding.',
    checkedAt: '2026-10-30T10:00:00.000Z',
  });
  vi.mocked(api.createSession).mockResolvedValue({
    providerId: 'github',
    mode: 'mock',
    authorization: {
      kind: 'simulated',
      reason: 'This provider runs a deterministic simulation in this build.',
    },
    scopes: github.scopes,
  });
  vi.mocked(api.completeConnection).mockResolvedValue({ connection: notionConnected });
  vi.mocked(api.disconnect).mockResolvedValue({ disconnected: true });
  vi.mocked(api.listResources).mockResolvedValue({
    resources: [resource],
    nextCursor: null,
    truncated: false,
  });
  vi.mocked(api.searchResources).mockResolvedValue({
    resources: [],
    nextCursor: null,
    truncated: false,
  });
  vi.mocked(api.getContent).mockResolvedValue({
    text: '# Authentication Specification\n\nRefresh tokens rotate on every use.',
    mimeType: 'text/markdown',
    byteSize: 320,
    provenance,
    fromCache: false,
    ageSeconds: 0,
    trustTag: 'untrusted_data',
  });
  vi.mocked(api.getAnalysis).mockResolvedValue({
    provenance,
    format: 'markdown',
    byteSize: 320,
    elementCount: 6,
    tableCount: 1,
    headings: ['Authentication Specification'],
    textPreview: 'Refresh tokens rotate',
    truncated: false,
  });
});

afterEach(() => cleanup());

describe('ConnectionsPage', () => {
  it('offers a connect action for a provider that is not connected', async () => {
    render(<ConnectionsPage />);
    expect(await screen.findByRole('button', { name: /connect github/i })).toBeDefined();
    expect(screen.getByText(/Simulated provider/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull();
  });

  it('lists granted scopes and account for a connected provider', async () => {
    vi.mocked(api.getConnections).mockResolvedValue(connectedOverview);
    render(<ConnectionsPage />);
    expect(await screen.findByText('Veltravia Workspace')).toBeDefined();
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pages:read/).length).toBeGreaterThan(0);
    expect(await screen.findByText('Responding')).toBeDefined();
  });

  it('shows the honest simulated-authorization note before connecting', async () => {
    render(<ConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /connect github/i }));
    expect(await screen.findByText(/deterministic simulation in this build/i)).toBeDefined();
    expect(screen.getAllByText(/repositories:read/).length).toBeGreaterThan(0);
  });

  it('connects with the selected scopes and refreshes the list', async () => {
    render(<ConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /connect github/i }));
    const authorize = await screen.findByRole('button', { name: /authorize/i });
    fireEvent.click(authorize);
    await waitFor(() => expect(api.completeConnection).toHaveBeenCalled());
    expect(vi.mocked(api.completeConnection).mock.calls[0][0]).toBe('github');
    expect(vi.mocked(api.completeConnection).mock.calls[0][1]).toEqual([
      'repositories:read',
      'contents:read',
    ]);
    expect(await screen.findByRole('status')).toBeDefined();
  });

  it('browses connected resources and shows provenance for a selection', async () => {
    vi.mocked(api.getConnections).mockResolvedValue(connectedOverview);
    render(<ConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /browse resources/i }));
    const item = await screen.findByRole('button', {
      name: /inspect authentication specification/i,
    });
    fireEvent.click(item);
    expect(await screen.findByText(/Refresh tokens rotate on every use/)).toBeDefined();
    expect(screen.getByText('untrusted data', { exact: false })).toBeDefined();
    expect(screen.getByText('page-auth-4')).toBeDefined();
    expect(screen.getByText(/markdown · 6 elements/)).toBeDefined();
  });

  it('reports a failed connection honestly', async () => {
    vi.mocked(api.completeConnection).mockRejectedValue(
      new ApiError(403, 'CONNECTED_INSUFFICIENT_SCOPE', 'That permission is not offered.'),
    );
    render(<ConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /connect github/i }));
    fireEvent.click(await screen.findByRole('button', { name: /authorize/i }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('That permission is not offered.');
  });

  it('treats an empty resource list as empty, not broken', async () => {
    vi.mocked(api.getConnections).mockResolvedValue(connectedOverview);
    vi.mocked(api.searchResources).mockResolvedValue({
      resources: [],
      nextCursor: null,
      truncated: false,
    });
    render(<ConnectionsPage />);
    fireEvent.change(await screen.findByLabelText(/search connected resources/i), {
      target: { value: 'nothing' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /browse resources/i }));
    expect(await screen.findByText(/no resources matched that search/i)).toBeDefined();
  });
});
