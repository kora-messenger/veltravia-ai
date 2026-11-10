// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';

/**
 * A conversation that is only in memory is a conversation the drawer cannot
 * list. These pin the two halves of that promise: a finished exchange is kept,
 * and choosing a kept one puts it back on screen.
 */

const startRun = vi.fn();
const getCapabilities = vi.fn();
const getRun = vi.fn();
const cancelRun = vi.fn();
const continueRun = vi.fn();
const getActivitySnapshot = vi.fn();

vi.mock('../../api/reasoning', () => ({
  startRun: (input: unknown) => startRun(input),
  getCapabilities: () => getCapabilities(),
  getModelPicker: () => Promise.resolve({ automatic: {}, models: [], choice: null }),
  setChatModel: () => Promise.resolve(null),
  getRun: (id: string) => getRun(id),
  cancelRun: (id: string) => cancelRun(id),
  continueRun: (id: string) => continueRun(id),
  isTerminal: (status: string) => status === 'completed' || status === 'failed',
}));

vi.mock('../../api/activity', () => ({
  getActivitySnapshot: (runId: string, after: number) => getActivitySnapshot(runId, after),
  openActivityStream: () => ({ close: () => undefined }),
}));

const { ChatPage } = await import('./ChatPage');
const { NEW_CHAT_EVENT } = await import('./useChatSession');
const conversations = await import('./conversations');

const capabilities = {
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
  provider: { connected: false, reason: null, modes: ['gateway', 'simulated'] },
  tools: [],
  simulatedReasoningAllowed: true,
};

const run = {
  id: 'run-1',
  profile: 'workspace',
  task: 'question',
  status: 'completed',
  steps: [],
  decisions: [],
  answer: 'The vault holds your keys.',
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
};

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
  getActivitySnapshot.mockReset();
  getActivitySnapshot.mockResolvedValue(null);
  getCapabilities.mockResolvedValue(capabilities);
  startRun.mockResolvedValue(run);
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('keeping a conversation', () => {
  it('saves a finished exchange under the words that started it', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'What is in the vault?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('The vault holds your keys.');

    // The save runs in an effect, so on a loaded runner the answer can be on
    // screen a tick before it reaches the store. Wait for the stored thread
    // rather than reading the moment the text appears.
    await vi.waitFor(() => {
      const saved = conversations.listConversations();
      expect(saved).toHaveLength(1);
      expect(saved[0]?.title).toBe('What is in the vault?');
      expect(saved[0]?.turns.map((turn) => turn.text)).toEqual([
        'What is in the vault?',
        'The vault holds your keys.',
      ]);
    });
  });

  it('puts a kept conversation back on screen when the drawer asks for it', async () => {
    const kept = conversations.createConversation({
      title: 'Older thread',
      turns: [
        { id: 't1', role: 'user', text: 'Where are the keys?' },
        { id: 't2', role: 'assistant', text: 'In the vault.' },
      ],
    });

    renderPage();
    expect(screen.queryByText('In the vault.')).toBeNull();
    act(() => {
      conversations.requestOpenConversation(kept.id);
    });
    expect(await screen.findByText('In the vault.')).toBeDefined();
    expect(screen.getByText('Where are the keys?')).toBeDefined();
  });

  it('starts a separate conversation after a new chat', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'First question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('The vault holds your keys.');

    act(() => {
      window.dispatchEvent(new Event(NEW_CHAT_EVENT));
    });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Second question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('The vault holds your keys.');

    const titles = conversations.listConversations().map((record) => record.title);
    expect(titles).toEqual(['Second question', 'First question']);
  });
});
