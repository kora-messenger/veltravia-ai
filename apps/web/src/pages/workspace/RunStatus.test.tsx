import { afterEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RunStatus } from './RunStatus';
import type { AgentRunUiState } from './use-agent-run';

afterEach(() => cleanup());

function state(overrides: Partial<AgentRunUiState> = {}): AgentRunUiState {
  return {
    phase: 'running',
    prompt: 'Explain the project',
    runId: 'run-1',
    finalOutput: null,
    failureMessage: null,
    cancellable: true,
    retryable: false,
    pollingPaused: false,
    cancelError: null,
    ...overrides,
  };
}

function renderStatus(
  overrides: Partial<AgentRunUiState> = {},
  handlers: Partial<{ onRetry: () => void; onCancel: () => void; onRefresh: () => void }> = {},
) {
  const onRetry = handlers.onRetry ?? vi.fn();
  const onCancel = handlers.onCancel ?? vi.fn();
  const onRefresh = handlers.onRefresh ?? vi.fn();
  render(
    <RunStatus
      state={state(overrides)}
      onRetry={onRetry}
      onCancel={onCancel}
      onRefresh={onRefresh}
    />,
  );
  return { onRetry, onCancel, onRefresh };
}

describe('RunStatus', () => {
  it('renders nothing when idle or completed', () => {
    const { unmount } = render(
      <RunStatus
        state={state({ phase: 'idle' })}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    unmount();
    render(
      <RunStatus
        state={state({ phase: 'completed' })}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces creating and running states accessibly with a cancel control only when live', () => {
    renderStatus({ phase: 'creating', cancellable: false });
    expect(screen.getByText('Starting your run…')).toBeDefined();
    expect(screen.queryByRole('button', { name: /cancel run/i })).toBeNull();
    cleanup();
    const { onCancel: cancel2 } = renderStatus({ phase: 'running' });
    expect(screen.getByText('Working…')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /cancel run/i }));
    expect(cancel2).toHaveBeenCalledTimes(1);
  });

  it('offers a manual check once bounded polling pauses, without stopping the run', () => {
    const { onRefresh } = renderStatus({ phase: 'running', pollingPaused: true });
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /cancel run/i })).toBeDefined();
  });

  it('shows the paused state honestly and points at the approval card', () => {
    renderStatus({ phase: 'paused' });
    expect(screen.getByText(/waiting for a required confirmation/i)).toBeDefined();
    expect(screen.getByText(/approve or reject the request below/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /cancel run/i })).toBeDefined();
  });

  it('shows a server-confirmed cancelled state with retry', () => {
    const { onRetry } = renderStatus({ phase: 'cancelled', retryable: true, cancellable: false });
    expect(screen.getByText(/cancelled — this run stopped at your request/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows failed states as alerts with the server failure message', () => {
    renderStatus({
      phase: 'failed',
      failureMessage: 'This run failed: The model could not be reached.',
      cancellable: false,
      retryable: true,
    });
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText(/the model could not be reached/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  it('shows limit-reached and client-side error states with retry', () => {
    renderStatus({
      phase: 'limit-reached',
      failureMessage: 'This run reached a safety limit: iteration budget',
      retryable: true,
    });
    expect(screen.getByText(/stopped — this run reached a safety limit/i)).toBeDefined();
    cleanup();
    renderStatus({
      phase: 'error',
      failureMessage: 'Cannot reach the Veltravia AI service. Your message was not answered.',
      retryable: true,
    });
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  it('surfaces a failed cancellation without destroying run state', () => {
    renderStatus({
      phase: 'running',
      cancelError: 'Cancellation did not go through. The run keeps its latest known state.',
    });
    expect(screen.getByText(/cancellation did not go through/i)).toBeDefined();
    expect(screen.getByText('Working…')).toBeDefined();
  });
});
