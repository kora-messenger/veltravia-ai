// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ui';
import { ExecutePage } from './ExecutePage';
import * as api from '../api/ai-execution';
import { ApiError } from '../api/client';

vi.mock('../api/ai-execution', () => ({
  getExecutionCapabilities: vi.fn(),
  getExecutionUsage: vi.fn(),
  startExecution: vi.fn(),
  cancelExecutionRun: vi.fn(),
}));

const capabilities: api.ExecutionCapabilities = {
  ready: true,
  blockedReason: null,
  categories: ['general-conversation'],
  limits: { maxOutputTokens: 8192, maxHistoryMessages: 20 },
};

function renderPage() {
  return render(
    <ToastProvider>
      <ExecutePage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getExecutionCapabilities).mockResolvedValue(capabilities);
  vi.mocked(api.getExecutionUsage).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('model runs page: states', () => {
  it('shows readiness and an honest empty usage state', async () => {
    renderPage();
    expect(await screen.findByText('Ready')).toBeDefined();
    expect(screen.getByText(/No runs yet/i)).toBeDefined();
  });

  it('says so when no provider is connected, instead of pretending to be ready', async () => {
    vi.mocked(api.getExecutionCapabilities).mockResolvedValue({
      ...capabilities,
      ready: false,
      blockedReason: 'Connect an AI provider to run a model.',
    });
    renderPage();
    expect(await screen.findByText(/Connect an AI provider/i)).toBeDefined();
    expect(screen.getByText('No provider')).toBeDefined();
  });

  it('shows a readable error when capabilities cannot be loaded', async () => {
    vi.mocked(api.getExecutionCapabilities).mockRejectedValue(
      new ApiError('The service is unreachable.', 503, 'UNAVAILABLE'),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  it('refuses to run an empty task', async () => {
    renderPage();
    await screen.findByText('Ready');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    expect(api.startExecution).not.toHaveBeenCalled();
  });
});

describe('model runs page: a streaming run', () => {
  it('renders the streamed answer, the route and the reported usage', async () => {
    vi.mocked(api.startExecution).mockImplementation(async (_input, handlers) => {
      handlers.onRunId?.('run-1');
      handlers.onEvent({ type: 'progress', stage: 'routing', message: 'Choosing a model' });
      handlers.onEvent({
        type: 'route.selected',
        providerId: 'openai',
        providerName: 'OpenAI',
        modelId: 'gpt-test-mini',
        summary: 'Chose OpenAI gpt-test-mini because it is your connected default.',
        contextWindowTokens: 128_000,
        streaming: true,
      });
      handlers.onEvent({
        type: 'context.prepared',
        estimatedInputTokens: 12,
        truncated: false,
        droppedMessages: 0,
        notes: [],
      });
      handlers.onEvent({ type: 'delta', text: 'The answer ' });
      handlers.onEvent({ type: 'delta', text: 'is 42.' });
      handlers.onEvent({
        type: 'usage',
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        usageSource: 'provider-confirmed',
        estimatedCostUsd: null,
        costSource: 'unavailable',
        latencyMs: 120,
        streamed: true,
      });
      handlers.onEvent({
        type: 'run.completed',
        content: 'The answer is 42.',
        finishReason: 'stop',
        latencyMs: 120,
        providerId: 'openai',
        modelId: 'gpt-test-mini',
        streamed: true,
      });
    });

    renderPage();
    await screen.findByText('Ready');
    fireEvent.change(screen.getByLabelText(/What should the model do/i), {
      target: { value: 'What is the answer?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => {
      expect(screen.getByTestId('execute-answer').textContent).toBe('The answer is 42.');
    });
    expect(screen.getByTestId('execute-route').textContent).toContain('OpenAI');
    expect(screen.getByTestId('execute-route').textContent).toContain('gpt-test-mini');
    expect(screen.getByTestId('execute-tokens').textContent).toContain('14 total');
    // No declared price means no invented cost.
    expect(screen.getByText(/No price is declared for this model/i)).toBeDefined();
    expect(api.startExecution).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed run failed and explains that nothing replaced the answer', async () => {
    vi.mocked(api.startExecution).mockImplementation(async (_input, handlers) => {
      handlers.onEvent({
        type: 'run.failed',
        code: 'GATEWAY_RATE_LIMITED',
        message: 'The provider is rate limiting this key.',
      });
    });

    renderPage();
    await screen.findByText('Ready');
    fireEvent.change(screen.getByLabelText(/What should the model do/i), {
      target: { value: 'anything' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    expect(await screen.findByText(/rate limiting this key/i)).toBeDefined();
    expect(screen.getByText(/Nothing was substituted/i)).toBeDefined();
  });

  it('offers a stop that cancels the run on the server', async () => {
    let release: (() => void) | undefined;
    vi.mocked(api.startExecution).mockImplementation(async (_input, handlers) => {
      handlers.onRunId?.('run-9');
      handlers.onEvent({ type: 'delta', text: 'partial ' });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    vi.mocked(api.cancelExecutionRun).mockResolvedValue(undefined);

    renderPage();
    await screen.findByText('Ready');
    fireEvent.change(screen.getByLabelText(/What should the model do/i), {
      target: { value: 'a long task' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    const stop = await screen.findByRole('button', { name: /^Stop$/ });
    fireEvent.click(stop);
    await waitFor(() => {
      expect(api.cancelExecutionRun).toHaveBeenCalledWith('run-9');
    });
    release?.();
    // Whatever arrived before the stop is still shown, not thrown away.
    expect(screen.getByTestId('execute-answer').textContent).toBe('partial ');
  });

  it('lists this owner’s recent usage with cost provenance', async () => {
    vi.mocked(api.getExecutionUsage).mockResolvedValue([
      {
        id: 'use-1',
        providerId: 'openai',
        modelId: 'gpt-test-mini',
        status: 'success',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        usageSource: 'provider-confirmed',
        estimatedCostUsd: 0.0021,
        costSource: 'declared-pricing',
        latencyMs: 900,
        streamed: true,
        requestedAt: '2026-10-31T10:00:00.000Z',
      },
      {
        id: 'use-2',
        providerId: 'openai',
        modelId: 'gpt-test-mini',
        status: 'failure',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        usageSource: 'unavailable',
        estimatedCostUsd: null,
        costSource: 'unavailable',
        latencyMs: 30,
        streamed: false,
        requestedAt: '2026-10-31T10:05:00.000Z',
      },
    ]);

    renderPage();
    expect(await screen.findByText(/120 tokens/)).toBeDefined();
    expect(screen.getByText('$0.0021')).toBeDefined();
    expect(screen.getByText(/failure \(no tokens reported\)/i)).toBeDefined();
    expect(screen.getByText(/cost unknown/i)).toBeDefined();
  });
});
