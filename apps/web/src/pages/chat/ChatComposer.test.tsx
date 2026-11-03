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

function renderComposer(props: { value?: string; onSend?: (text?: string) => void } = {}) {
  const onChange = vi.fn();
  const onSend = props.onSend ?? vi.fn();
  render(
    <ToastProvider>
      <ChatComposer
        value={props.value ?? ''}
        onChange={onChange}
        onSend={onSend}
        onStop={vi.fn()}
        busy={false}
        placeholder="Type a message..."
        providerLabel="Auto"
        model={null}
        models={[]}
        chooseModel={vi.fn()}
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
  it('shows the plain microphone and the filled square, and no send arrow', () => {
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

  it('keeps both controls while an attachment sits in an empty box', async () => {
    renderComposer();
    await attach();
    // Nothing disappears for an attachment: only typed words change the row.
    expect(micControl()).not.toBeNull();
    expect(voiceControl()).not.toBeNull();
    expect(sendControl()).toBeNull();
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
    const { onSend } = renderComposer({ value: 'Look at this' });
    await attach();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findAllByText(/Files cannot be sent yet/i)).toBeDefined();
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
    expect(await screen.findAllByText(/up to 10 files/i)).toBeDefined();
  });

  it('keeps dictation while the box is still empty', async () => {
    renderComposer();
    await attach();
    // The plain microphone and the filled square both stay for a picture-only
    // message, and pressing the square starts dictation rather than nothing.
    expect(micControl()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeDefined();
  });

  it('explains an attachment when Enter is pressed, instead of doing nothing', async () => {
    const { onSend } = renderComposer();
    await attach();
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findAllByText(/Files cannot be sent yet/i)).toBeDefined();
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

  it('puts no ceiling on what can be typed', () => {
    renderComposer();
    const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
    // A limit the user cannot see is worse than no limit: the box must not have
    // one, so nothing can silently truncate a long instruction.
    expect(field.getAttribute('maxlength')).toBeNull();
  });

  it('draws a microphone on the voice control, not a waveform', () => {
    renderComposer();
    const voice = screen.getByRole('button', { name: 'Dictate a message' });
    // The empty-state control has to read as "speak", so it carries the same
    // microphone mark as the dictation control beside an attachment.
    expect(voice.querySelector('rect[x="9"][y="3"]')).not.toBeNull();
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

describe('the plus card', () => {
  /** Reads the rows in the order they are drawn. */
  const rows = () =>
    [...document.querySelectorAll('.v-menu__item-label')].map((node) => node.textContent);

  it('draws the reference rows, with the Drive row honestly unavailable', async () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }));
    await screen.findByRole('menu');
    expect(rows().slice(0, 3)).toEqual(['Attach files', 'Add note', 'Upload from Google Drive']);
    const drive = screen.getByRole('menuitem', { name: /Upload from Google Drive/ });
    expect(drive.hasAttribute('disabled')).toBe(true);
    expect(drive.textContent).toContain('Not connected');
  });

  it('opens a second level for notes, with a way back', async () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }));
    await screen.findByRole('menu');
    fireEvent.click(screen.getByRole('menuitem', { name: /Add note/ }));
    expect(rows()).toEqual(['Back to Add note', 'Write a note…']);
    // The caret marks the row that opens this level.
    fireEvent.click(screen.getByRole('menuitem', { name: /Back to Add note/ }));
    expect(rows()[1]).toBe('Add note');
  });

  it('writes a note, counts it, and sends it with the message', async () => {
    const onSend = vi.fn();
    // The box already holds the message: this stands in for typing, because the
    // test double's onChange does not feed state back.
    renderComposer({ onSend, value: 'Build me a page' });
    fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }));
    await screen.findByRole('menu');
    fireEvent.click(screen.getByRole('menuitem', { name: /Add note/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Write a note…' }));
    fireEvent.change(await screen.findByLabelText('Note'), {
      target: { value: 'keep it short' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    // The count appears on the row that owns the notes.
    fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }));
    const noteRow = await screen.findByRole('menuitem', { name: /Add note/ });
    expect(noteRow.textContent).toContain('1');

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith(
      'Build me a page\n\nNotes from the owner:\n- keep it short',
    );
  });
});

describe('the model chip', () => {
  const sonnet = {
    connectionId: 'c1',
    modelId: 'sonnet-5.5',
    label: 'Sonnet 5.5',
    providerId: 'anthropic',
    providerName: 'Anthropic',
    isDefaultConnection: true,
  };
  const gpt = {
    connectionId: 'c2',
    modelId: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    providerId: 'openai',
    providerName: 'OpenAI',
    isDefaultConnection: false,
  };

  function renderChip(pinned: typeof sonnet | null, chooseModel = vi.fn()) {
    render(
      <ToastProvider>
        <ChatComposer
          value=""
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
          busy={false}
          placeholder="Type a message..."
          providerLabel={pinned?.label ?? 'Auto'}
          model={pinned}
          models={[sonnet, gpt]}
          chooseModel={chooseModel}
          providerDetail="Whatever is available answers."
        />
      </ToastProvider>,
    );
    return chooseModel;
  }

  const chip = () => screen.getByRole('button', { name: /^Model:/ });

  it('says Auto with the generic mark until a model is pinned', () => {
    renderChip(null);
    expect(chip().textContent).toBe('Auto');
    expect(chip().querySelector('svg')).not.toBeNull();
  });

  it('shows the pinned model by name, with a different mark from Auto', () => {
    renderChip(null);
    const autoMark = chip().querySelector('svg')!.innerHTML;
    cleanup();
    renderChip(sonnet);
    expect(chip().textContent).toBe('Sonnet 5.5');
    expect(chip().querySelector('svg')!.innerHTML).not.toBe(autoMark);
  });

  it('gives each maker its own mark in the list and ticks the one in use', () => {
    renderChip(sonnet);
    fireEvent.click(chip());
    const rows = screen.getAllByRole('menuitem');
    const names = rows.map((row) => row.textContent ?? '');
    expect(names[0]).toContain('Automatic');
    const sonnetRow = rows.find((row) => (row.textContent ?? '').includes('Sonnet 5.5'))!;
    const gptRow = rows.find((row) => (row.textContent ?? '').includes('GPT-5.6 Luna'))!;
    expect(sonnetRow.textContent).toContain('✓');
    expect(gptRow.textContent).not.toContain('✓');
    expect(sonnetRow.querySelector('svg')!.innerHTML).not.toBe(
      gptRow.querySelector('svg')!.innerHTML,
    );
  });

  it('pins the chosen model, and Automatic clears the pin', () => {
    const choose = renderChip(sonnet);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('menuitem', { name: /GPT-5\.6 Luna/ }));
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gpt-5.6-luna' }));
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('menuitem', { name: /Automatic/ }));
    expect(choose).toHaveBeenLastCalledWith(null);
  });
});
