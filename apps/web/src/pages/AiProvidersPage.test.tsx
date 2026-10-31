// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AiProvidersPage, verifyFailureReason } from './AiProvidersPage';
import * as api from '../api/ai-providers';

vi.mock('../api/ai-providers', () => ({
  getProviders: vi.fn(),
  createConnection: vi.fn(),
  validateConnection: vi.fn(),
  listModels: vi.fn(),
  updateConnection: vi.fn(),
  replaceCredential: vi.fn(),
  deleteConnection: vi.fn(),
  savePreferences: vi.fn(),
  getUsage: vi.fn(),
}));

const catalogEntry = {
  id: 'openai',
  displayName: 'OpenAI',
  description: 'Chat and reasoning models with an OpenAI-compatible API.',
  capabilities: ['chat'] as const,
  modelCapabilities: ['chat'] as const,
  allowsCustomBaseUrl: false,
  supportsDiscovery: true,
  docsUrl: 'https://platform.openai.com/api-keys',
  authFormat: 'bearer',
};

const connection = {
  id: 'conn-1',
  providerId: 'openai',
  providerName: 'OpenAI',
  displayName: 'Work key',
  status: 'active' as const,
  modelIds: ['gpt-test-mini'],
  defaultModelId: 'gpt-test-mini',
  credentialHint: '••••0000',
  baseUrl: null,
  createdAt: '2026-10-31T09:00:00.000Z',
  updatedAt: '2026-10-31T09:00:00.000Z',
  lastValidatedAt: null,
  lastErrorCategory: null,
  models: [
    {
      providerId: 'openai',
      modelId: 'gpt-test-mini',
      displayName: 'gpt-test-mini',
      capabilities: ['chat'] as const,
      available: true,
      source: 'manual' as const,
    },
  ],
  isDefault: true,
  healthy: null,
};

function readyOverview(overrides: Partial<api.ProvidersOverview> = {}): api.ProvidersOverview {
  return {
    ready: true,
    blockedReason: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersions: [1] },
    providers: [],
    preferences: { defaultConnectionId: null, defaultModelId: null, projects: {} },
    catalog: [catalogEntry],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getProviders).mockResolvedValue(readyOverview());
  vi.mocked(api.getUsage).mockResolvedValue({ usage: [], costAvailable: false });
  vi.mocked(api.createConnection).mockResolvedValue({ connection });
  vi.mocked(api.validateConnection).mockResolvedValue({ valid: true, errorCategory: null });
  vi.mocked(api.updateConnection).mockResolvedValue({ connection });
  vi.mocked(api.replaceCredential).mockResolvedValue({ connection });
  vi.mocked(api.deleteConnection).mockResolvedValue(undefined);
  vi.mocked(api.savePreferences).mockResolvedValue({
    defaultConnectionId: 'conn-1',
    defaultModelId: 'gpt-test-mini',
    projects: {},
  });
});

afterEach(() => cleanup());

describe('AiProvidersPage', () => {
  it('explains the blocker instead of showing an empty list when encryption is missing', async () => {
    vi.mocked(api.getProviders).mockResolvedValue({
      ...readyOverview(),
      ready: false,
      blockedReason: 'Set VELTRAVIA_CREDENTIAL_KEY to enable provider credentials.',
      encryption: { algorithm: null, keyVersions: [] },
    });
    const { container } = render(<AiProvidersPage />);
    await screen.findByText('Keys cannot be stored yet');
    expect((await screen.findAllByText(/VELTRAVIA_CREDENTIAL_KEY/)).length).toBeGreaterThan(0);
    // The page must not offer a connect button it cannot honour.
    expect(container.querySelector('.v-ai__toolbar')).toBeNull();
  });

  it('says plainly that no provider is connected and nothing is shared', async () => {
    render(<AiProvidersPage />);
    await screen.findByText('No provider connected');
    expect(screen.getByRole('button', { name: /Connect a provider/ })).toBeDefined();
    expect(screen.getByText(/nothing falls back to a shared key/i)).toBeDefined();
  });

  it('connects a provider with the key typed once and reports it as stored encrypted', async () => {
    vi.mocked(api.getProviders).mockResolvedValue(readyOverview());
    render(<AiProvidersPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect a provider/ }));

    fireEvent.change(await screen.findByLabelText(/API key/i), {
      target: { value: 'sk-test-1234567890' },
    });
    fireEvent.change(screen.getByLabelText(/Label \(optional\)/i), {
      target: { value: 'Work key' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save key/ }));

    await waitFor(() => expect(api.createConnection).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createConnection).mock.calls[0][0]).toEqual({
      providerId: 'openai',
      apiKey: 'sk-test-1234567890',
      displayName: 'Work key',
    });
    expect(await screen.findByText(/connected\. The key is stored encrypted/i)).toBeDefined();
  });

  it('shows the masked hint and never the key for an existing connection', async () => {
    vi.mocked(api.getProviders).mockResolvedValue(
      readyOverview({
        providers: [connection],
        preferences: {
          defaultConnectionId: 'conn-1',
          defaultModelId: 'gpt-test-mini',
          projects: {},
        },
      }),
    );
    render(<AiProvidersPage />);
    await screen.findByText('Work key');
    expect(screen.getByText(/key ••••0000/)).toBeDefined();
    // The card label carries the default marker exactly once.
    expect(screen.getByText(/OpenAI · key ••••0000 · default/)).toBeDefined();
    expect(document.body.textContent).not.toContain('sk-');
  });

  it('verifies a connection and reports how many models answered', async () => {
    vi.mocked(api.getProviders).mockResolvedValue(readyOverview({ providers: [connection] }));
    render(<AiProvidersPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Verify$/ }));
    expect(await screen.findByText(/responded\. 1 model available/i)).toBeDefined();
    expect(api.validateConnection).toHaveBeenCalledWith('conn-1');
  });

  it('reports a failed verification honestly', async () => {
    vi.mocked(api.getProviders).mockResolvedValue(readyOverview({ providers: [connection] }));
    // The API reports a normalized category, not provider text.
    vi.mocked(api.validateConnection).mockResolvedValue({
      valid: false,
      errorCategory: 'GATEWAY_AUTH_FAILED',
    });
    render(<AiProvidersPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Verify$/ }));
    expect(
      await screen.findByText(/could not be verified: the provider rejected the key\./i),
    ).toBeDefined();
  });

  it('confirms removal and warns what stops working', async () => {
    vi.mocked(api.getProviders).mockResolvedValue(readyOverview({ providers: [connection] }));
    render(<AiProvidersPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }));
    await screen.findByText(/and its storage key are removed/i);
    // The confirm button lives inside the dialog, which also carries the title.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Remove$/ }));
    await waitFor(() => expect(api.deleteConnection).toHaveBeenCalledWith('conn-1'));
    expect(
      await screen.findByText(/Agents and documents will refuse to run on your provider/i),
    ).toBeDefined();
  });

  it('records usage without prompt or answer content and flags missing cost', async () => {
    vi.mocked(api.getProviders).mockResolvedValue(readyOverview({ providers: [connection] }));
    vi.mocked(api.getUsage).mockResolvedValue({
      costAvailable: false,
      usage: [
        {
          id: 'u1',
          providerId: 'openai',
          modelId: 'gpt-test-mini',
          requestedAt: '2026-10-31T10:00:00.000Z',
          status: 'success',
          inputTokens: 12,
          outputTokens: 7,
          estimatedCostUsd: null,
          latencyMs: 42,
          live: true,
        },
        {
          id: 'u2',
          providerId: 'openai',
          modelId: 'gpt-test-mini',
          requestedAt: '2026-10-31T10:01:00.000Z',
          status: 'failure',
          inputTokens: null,
          outputTokens: null,
          estimatedCostUsd: null,
          latencyMs: 9,
          errorCategory: 'auth',
          live: true,
        },
      ],
    });
    render(<AiProvidersPage />);
    await screen.findByText(/Latest 2 calls/);
    expect(screen.getByText(/cost not estimated/)).toBeDefined();
    expect(screen.getByText('Success (live)')).toBeDefined();
    expect(screen.getByText('Failed (auth)')).toBeDefined();
    expect(screen.getByText('12 in / 7 out')).toBeDefined();
    expect(screen.getByText('Not reported')).toBeDefined();
  });

  it('surfaces a load failure instead of an empty page', async () => {
    vi.mocked(api.getProviders).mockRejectedValue(new Error('network down'));
    render(<AiProvidersPage />);
    expect(await screen.findByRole('alert')).toBeDefined();
  });
});

describe('verifyFailureReason', () => {
  it('names every normalized category in plain language', () => {
    expect(verifyFailureReason('GATEWAY_AUTH_FAILED')).toContain('rejected the key');
    expect(verifyFailureReason('GATEWAY_TIMEOUT')).toContain('did not answer in time');
    expect(verifyFailureReason('GATEWAY_UNSAFE_ENDPOINT')).toContain('security check');
    expect(verifyFailureReason(null)).toContain('did not confirm the key');
    // An unknown category falls back instead of rendering a raw code.
    expect(verifyFailureReason('SOMETHING_NEW')).not.toContain('SOMETHING_NEW');
  });
});
