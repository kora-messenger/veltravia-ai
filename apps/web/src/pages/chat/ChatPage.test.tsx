// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, TransportError } from '../../api/client';
import { ToastProvider } from '../../components/ui';
import { AgentProfileProvider } from '../../agent/AgentProfileProvider';

const startRun = vi.fn();
const getCapabilities = vi.fn();
const getRun = vi.fn();
const cancelRun = vi.fn();
const getActivitySnapshot = vi.fn();
const openActivityStream = vi.fn((_runId: string, _after: number, _handlers: unknown) => ({
  close: () => undefined,
}));

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

// The timeline's own transport is mocked too: the page is what is under test
// here, and a real EventSource does not exist in jsdom.
vi.mock('../../api/activity', () => ({
  getActivitySnapshot: (runId: string, after: number) => getActivitySnapshot(runId, after),
  openActivityStream: (runId: string, after: number, handlers: unknown) =>
    openActivityStream(runId, after, handlers),
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
  getActivitySnapshot.mockReset();
  openActivityStream.mockClear();
  getActivitySnapshot.mockResolvedValue(null);
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
    // Each line names its destination in the brand colour, as the reference does.
    expect(screen.getByRole('button', { name: 'Open the app builder' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open document intelligence' })).toBeDefined();
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

  it('answers without repeating the brand mark on the turn', async () => {
    startRun.mockResolvedValue(run());
    const { container } = renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await screen.findByText('Here is what I found.');

    // One logo on the page is the bar's; the reply itself carries none.
    const turn = container.querySelector('.v-chat__turn--assistant');
    expect(turn?.querySelector('.v-chat__avatar')).toBeNull();
    // The status tick in the activity line is not branding; the brand mark is.
    expect(turn?.querySelector('img, .v-brand-mark')).toBeNull();
    expect(screen.queryByAltText(/veltravia/i)).toBeNull();
  });

  it('keeps a failed run failed and offers a retry', async () => {
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
    // The run's own words are the reason line, and the retry sits with it
    // rather than in the footer.
    expect(await screen.findByText('Something went wrong')).toBeDefined();
    expect(screen.getByText('Upstream refused.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
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

  it('follows the activity the server reports while the answer is written', async () => {
    startRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    getActivitySnapshot.mockResolvedValue({
      runId: 'run-1',
      sequence: 1,
      runStatus: 'running',
      terminal: false,
      report: null,
      activities: [
        {
          eventId: 'a1:succeeded',
          runId: 'run-1',
          sequence: 1,
          activityId: 'a1',
          parentActivityId: null,
          category: 'searching',
          title: 'Searched the codebase',
          status: 'succeeded',
          safeSummary: 'Searched the codebase.',
          startedAt: '2026-11-02T10:00:00.000Z',
          completedAt: '2026-11-02T10:00:00.410Z',
          durationMs: 410,
          safeInput: 'codebase.search\n{"query":"tail"}',
          safeOutput: '49 passed',
          error: null,
          retryCount: 0,
        },
      ],
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Find the bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // The headline carries the row the server reported, not a canned phrase.
    expect(await screen.findByText('Searched the codebase')).toBeDefined();
    // The row itself, not the headline above it: the headline reads "Working on
    // it" here because the reported step has already finished.
    const row = screen.getByRole('button', { name: /Searched the codebase/ });
    fireEvent.click(row);
    expect(screen.getByText('Command')).toBeDefined();
    expect(screen.getByText('Output')).toBeDefined();
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
    // The thread has no header of its own; starting over lives in the box's menu.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'New conversation' }));
    });
    expect(screen.queryByText('Here is what I found.')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Hey there');
  });
});

describe('the way back to the live edge', () => {
  /** jsdom has no layout, so give the scroll area the geometry the page reads. */
  const giveGeometry = (node: HTMLElement, top: number) => {
    Object.defineProperty(node, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(node, 'clientHeight', { configurable: true, value: 700 });
    node.scrollTop = top;
    fireEvent.scroll(node);
  };

  const startLongRun = async () => {
    startRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    getRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    const view = renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Long job' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Stop the answer' });
    return view.container.querySelector('.v-chat__scroll') as HTMLElement;
  };

  const control = () => screen.queryByRole('button', { name: /still working/i });
  const view_dots = () => document.querySelectorAll('.v-live-edge__dot');

  it('appears when the reader scrolls up during a run, and not while they are at the bottom', async () => {
    const scroller = await startLongRun();
    giveGeometry(scroller, 1300); // 2000 - 1300 - 700 = 0 from the bottom
    expect(control()).toBeNull();
    act(() => giveGeometry(scroller, 200)); // 1100px from the bottom
    expect(await screen.findByRole('button', { name: /still working/i })).toBeDefined();
  });

  it('leaves once the reader is back at the newest content', async () => {
    const scroller = await startLongRun();
    act(() => giveGeometry(scroller, 200));
    expect(await screen.findByRole('button', { name: /still working/i })).toBeDefined();
    act(() => giveGeometry(scroller, 1300));
    await waitFor(() => expect(control()).toBeNull());
  });

  it('scrolls to the end and goes away when tapped', async () => {
    const scroller = await startLongRun();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    act(() => giveGeometry(scroller, 200));
    fireEvent.click(await screen.findByRole('button', { name: /still working/i }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
    await waitFor(() => expect(control()).toBeNull());
  });

  it('offers the way back after an answer has landed, since that is when a reader who scrolled up needs it', async () => {
    startRun.mockResolvedValue(run());
    const view = renderPage();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Quick one' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await screen.findByText('Here is what I found.');
    const scroller = view.container.querySelector('.v-chat__scroll') as HTMLElement;
    act(() => giveGeometry(scroller, 100));
    const back = await screen.findByRole('button', { name: /jump to the latest message/i });
    // Nothing is running, so the mark is a still chevron rather than the dots.
    expect(back.getAttribute('data-state')).toBe('idle');
    expect(view.container.querySelectorAll('.v-live-edge__dot')).toHaveLength(0);
  });

  it('uses the working mark while a run is going and the still one after it', async () => {
    const scroller = await startLongRun();
    act(() => giveGeometry(scroller, 200));
    const working = await screen.findByRole('button', { name: /still working/i });
    expect(working.getAttribute('data-state')).toBe('working');
    expect(view_dots()).toHaveLength(3);
  });
});

describe("the owner's picture beside their own turns", () => {
  const renderAs = (ownerName: string | null) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            profile: {
              agentName: 'My Engineer',
              ownerName,
              isDefault: ownerName === null,
              updatedAt: '2026-11-02T10:00:00.000Z',
            },
            limits: { maxLength: 40 },
            persistence: { durable: false, note: '' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    return render(
      <ToastProvider>
        <AgentProfileProvider
          client={{ fetchImpl: fetchImpl as unknown as typeof fetch, ownerRef: 'owner-1' }}
        >
          <ChatPage />
        </AgentProfileProvider>
      </ToastProvider>,
    );
  };

  const send = async () => {
    startRun.mockResolvedValue(run());
    const field = await screen.findByLabelText('Message');
    fireEvent.change(field, { target: { value: 'Hello there' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await screen.findByText('Hello there');
  };

  it('draws a circle with the first letter of the name the owner gave', async () => {
    const { container } = renderAs('Ijezie Nwosu');
    await screen.findByLabelText('Message');
    await send();
    const avatar = container.querySelector('.v-chat__turn--user .v-chat__avatar');
    expect(avatar?.textContent).toBe('I');
    expect(avatar?.getAttribute('data-empty')).toBeNull();
  });

  it('falls back to a person glyph when they have given no name', async () => {
    const { container } = renderAs(null);
    await screen.findByLabelText('Message');
    await send();
    const avatar = container.querySelector('.v-chat__turn--user .v-chat__avatar');
    expect(avatar?.getAttribute('data-empty')).toBe('true');
    expect(avatar?.querySelector('svg')).not.toBeNull();
    expect(avatar?.textContent).toBe('');
  });

  it('never puts a picture on the assistant turn', async () => {
    const { container } = renderAs('Ijezie Nwosu');
    await screen.findByLabelText('Message');
    await send();
    await screen.findByText('Here is what I found.');
    const assistant = container.querySelector('.v-chat__turn--assistant');
    expect(assistant?.querySelector('.v-chat__avatar')).toBeNull();
  });
});

describe('a message that does not reach the server', () => {
  const type = (text: string) => {
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  };

  it('shows Thinking before the server has accepted, with no timeline', async () => {
    let resolveRun: (value: unknown) => void = () => undefined;
    startRun.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );
    renderPage();
    type('Find the bug');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Thinking')).toBeDefined();
    expect(document.querySelector('.v-act')).toBeNull();
    await act(async () => {
      resolveRun(run({ status: 'completed' }));
    });
    expect(await screen.findByText('Here is what I found.')).toBeDefined();
  });

  it('shows only the warning, with the words back in the box', async () => {
    startRun.mockRejectedValue(
      new TransportError('offline', 'You are offline. Your message was not sent.'),
    );
    renderPage();
    type('Find the bug');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // The warning is the whole of what the failed send puts on screen: a pale
    // tile with no brand mark, a headline, one plain reason line and Retry.
    expect(await screen.findByText('Something went wrong')).toBeDefined();
    expect(screen.getByText('Network Error')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();

    // Nothing pretends the question was sent: no bubble at all.
    expect(screen.queryByText('Find the bug', { selector: '.v-chat__bubble' })).toBeNull();

    // And nothing typed is lost: it is back in the box, unedited. (The handback
    // lands one effect after the warning, so this waits for it.)
    await waitFor(() => {
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Find the bug');
    });
    // The warning is on screen, so the box asks for a message rather than
    // offering the opening question again.
    expect(screen.getByLabelText('Message').getAttribute('placeholder')).toBe('Type a message…');
  });

  it('leaves the warning alone on screen', async () => {
    startRun.mockRejectedValue(new TransportError('offline', 'You are offline.'));
    renderPage();
    type('Find the bug');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Something went wrong');

    expect(screen.queryByText('Start a new conversation')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'My Engineer' })).toBeNull();
  });

  it('never repeats the agent name above the turns', async () => {
    startRun.mockResolvedValue(run({ status: 'completed' }));
    renderPage();
    type('Find the bug');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Here is what I found.');

    // The name lives in the top bar only: no second copy, and no start-over link
    // taking up a row above the conversation.
    expect(screen.queryByRole('heading', { name: 'My Engineer' })).toBeNull();
    expect(screen.queryByText('Start a new conversation')).toBeNull();
  });

  it('puts no brand mark inside the error state', async () => {
    startRun.mockRejectedValue(new TransportError('offline', 'You are offline.'));
    renderPage();
    type('Find the bug');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    const card = await screen.findByRole('alert');
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.v-brand-mark')).toBeNull();
  });

  it('retries with the words it kept, and puts exactly one question back', async () => {
    startRun
      .mockRejectedValueOnce(new TransportError('offline', 'You are offline.'))
      .mockResolvedValueOnce(run({ status: 'completed' }));
    renderPage();
    type('Find the bug');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Something went wrong');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Here is what I found.')).toBeDefined();
    // One bubble, not two: the retry replaced the warning rather than adding to it.
    expect(screen.getAllByText('Find the bug', { selector: '.v-chat__bubble' })).toHaveLength(1);
    expect(screen.queryByText('Something went wrong')).toBeNull();
    // Retried with the same words, and the box no longer holds a live copy.
    expect(startRun).toHaveBeenLastCalledWith(expect.objectContaining({ task: 'Find the bug' }));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });

  it('retries the edited words from the box, not the abandoned ones', async () => {
    startRun
      .mockRejectedValueOnce(new TransportError('offline', 'You are offline.'))
      .mockResolvedValueOnce(run({ status: 'completed' }));
    renderPage();
    type('Find the bu');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Something went wrong');
    await waitFor(() => {
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Find the bu');
    });

    // Editing the handed-back text and pressing Send is the ordinary path; the
    // warning must not also fire its own copy of the old words.
    type('Find the bug');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Here is what I found.')).toBeDefined();
    expect(screen.getAllByText('Find the bug', { selector: '.v-chat__bubble' })).toHaveLength(1);
    expect(screen.queryByText('Find the bu', { selector: '.v-chat__bubble' })).toBeNull();
    expect(startRun).toHaveBeenLastCalledWith(expect.objectContaining({ task: 'Find the bug' }));
    expect(startRun).toHaveBeenCalledTimes(2);
  });

  it('does not resend by itself when the request timed out', async () => {
    startRun.mockRejectedValue(
      new TransportError('timeout', 'The service did not answer in time.'),
    );
    renderPage();
    type('Summarise the repo');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('The service took too long to answer')).toBeDefined();
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('names an unavailable service as unavailable', async () => {
    startRun.mockRejectedValue(
      new ApiError(503, 'PROVIDER_UNAVAILABLE', 'No provider is connected.'),
    );
    renderPage();
    type('Anything');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('The service is unavailable')).toBeDefined();
  });

  it('says so when it is not authorised, without blaming the network', async () => {
    startRun.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'No session.'));
    renderPage();
    type('Anything');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Not authorised to run here')).toBeDefined();
    expect(screen.queryByText('Network Error')).toBeNull();
  });

  it('sends once, however many times the send control is tapped', async () => {
    startRun.mockResolvedValue(run({ status: 'running', answer: undefined }));
    renderPage();
    type('Find the bug');
    const send = screen.getByRole('button', { name: 'Send message' });
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(send);
    await screen.findByText('Working on it');
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('keeps the message gone once the server has the run, even if it fails', async () => {
    startRun.mockResolvedValue(
      run({
        status: 'failed',
        answer: undefined,
        error: { code: 'PROVIDER_ERROR', message: 'Upstream refused.' },
      }),
    );
    renderPage();
    type('Find the bug');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Accepted means sent: the text stays out of the composer, and asking again
    // is the person's choice, not the page's.
    expect(await screen.findByText('Something went wrong')).toBeDefined();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });
});
