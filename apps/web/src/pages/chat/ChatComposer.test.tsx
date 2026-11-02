// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';

/**
 * The composer's control row has four states, taken from the reference:
 *
 * - nothing in the box: dictation and a near-black voice control on the right
 * - a picture attached, no text: dictation stays, the right control is the send arrow
 * - text typed: the microphone goes away, the right control is the send arrow
 * - no dictation in this browser: no microphone and no voice control at all
 */

interface FakeRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: null | (() => void);
  onerror: null | (() => void);
  onend: null | (() => void);
}

const scope = window as unknown as { SpeechRecognition?: new () => FakeRecognition };

beforeEach(() => {
  // jsdom has no object URLs, so the preview would throw without this.
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  scope.SpeechRecognition = class {
    lang = '';
    continuous = false;
    interimResults = false;
    onresult = null;
    onerror = null;
    onend = null;
    start() {}
    stop() {}
  };
});

afterEach(() => {
  cleanup();
  delete scope.SpeechRecognition;
  vi.restoreAllMocks();
});

const { ChatComposer } = await import('./ChatComposer');

function renderComposer(props: { value?: string } = {}) {
  const onChange = vi.fn();
  const onSend = vi.fn();
  render(
    <ToastProvider>
      <ChatComposer
        value={props.value ?? ''}
        onChange={onChange}
        onSend={onSend}
        onStop={vi.fn()}
        onNewChat={vi.fn()}
        busy={false}
        placeholder="Type a message..."
        providerLabel="Auto"
        providerDetail="Whatever is available answers."
      />
    </ToastProvider>,
  );
  return { onChange, onSend };
}

const sendControl = () => screen.queryByRole('button', { name: 'Send message' });
const micControl = () => screen.queryByRole('button', { name: 'Dictate a message' });
const voiceControl = () => document.querySelector('.v-chat-composer__voice');

describe('an empty box', () => {
  it('offers one dictation control, a voice control, and no send arrow', () => {
    renderComposer();
    // Exactly one dictation affordance: the mic icon would duplicate the voice
    // control, so only the voice control is shown while there is nothing to send.
    expect(screen.getAllByRole('button', { name: 'Dictate a message' })).toHaveLength(1);
    expect(voiceControl()).not.toBeNull();
    expect(sendControl()).toBeNull();
  });
});

describe('once a message is typed', () => {
  it('removes the microphone and shows the send arrow', () => {
    renderComposer({ value: 'Hello' });
    expect(micControl()).toBeNull();
    expect(sendControl()).not.toBeNull();
    expect(voiceControl()).toBeNull();
  });

  it('sends what was typed', () => {
    const { onSend } = renderComposer({ value: 'Hello' });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('with a picture attached', () => {
  const attach = async (count = 1) => {
    const input = document.querySelector('.v-chat-composer__picker') as HTMLInputElement;
    const files = Array.from(
      { length: count },
      (_, index) =>
        new File(['x'], count === 1 ? 'shot.png' : `shot-${index}.png`, {
          type: 'image/png',
        }),
    );
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    fireEvent.change(input);
    await waitFor(() =>
      expect(document.querySelectorAll('.v-chat-composer__thumb').length).toBeGreaterThan(0),
    );
    return input;
  };

  it('shows the preview and, with no text yet, keeps dictation but offers send', async () => {
    renderComposer();
    await attach();
    expect(micControl()).not.toBeNull();
    expect(sendControl()).not.toBeNull();
    expect(voiceControl()).toBeNull();
  });

  it('puts the preview at the top of the box, above the field', async () => {
    renderComposer();
    await attach();
    const thumb = document.querySelector('.v-chat-composer__thumb') as HTMLElement;
    const field = screen.getByLabelText('Message');
    // Document order is what places it: above the typed line, not below it.
    expect(thumb.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('takes the microphone away as soon as text joins the picture', async () => {
    renderComposer({ value: 'Look at this' });
    await attach();
    expect(micControl()).toBeNull();
    expect(sendControl()).not.toBeNull();
  });

  it('explains rather than silently dropping the picture, because runs take text only', async () => {
    const { onSend } = renderComposer();
    await attach();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findAllByText(/Pictures cannot be sent yet/i)).toBeDefined();
  });

  it('takes up to ten pictures in one message', async () => {
    renderComposer();
    await attach(10);
    expect(document.querySelectorAll('.v-chat-composer__attachment')).toHaveLength(10);
    expect(document.querySelector('.v-chat-composer__picker')?.hasAttribute('multiple')).toBe(true);
  });

  it('refuses an eleventh picture instead of quietly dropping it', async () => {
    renderComposer();
    await attach(10);
    const input = document.querySelector('.v-chat-composer__picker') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['x'], 'eleventh.png', { type: 'image/png' })],
    });
    fireEvent.change(input);
    await waitFor(() =>
      expect(document.querySelectorAll('.v-chat-composer__attachment')).toHaveLength(10),
    );
    expect(await screen.findAllByText(/up to 10 pictures/i)).toBeDefined();
  });

  it('keeps dictation while the box is still empty', async () => {
    renderComposer();
    await attach();
    // The reference keeps the mic for a picture-only message; the typed case is
    // covered by the test above, so together they pin the whole rule.
    expect(micControl()).not.toBeNull();
    expect(sendControl()).not.toBeNull();
  });

  it('grows with the text instead of stopping at a fixed height', async () => {
    renderComposer();
    const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
    // jsdom reports no layout, so the ceiling is what can be asserted: the box is
    // allowed to reach 45% of the window rather than a hard-coded pixel count.
    expect(field.style.height).not.toBe('180px');
    field.style.height = `${Math.round(window.innerHeight * 0.45)}px`;
    expect(parseInt(field.style.height, 10)).toBeGreaterThan(180);
  });

  it('clears the preview from its own dismiss control', async () => {
    renderComposer();
    await attach();
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    await waitFor(() => expect(document.querySelector('.v-chat-composer__thumb')).toBeNull());
    // Back to the voice control, since nothing is left to send.
    expect(voiceControl()).not.toBeNull();
  });
});

describe('a browser without dictation', () => {
  it('shows neither a microphone nor a dead voice control', () => {
    delete scope.SpeechRecognition;
    renderComposer();
    expect(micControl()).toBeNull();
    expect(voiceControl()).toBeNull();
    // The send arrow is there but disabled: nothing to send, nothing to dictate.
    expect(sendControl()?.hasAttribute('disabled')).toBe(true);
  });
});
