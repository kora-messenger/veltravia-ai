// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { AgentProfileProvider } from '../../agent/AgentProfileProvider';

const startRun = vi.fn();
const getCapabilities = vi.fn();
const getRun = vi.fn();
const cancelRun = vi.fn();

vi.mock('../../api/reasoning', () => ({
  startRun: (input: unknown) => startRun(input),
  getCapabilities: () => getCapabilities(),
  getRun: (id: string) => getRun(id),
  cancelRun: (id: string) => cancelRun(id),
  isTerminal: (status: string) =>
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'limit_reached',
}));

const { ChatPage } = await import('./ChatPage');

const capabilities = (connected: boolean) => ({
  profiles: [],
  limits: {
    maxIterations: 8,
    maxToolCalls: 8,
    maxDurationMs: 60000,
    maxProviderRetries: 1,
    contextBudgetChars: 8000,
  },
  ceilings: {
    maxIterations: 50,
    maxToolCalls: 50,
    maxDurationMs: 600000,
    maxProviderRetries: 3,
    contextBudgetChars: 32000,
  },
  provider: { connected, reason: null, modes: ['gateway', 'simulated'] },
  tools: [],
  simulatedReasoningAllowed: true,
});

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  profile: 'workspace',
  task: 'question',
  status: 'completed',
  steps: [],
  decisions: [],
  answer: 'Here is what I found.',
  usage: {
    iterations: 1,
    toolCalls: 0,
    modelCalls: 1,
    inputTokens: 10,
    outputTokens: 5,
    providerLatencyMs: 120,
    latencyMs: 150,
  },
  provenance: [],
  contextDropped: [],
  limitations: [],
  createdAt: new Date().toISOString(),
  ...overrides,
});

const renderPage = () =>
  render(
    <ToastProvider>
      <ChatPage />
    </ToastProvider>,
  );

beforeEach(() => {
  startRun.mockReset();
  getCapabilities.mockReset();
  getRun.mockReset();
  cancelRun.mockReset();
  getCapabilities.mockResolvedValue(capabilities(false));
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the chat landing page', () => {
  it('greets without inventing a name and offers real destinations', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Hey there');
    expect(await screen.findByText('Start something new from an empty project')).toBeDefined();
    expect(screen.getByText('Ask questions about your own documents')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open the app builder' })).toBeDefined();
  });

  it('uses the name the owner gave, and no name when they gave none', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            profile: {
              agentName: 'Ada',
              ownerName: 'Ijezie',
              isDefault: false,
              updatedAt: '2026-11-02T10:00:00.000Z',
            },
            limits: { maxLength: 40 },
            persistence: { durable: false, note: '' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    render(
      <ToastProvider>
        <AgentProfileProvider
          client={{ fetchImpl: fetchImpl as unknown as typeof fetch, ownerRef: 'owner-1' }}
        >
          <ChatPage />
        </AgentProfileProvider>
      </ToastProvider>,
    );
    expect(await screen.findByText(/Hey Ijezie/)).toBeDefined();
  });

  it('dismisses a suggestion and keeps it dismissed', async () => {
    renderPage();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss suggestion: Start something new from an empty project',
      }),
    );
    expect(screen.queryByText('Start something new from an empty project')).toBeNull();
    expect(
      JSON.parse(window.sessionStorage.getItem('veltravia.chat.dismissed-suggestions') ?? '[]'),
    ).toEqual(['builder']);
  });

  it('says answers are simulated when no provider is connected', async () => {
    renderPage();
    expect(await screen.findByText('Simulated')).toBeDefined();
  });

  it('reports the provider as Auto once one is connected', async () => {
    getCapabilities.mockResolvedValue(capabilities(true));
    renderPage();
    expect(await screen.findByText('Auto')).toBeDefined();
  });

  it('shows the answer the server returned, never a guess', async () => {
    startRun.mockResolvedValue(run());
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'What is Veltravia?' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(await screen.findByText('Here is what I found.')).toBeDefined();
    expect(screen.getByText('What is Veltravia?')).toBeDefined();
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed run failed and offers to ask again', async () => {
    startRun.mockResolvedValue(
      run({
        status: 'failed',
        answer: undefined,
        error: { code: 'X', message: 'Upstream refused.' },
      }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Anything' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(await screen.findByText('Upstream refused.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeDefined();
    expect(screen.queryByText(/^Here is/)).toBeNull();
  });

  it('asks an open question on a new conversation and for a message in a thread', async () => {
    startRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    getRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    renderPage();

    // A conversation with no turns is a new conversation.
    expect(screen.getByLabelText('Message').getAttribute('placeholder')).toBe(
      "What's on your mind",
    );

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hallo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Once there is a turn, the box stops asking an open question.
    await waitFor(() => {
      expect(screen.getByLabelText('Message').getAttribute('placeholder')).toBe('Type a message…');
    });
  });

  it('does not send an empty question', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(startRun).not.toHaveBeenCalled();
  });

  it('stops a running answer and says who stopped it', async () => {
    startRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    getRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    cancelRun.mockResolvedValue(run({ status: 'cancelled' }));
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Long job' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop the answer' }));
    expect(cancelRun).toHaveBeenCalledWith('run-1');
    expect(await screen.findByText('You stopped this answer.')).toBeDefined();
  });

  it('follows the run’s own steps while the answer is still being written', async () => {
    startRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    getRun.mockResolvedValue(
      run({
        status: 'running',
        answer: undefined,
        steps: [
          {
            id: 's1',
            toolId: 'codebase.search',
            intent: 'read the failing test tail',
            status: 'success',
            durationMs: 410,
          },
        ],
      }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Find the bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // The line carries the step the server reported, not a canned phrase.
    expect(await screen.findByText('Read the failing test tail')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { expanded: false, name: /1 step/ }));
    expect(screen.getByRole('listitem').textContent).toContain('Done');
  });

  it('starts with a plain working line before any step is published', async () => {
    startRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    getRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Find the bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Working on it')).toBeDefined();
  });

  it('keeps the send control in place while stopping is offered', async () => {
    startRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    getRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Long job' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Send message' }));

    // The stop control sits beside the send control instead of replacing it,
    // so the composer does not rearrange itself mid-answer.
    const stop = await screen.findByRole('button', { name: 'Stop the answer' });
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(stop.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(send.hasAttribute('disabled')).toBe(true);
  });

  it('omits the microphone when the browser cannot dictate', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: 'Dictate a message' })).toBeNull();
  });

  it('starts a new conversation without a page reload', async () => {
    startRun.mockResolvedValue(run());
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await screen.findByText('Here is what I found.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }));
    });
    expect(screen.queryByText('Here is what I found.')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Hey there');
  });
});
