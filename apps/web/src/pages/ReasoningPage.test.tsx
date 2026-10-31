// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ui';
import { ReasoningPage } from './ReasoningPage';
import * as api from '../api/reasoning';
import { ApiError } from '../api/client';

vi.mock('../api/reasoning', () => ({
  getCapabilities: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  decide: vi.fn(),
  getUsage: vi.fn(),
  followRun: vi.fn(),
  isTerminal: (status: string) =>
    ['completed', 'failed', 'cancelled', 'limit_reached'].includes(status),
}));

const capabilities: api.ReasoningCapabilities = {
  profiles: [
    {
      id: 'workspace',
      displayName: 'Workspace',
      description: 'Project questions answered from your workspace files and code.',
      contextKinds: ['file'],
      toolPrefixes: ['files.', 'mock.'],
    },
  ],
  limits: {
    maxIterations: 8,
    maxToolCalls: 8,
    maxDurationMs: 60000,
    maxProviderRetries: 3,
    contextBudgetChars: 24000,
  },
  ceilings: {
    maxIterations: 50,
    maxToolCalls: 50,
    maxDurationMs: 600000,
    maxProviderRetries: 10,
    contextBudgetChars: 200000,
  },
  provider: { connected: true, reason: null, modes: ['gateway', 'simulated'] },
  tools: [
    { id: 'files.read', name: 'Read file', category: 'files', riskLevel: 'low', available: true },
    {
      id: 'video.analyze',
      name: 'Analyze video',
      category: 'video',
      riskLevel: 'low',
      available: true,
    },
  ],
  simulatedReasoningAllowed: true,
};

const runFixture = (overrides: Partial<api.ReasoningRunView> = {}): api.ReasoningRunView => ({
  id: 'rsn_1',
  profile: 'workspace',
  task: 'Summarise the project.',
  status: 'running',
  steps: [],
  decisions: [],
  usage: {
    iterations: 0,
    toolCalls: 0,
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    providerLatencyMs: 0,
    latencyMs: 0,
  },
  provenance: [],
  contextDropped: [],
  limitations: [],
  createdAt: '2026-10-31T10:00:00.000Z',
  ...overrides,
});

function renderPage() {
  return render(
    <ToastProvider>
      <ReasoningPage />
    </ToastProvider>,
  );
}

describe('ReasoningPage', () => {
  beforeEach(() => {
    vi.mocked(api.getCapabilities).mockResolvedValue(capabilities);
    vi.mocked(api.followRun).mockReturnValue(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a final event that carries the terminal run', async () => {
    vi.mocked(api.startRun).mockResolvedValue(runFixture());
    let emit: ((event: api.ReasoningEvent) => void) | null = null;
    vi.mocked(api.followRun).mockImplementation((_runId, onEvent) => {
      emit = onEvent;
      return () => undefined;
    });

    renderPage();
    await screen.findByText('Run reasoning');
    fireEvent.change(screen.getByLabelText('Task'), {
      target: { value: 'Summarise the project.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run reasoning' }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalled());

    emit?.({
      type: 'final',
      at: '2026-10-31T10:00:05.000Z',
      run: runFixture({
        status: 'completed',
        answer: 'Simulated answer, no model was called.',
        provider: {
          providerId: 'simulated',
          modelId: 'simulated-reasoner',
          live: false,
          simulated: true,
        },
      }),
    });

    // The terminal outcome is shown, and the page never falls back to "unknown".
    expect(await screen.findByText('completed')).toBeDefined();
    expect(screen.queryByText('unknown')).toBeNull();
    expect(screen.getByText(/Simulated answer, no model was called\./)).toBeDefined();
  });

  it('loads the finished run when a final event arrives without one', async () => {
    vi.mocked(api.startRun).mockResolvedValue(runFixture());
    vi.mocked(api.getRun).mockResolvedValue(
      runFixture({
        status: 'completed',
        answer: 'Fetched answer.',
        provider: {
          providerId: 'simulated',
          modelId: 'simulated-reasoner',
          live: false,
          simulated: true,
        },
      }),
    );
    let emit: ((event: api.ReasoningEvent) => void) | null = null;
    vi.mocked(api.followRun).mockImplementation((_runId, onEvent) => {
      emit = onEvent;
      return () => undefined;
    });

    renderPage();
    await screen.findByText('Run reasoning');
    fireEvent.change(screen.getByLabelText('Task'), {
      target: { value: 'Summarise the project.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run reasoning' }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalled());

    emit?.({ type: 'final', at: '2026-10-31T10:00:05.000Z' });

    await waitFor(() => expect(api.getRun).toHaveBeenCalled());
    expect(await screen.findByText(/Fetched answer\./)).toBeDefined();
    // The page is still mounted after the fallback fetch: no blank screen.
    expect(screen.getByText('completed')).toBeDefined();
    expect(screen.queryByText('unknown')).toBeNull();
  });

  it('offers only the tools the selected profile may use', async () => {
    renderPage();
    expect(await screen.findByText('Read file')).toBeDefined();
    expect(screen.queryByText('Analyze video')).toBeNull();
  });

  it('does not start a run with an empty task', async () => {
    renderPage();
    await screen.findByText('Run reasoning');
    const runButton = screen.getByRole('button', { name: 'Run reasoning' }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);
    fireEvent.click(runButton);
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it('starts a run and renders the streamed answer', async () => {
    vi.mocked(api.startRun).mockResolvedValue(runFixture());
    let emit: ((event: api.ReasoningEvent) => void) | null = null;
    vi.mocked(api.followRun).mockImplementation((_runId, onEvent) => {
      emit = onEvent;
      return () => undefined;
    });

    renderPage();
    await screen.findByText('Run reasoning');
    fireEvent.change(screen.getByLabelText('Task'), {
      target: { value: 'Summarise the project.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run reasoning' }));

    await waitFor(() => expect(api.startRun).toHaveBeenCalled());
    expect(vi.mocked(api.startRun).mock.calls[0]?.[0]).toMatchObject({
      task: 'Summarise the project.',
      profile: 'workspace',
      mode: 'gateway',
    });

    emit?.({ type: 'phase', at: '2026-10-31T10:00:01.000Z', phase: 'plan' });
    emit?.({ type: 'delta', at: '2026-10-31T10:00:02.000Z', text: 'The project ' });
    emit?.({ type: 'delta', at: '2026-10-31T10:00:03.000Z', text: 'parses documents.' });

    expect(await screen.findByText(/The project parses documents\./)).toBeDefined();
    expect(screen.getByText('Plan')).toBeDefined();
  });

  it('labels a simulated answer as simulated', async () => {
    vi.mocked(api.getCapabilities).mockResolvedValue({
      ...capabilities,
      provider: {
        connected: false,
        reason: 'No AI provider is connected yet.',
        modes: ['simulated'],
      },
    });
    vi.mocked(api.startRun).mockResolvedValue(
      runFixture({
        provider: {
          providerId: 'mock-reasoning',
          modelId: 'simulated-reasoning',
          live: false,
          simulated: true,
        },
      }),
    );

    renderPage();
    await screen.findByText('No provider');
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run reasoning' }));

    await waitFor(() =>
      expect(vi.mocked(api.startRun).mock.calls[0]?.[0]).toMatchObject({ mode: 'simulated' }),
    );
    expect(await screen.findByText('Simulated')).toBeDefined();
    expect(screen.queryByText('Live model')).toBeNull();
  });

  it('shows the failure message instead of inventing an answer', async () => {
    vi.mocked(api.startRun).mockResolvedValue(
      runFixture({
        status: 'failed',
        error: { code: 'REASONING_PROVIDER_ERROR', message: 'The provider refused the request.' },
      }),
    );

    renderPage();
    await screen.findByText('Run reasoning');
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run reasoning' }));

    expect(await screen.findByText('The provider refused the request.')).toBeDefined();
    expect(screen.queryByText(/No answer yet/)).toBeNull();
  });

  it('asks for a decision before a risky tool runs', async () => {
    vi.mocked(api.startRun).mockResolvedValue(
      runFixture({
        status: 'awaiting_confirmation',
        pendingConfirmation: {
          confirmationId: 'cnf_1',
          toolId: 'mock.purge',
          riskLevel: 'critical',
        },
      }),
    );
    vi.mocked(api.decide).mockResolvedValue(runFixture({ status: 'running' }));

    renderPage();
    await screen.findByText('Run reasoning');
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Clean up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run reasoning' }));

    expect(await screen.findByText('Waiting for your decision')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('rsn_1', 'cnf_1', 'approved'));
  });

  it('reports a start failure without a phantom run', async () => {
    vi.mocked(api.startRun).mockRejectedValue(
      new ApiError(409, 'GATEWAY_NO_PROVIDER_CONFIGURED', 'Connect an AI provider in Settings.'),
    );

    renderPage();
    await screen.findByText('Run reasoning');
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run reasoning' }));

    expect(await screen.findByText(/Connect an AI provider in Settings\./)).toBeDefined();
    expect(screen.queryByText('Run')).toBeNull();
  });
});
