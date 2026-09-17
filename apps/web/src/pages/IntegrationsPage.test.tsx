import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '../theme/ThemeProvider';
import { ToastProvider } from '../components/ui';
import { IntegrationsPage } from './IntegrationsPage';
import {
  checkConnectionStatus,
  createConnection,
  disableConnection,
  disconnectConnection,
  enableConnection,
  listIntegrations,
  type IntegrationView,
} from '../api/integrations';
import { ApiError } from '../api/client';

vi.mock('../api/integrations', () => ({
  listIntegrations: vi.fn(),
  createConnection: vi.fn(),
  disableConnection: vi.fn(),
  enableConnection: vi.fn(),
  disconnectConnection: vi.fn(),
  checkConnectionStatus: vi.fn(),
}));

const mockedList = vi.mocked(listIntegrations);
const mockedCreate = vi.mocked(createConnection);
const mockedDisable = vi.mocked(disableConnection);
const mockedEnable = vi.mocked(enableConnection);
const mockedDisconnect = vi.mocked(disconnectConnection);
const mockedCheck = vi.mocked(checkConnectionStatus);

function integration(overrides: Partial<IntegrationView> = {}): IntegrationView {
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    description: 'Offline deterministic storage integration.',
    version: '1.0.0',
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
        description: 'Lists objects in a bucket.',
        requiredScopes: ['storage.objects.read'],
        riskLevel: 'low',
        requiresConfirmation: false,
      },
    ],
    connections: [],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <IntegrationsPage />
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('IntegrationsPage', () => {
  it('renders the catalog with scopes, tools, and connection state', async () => {
    mockedList.mockResolvedValue([
      integration({
        connections: [
          {
            connectionId: 'conn_1',
            status: 'connected',
            accountRef: 'demo bucket',
            grantedScopes: ['storage.objects.read'],
            createdAt: '2026-09-17T08:00:00.000Z',
            lastStatusCheckAt: null,
            operationCount: 3,
          },
        ],
      }),
    ]);
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Mock Storage' })).toBeDefined();
    // The scope id appears in the catalog AND the granted-scopes row.
    expect(screen.getAllByText('storage.objects.read').length).toBeGreaterThan(0);
    expect(screen.getByText(/Read objects/)).toBeDefined();
    // Connection metadata renders as text - status is never color-only.
    expect(screen.getByText(/connected/)).toBeDefined();
    expect(screen.getByText('demo bucket')).toBeDefined();
  });

  it('shows an empty state when the catalog is empty', async () => {
    mockedList.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No integrations available')).toBeDefined();
  });

  it('shows an honest error state with retry', async () => {
    mockedList.mockRejectedValue(
      new ApiError(500, 'INTEGRATION_EXECUTION_FAILED', 'The catalog could not be read.'),
    );
    renderPage();

    expect(await screen.findByText(/catalog could not be read/i)).toBeDefined();
    mockedList.mockResolvedValue([integration()]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Mock Storage' })).toBeDefined();
    });
  });

  it('creates a connection with the explicitly selected scopes', async () => {
    mockedList.mockResolvedValue([integration()]);
    mockedCreate.mockResolvedValue({
      connectionId: 'conn_new',
      status: 'connected',
      accountRef: 'demo bucket',
      grantedScopes: ['storage.objects.read'],
      createdAt: '2026-09-17T08:00:00.000Z',
      lastStatusCheckAt: null,
      operationCount: 0,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^Connect$/i }));
    // The dialog lists the declared scopes with their risk levels.
    const writeCheckbox = await screen.findByRole('checkbox', {
      name: /storage\.objects\.write/,
    });
    fireEvent.click(writeCheckbox);
    // The page card also has a Connect button - the dialog's is the submit.
    const connectButtons = screen.getAllByRole('button', { name: /^Connect$/i });
    const dialogConnect = connectButtons[connectButtons.length - 1];
    expect(dialogConnect).toBeDefined();
    fireEvent.click(dialogConnect);
    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith('mock-storage', {
        scopes: ['storage.objects.write'],
      });
    });
  });

  it('never requests undeclared scopes from the dialog', async () => {
    mockedList.mockResolvedValue([integration()]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^Connect$/i }));
    // Scope checkboxes render from the DECLARED catalog only.
    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes.length).toBe(2);
  });

  it('disables an existing connection and reports the typed failure honestly', async () => {
    mockedList.mockResolvedValue([
      integration({
        connections: [
          {
            connectionId: 'conn_1',
            status: 'connected',
            accountRef: 'demo bucket',
            grantedScopes: ['storage.objects.read'],
            createdAt: '2026-09-17T08:00:00.000Z',
            lastStatusCheckAt: null,
            operationCount: 0,
          },
        ],
      }),
    ]);
    mockedDisable.mockRejectedValue(
      new ApiError(409, 'INTEGRATION_DISABLED', 'Integration "mock-storage" is disabled.'),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /disable/i }));
    await waitFor(() => {
      expect(mockedDisable).toHaveBeenCalledWith('mock-storage', 'conn_1');
    });
    expect(await screen.findByText(/disabled/i)).toBeDefined();
  });

  it('runs a status check on demand', async () => {
    mockedList.mockResolvedValue([
      integration({
        connections: [
          {
            connectionId: 'conn_1',
            status: 'connected',
            accountRef: 'demo bucket',
            grantedScopes: ['storage.objects.read'],
            createdAt: '2026-09-17T08:00:00.000Z',
            lastStatusCheckAt: null,
            operationCount: 0,
          },
        ],
      }),
    ]);
    mockedCheck.mockResolvedValue({
      connectionId: 'conn_1',
      status: 'connected',
      accountRef: 'demo bucket',
      grantedScopes: ['storage.objects.read'],
      createdAt: '2026-09-17T08:00:00.000Z',
      lastStatusCheckAt: '2026-09-17T08:05:00.000Z',
      operationCount: 0,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /check status/i }));
    await waitFor(() => {
      expect(mockedCheck).toHaveBeenCalledWith('mock-storage', 'conn_1');
    });
  });

  it('disconnects a connection through the API', async () => {
    mockedList.mockResolvedValue([
      integration({
        connections: [
          {
            connectionId: 'conn_1',
            status: 'connected',
            accountRef: 'demo bucket',
            grantedScopes: ['storage.objects.read'],
            createdAt: '2026-09-17T08:00:00.000Z',
            lastStatusCheckAt: null,
            operationCount: 0,
          },
        ],
      }),
    ]);
    mockedDisconnect.mockResolvedValue(undefined);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }));
    await waitFor(() => {
      expect(mockedDisconnect).toHaveBeenCalledWith('mock-storage', 'conn_1');
    });
  });

  it('offers Enable for disabled connections and re-enables through the API', async () => {
    mockedList.mockResolvedValue([
      integration({
        connections: [
          {
            connectionId: 'conn_1',
            status: 'disabled',
            accountRef: 'demo bucket',
            grantedScopes: ['storage.objects.read'],
            createdAt: '2026-09-17T08:00:00.000Z',
            lastStatusCheckAt: null,
            operationCount: 0,
          },
        ],
      }),
    ]);
    mockedEnable.mockResolvedValue({
      connectionId: 'conn_1',
      status: 'connected',
      accountRef: 'demo bucket',
      grantedScopes: ['storage.objects.read'],
      createdAt: '2026-09-17T08:00:00.000Z',
      lastStatusCheckAt: null,
      operationCount: 0,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^Enable$/i }));
    await waitFor(() => {
      expect(mockedEnable).toHaveBeenCalledWith('mock-storage', 'conn_1');
    });
  });

  it('does not offer Connect for disabled integrations', async () => {
    mockedList.mockResolvedValue([integration({ enabled: false })]);
    renderPage();

    const connectButton = await screen.findByRole('button', { name: /^Connect$/i });
    expect(connectButton.hasAttribute('disabled')).toBe(true);
  });
});
