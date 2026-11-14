// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { clipForHistory, hasContent, normalizeNewlines, trimBlankEdges } from './messageText';

/**
 * A pasted brief must come back out the way it went in: on screen straight after
 * sending, in the request the model receives, in the stored conversation, and
 * after the conversation is reopened. Each of those is a separate place a
 * newline can be lost, so each is asserted on its own.
 */

const startRun = vi.fn();
const getCapabilities = vi.fn();
const getRun = vi.fn();

vi.mock('../../api/reasoning', () => ({
  startRun: (input: unknown) => startRun(input),
  getCapabilities: () => getCapabilities(),
  getModelPicker: () => Promise.resolve({ automatic: {}, models: [], choice: null }),
  setChatModel: () => Promise.resolve(null),
  getRun: (id: string) => getRun(id),
  cancelRun: () => Promise.resolve(),
  continueRun: () => Promise.resolve(),
  isTerminal: (status: string) => status === 'completed' || status === 'failed',
}));
vi.mock('../../api/activity', () => ({
  getActivitySnapshot: () => Promise.resolve(null),
  openActivityStream: () => ({ close: () => undefined }),
}));

const { ChatPage } = await import('./ChatPage');
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

function completedRun(answer: string) {
  return {
    id: 'run-1',
    profile: 'workspace',
    task: 'q',
    status: 'completed',
    steps: [],
    decisions: [],
    answer,
    usage: {
      iterations: 1,
      toolCalls: 0,
      modelCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      providerLatencyMs: 1,
      latencyMs: 1,
    },
    provenance: [],
    contextDropped: [],
    limitations: [],
    createdAt: new Date().toISOString(),
  };
}

const BRIEF = `I want you to redesign my application.

IMPORTANT:

- Preserve existing functionality.
- Keep the application name.
- Rebuild the interface.

1. First step
   - nested detail

\`\`\`ts
const a = 1;

  const b = 2;
\`\`\`

See https://example.com/spec for more.`;

const renderPage = () =>
  render(
    <ToastProvider>
      <ChatPage />
    </ToastProvider>,
  );

function paste(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
}

beforeEach(() => {
  startRun.mockReset();
  getCapabilities.mockReset();
  getRun.mockReset();
  getCapabilities.mockResolvedValue(capabilities);
  startRun.mockResolvedValue(completedRun('ok'));
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe('message text helpers', () => {
  it('unifies line endings and nothing else', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it("removes blank lines at the edges but keeps the first line's indentation", () => {
    expect(trimBlankEdges('\n\n   \n    indented\n\nbody\n\n  \n')).toBe('    indented\n\nbody');
  });

  it('keeps every blank line inside', () => {
    expect(trimBlankEdges('a\n\n\n\nb')).toBe('a\n\n\n\nb');
  });

  it('keeps a trailing code-indented line intact up to its last visible character', () => {
    expect(trimBlankEdges('x\n    code   ')).toBe('x\n    code');
  });

  it('treats a message of only whitespace as empty', () => {
    expect(hasContent(' \n\t\n  ')).toBe(false);
    expect(hasContent('\n a \n')).toBe(true);
  });

  it('leaves a short history turn untouched and marks a cut one', () => {
    expect(clipForHistory('short', 100)).toBe('short');
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const clipped = clipForHistory(long, 120);
    expect(clipped.length).toBeLessThan(long.length);
    expect(clipped).toContain('shortened');
    expect(clipped.startsWith('line 0\nline 1')).toBe(true);
  });
});

describe('a pasted brief, end to end', () => {
  it('sends the model the same characters that were pasted', async () => {
    renderPage();
    paste(BRIEF);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(startRun).toHaveBeenCalled());
    expect(startRun.mock.calls[0]?.[0].task).toBe(BRIEF);
  });

  it('shows it in the bubble with its blank lines, bullets and indentation', async () => {
    renderPage();
    paste(BRIEF);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    const bubble = await waitFor(() => {
      const found = document.querySelector('.v-chat__bubble');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // The code fence is shown as code; every other character is the person's own.
    expect(bubble.textContent).toContain(
      'I want you to redesign my application.\n\nIMPORTANT:\n\n- Preserve existing functionality.',
    );
    expect(bubble.textContent).toContain('1. First step\n   - nested detail');
    expect(bubble.querySelector('pre code')?.textContent).toBe('const a = 1;\n\n  const b = 2;');
    expect(bubble.querySelector('a')?.getAttribute('href')).toBe('https://example.com/spec');
  });

  it('does not collapse into one paragraph: the stylesheet keeps its line breaks', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('apps/web/src/pages/chat/chat.css', 'utf8');
    const rule = /\.v-chat__bubble\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rule).toContain('white-space: pre-wrap');
  });

  it('stores the same text it displayed', async () => {
    renderPage();
    paste(BRIEF);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => {
      const saved = conversations.listConversations();
      expect(saved).toHaveLength(1);
      expect(saved[0]?.turns[0]?.text).toBe(BRIEF);
    });
  });

  it('shows the identical message after the conversation is reopened', async () => {
    const kept = conversations.createConversation({
      title: 'Brief',
      turns: [
        { id: 'u', role: 'user', text: BRIEF },
        { id: 'a', role: 'assistant', text: '## Done\n\n- one\n- two' },
      ],
    });
    renderPage();
    act(() => {
      conversations.requestOpenConversation(kept.id);
    });
    const bubble = await waitFor(() => {
      const found = document.querySelector('.v-chat__bubble');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(bubble.textContent).toContain('IMPORTANT:\n\n- Preserve existing functionality.');
    // The reopened answer is rendered, not shown as raw Markdown.
    expect(document.querySelector('.v-chat__answer h2')?.textContent).toBe('Done');
    expect(document.querySelectorAll('.v-chat__answer li')).toHaveLength(2);
  });

  it('survives a full remount of the page (a browser refresh)', async () => {
    renderPage();
    paste(BRIEF);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(conversations.listConversations()).toHaveLength(1));
    cleanup();

    renderPage();
    act(() => {
      conversations.requestOpenConversation(conversations.listConversations()[0]!.id);
    });
    const bubble = await waitFor(() => {
      const found = document.querySelector('.v-chat__bubble');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(bubble.textContent).toContain('- Keep the application name.\n- Rebuild the interface.');
  });

  it('sends a long message whole', async () => {
    const long = Array.from(
      { length: 600 },
      (_, i) => `Requirement ${i}: keep behaviour ${i}.`,
    ).join('\n\n');
    expect(long.length).toBeGreaterThan(18_000);
    renderPage();
    paste(long);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(startRun).toHaveBeenCalled());
    expect(startRun.mock.calls[0]?.[0].task).toBe(long);
  });

  it("keeps the first line's indentation and drops only blank edge lines", async () => {
    renderPage();
    paste('\n\n    indented first line\nsecond\n\n');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(startRun).toHaveBeenCalled());
    expect(startRun.mock.calls[0]?.[0].task).toBe('    indented first line\nsecond');
  });

  it('sends earlier turns as history with their line breaks intact', async () => {
    startRun.mockResolvedValue(completedRun('## Result\n\n1. a\n2. b'));
    renderPage();
    paste('first\n\nquestion');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Result');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeDefined());
    paste('follow up');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));
    const history = startRun.mock.calls[1]?.[0].conversation as { role: string; content: string }[];
    expect(history[0]?.content).toBe('first\n\nquestion');
    expect(history[1]?.content).toBe('## Result\n\n1. a\n2. b');
  });
});

describe('answers', () => {
  it('renders Markdown in a finished answer, with no raw symbols', async () => {
    startRun.mockResolvedValue(
      completedRun(
        '## Plan\n\nTwo things:\n\n- **fast** path\n- `safe` path\n\n| a | b |\n|---|---|\n| 1 | 2 |',
      ),
    );
    renderPage();
    paste('plan?');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Plan');
    const answer = document.querySelector('.v-chat__answer') as HTMLElement;
    expect(answer.querySelector('h2')).not.toBeNull();
    expect(answer.querySelectorAll('li')).toHaveLength(2);
    expect(answer.querySelector('strong')?.textContent).toBe('fast');
    expect(answer.querySelector('table')).not.toBeNull();
    expect(answer.textContent).not.toContain('**');
    expect(answer.textContent).not.toContain('##');
  });

  it('does not run markup that arrives in an answer', async () => {
    startRun.mockResolvedValue(
      completedRun('hi <img src=x onerror="window.__x=1"> <script>window.__x=1</script>'),
    );
    renderPage();
    paste('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(document.querySelector('.v-chat__answer .v-md')).not.toBeNull());
    expect(document.querySelector('.v-chat__answer img, .v-chat__answer script')).toBeNull();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
  });

  it('copies the answer as the Markdown it was written in', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    startRun.mockResolvedValue(completedRun('## T\n\n- a\n- b'));
    renderPage();
    paste('q');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('T');
    fireEvent.click(screen.getByRole('button', { name: 'Copy this answer' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('## T\n\n- a\n- b'));
  });
});

describe('the input box', () => {
  it('sends on Enter', async () => {
    renderPage();
    paste('hello');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() => expect(startRun).toHaveBeenCalled());
  });

  it('does not send on Shift+Enter, so a new line can be inserted', () => {
    renderPage();
    paste('hello');
    const notPrevented = fireEvent.keyDown(screen.getByLabelText('Message'), {
      key: 'Enter',
      shiftKey: true,
    });
    expect(notPrevented).toBe(true);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('does not send while an input method is composing', () => {
    renderPage();
    paste('こんにちは');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', isComposing: true });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('keeps pasted line breaks in the box itself', () => {
    renderPage();
    paste(BRIEF);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(BRIEF);
  });

  it('does not send a message of only blank lines', () => {
    renderPage();
    paste('\n \n\t\n');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(startRun).not.toHaveBeenCalled();
  });
});
