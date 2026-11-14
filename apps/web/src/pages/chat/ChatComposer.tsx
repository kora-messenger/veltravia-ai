import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog, Menu, useToast } from '../../components/ui';
import type { AvailableModel, ChatModelChoice } from '../../api/reasoning';
import {
  ArrowUpIcon,
  AttachIcon,
  DriveIcon,
  NoteIcon,
  CloseIcon,
  MicIcon,
  PlusIcon,
  StopIcon,
  ProviderMark,
  TuneIcon,
  WaveIcon,
} from './chatIcons';

/** The slice of the Web Speech API used here, declared locally. */
interface SpeechResultLike {
  readonly results: { readonly [index: number]: { readonly 0: { readonly transcript: string } } };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechResultLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function speechRecognition(): SpeechRecognitionLike | null {
  const scope = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Constructor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (Constructor === undefined) return null;
  try {
    return new Constructor();
  } catch {
    return null;
  }
}

export interface ChatComposerProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /**
   * Sends the message. The composer passes the words to send when it has
   * attached notes to them; otherwise the surface sends what is in the box.
   */
  readonly onSend: (text?: string) => void;
  readonly onStop: () => void;
  readonly busy: boolean;
  /** A fresh conversation asks an open question; a thread asks for a message. */
  readonly placeholder: string;
  /** What will answer, in plain words. Always a fact, never a guess. */
  readonly providerLabel: string;
  /** The pinned model, or null on Automatic. */
  readonly model: ChatModelChoice | null;
  readonly models: readonly AvailableModel[];
  readonly chooseModel: (choice: null | AvailableModel) => void;
  readonly providerDetail: string;
  /**
   * Bumped when something outside the box has written into it (a quick prompt,
   * say). The box takes focus, with the caret at the end, so the words are
   * waiting to be read and sent rather than hidden under a dead cursor.
   */
  readonly focusToken?: number;
}

/**
 * The box grows with what is typed and has no character ceiling of its own. It
 * stops growing at 45% of the window so the conversation stays visible, and
 * scrolls inside after that: a long message is never truncated, only scrolled.
 */
const MAX_GROWTH = 0.45;

/** How many files one message may carry. */
const MAX_ATTACHMENTS = 10;

/** Notes written here stay in this browser: there is no note store on the server. */
const NOTES_KEY = 'veltravia:composer-notes';

function readNotes(): { id: string; text: string }[] {
  try {
    const raw = window.localStorage.getItem(NOTES_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { id: string; text: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        typeof (entry as { text?: unknown }).text === 'string',
    );
  } catch {
    return [];
  }
}

function writeNotes(notes: readonly { id: string; text: string }[]): void {
  try {
    window.localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch {
    // A browser that refuses storage loses the notes, not the message.
  }
}

/**
 * The message composer, laid out like the reference: one plain field on top of
 * a control row, all inside a rounded grey container.
 *
 * Left to right the row is: attachments, the mode chip, then the dictation
 * control and finally the send control in the brand colour. While an answer is
 * being produced a separate outlined stop control appears NEXT TO the send
 * control rather than replacing it, so the composer does not rearrange itself
 * mid-answer. Every control does something real; the microphone is omitted
 * entirely when the browser has no speech recognition.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  placeholder,
  providerLabel,
  model,
  models,
  chooseModel,
  providerDetail,
  focusToken,
}: ChatComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const [dictation, setDictation] = useState(false);
  const [attachments, setAttachments] = useState<
    readonly { id: string; name: string; url: string | null }[]
  >([]);
  // Notes are the person's own words attached to the message they are about to
  // send. They live in this browser; nothing is uploaded.
  const [notes, setNotes] = useState<readonly { id: string; text: string }[]>(readNotes);
  const [noteOpen, setNoteOpen] = useState(false);

  /**
   * A quick prompt has just written into the box. Focusing it with the caret at
   * the end turns a filled field into something the person can read and send,
   * instead of words they have to hunt for.
   */
  useEffect(() => {
    if (focusToken === undefined || focusToken === 0) return;
    const node = field.current;
    if (node === null) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [focusToken]);
  const [noteDraft, setNoteDraft] = useState('');
  const { toast } = useToast();

  // Feature detection runs after mount so the control is never rendered for a
  // browser that cannot honour it.
  useEffect(() => {
    setDictation(speechRecognition() !== null);
  }, []);

  useEffect(() => {
    const element = field.current;
    if (element === null) return;
    element.style.height = 'auto';
    const ceiling = Math.round(window.innerHeight * MAX_GROWTH);
    element.style.height = `${Math.min(element.scrollHeight, ceiling)}px`;
  }, [value]);

  // Every object URL lives until it is revoked, so removing one preview, clearing
  // the box and unmounting all free what they opened.
  const revokeAll = (items: readonly { url: string | null }[]) => {
    for (const item of items) if (item.url !== null) URL.revokeObjectURL(item.url);
  };

  const addAttachments = (files: readonly File[]) => {
    setAttachments((current) => {
      const room = MAX_ATTACHMENTS - current.length;
      if (room <= 0) {
        toast(`You can attach up to ${MAX_ATTACHMENTS} files.`, { tone: 'error' });
        return current;
      }
      if (files.length > room) {
        toast(`Only ${room} more could be added: the limit is ${MAX_ATTACHMENTS}.`, {
          tone: 'error',
        });
      }
      const accepted = files.slice(0, room);
      return [
        ...current,
        ...accepted.map((file) => ({
          id: `${file.name}-${file.lastModified}-${current.length}`,
          name: file.name,
          // Only pictures are previewed; anything else keeps its name and an
          // icon, because a browser cannot render a PDF as a thumbnail.
          url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        })),
      ];
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const next = current.filter((attachment) => attachment.id !== id);
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.url != null) URL.revokeObjectURL(removed.url);
      return next;
    });
  };

  useEffect(
    () => () => {
      setAttachments((current) => {
        revokeAll(current);
        return [];
      });
    },
    [],
  );

  const startListening = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const engine = speechRecognition();
    if (engine === null) return;
    engine.lang = navigator.language === '' ? 'en-US' : navigator.language;
    engine.continuous = false;
    engine.interimResults = false;
    engine.onresult = (event) => {
      const spoken = event.results[0]?.[0]?.transcript ?? '';
      if (spoken.trim() !== '') {
        onChange(value === '' ? spoken : `${value} ${spoken}`);
      }
    };
    engine.onerror = () => {
      setListening(false);
      toast('Dictation stopped: the microphone was unavailable.', { tone: 'error' });
    };
    engine.onend = () => setListening(false);
    recognition.current = engine;
    try {
      engine.start();
      setListening(true);
    } catch {
      setListening(false);
      toast('Dictation could not start in this browser.', { tone: 'error' });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.shiftKey === false) {
      event.preventDefault();
      sendOrExplain();
    }
  };

  const typed = value.trim() !== '';
  // The reference swaps the far-right control: a voice control while there is
  // nothing to send, the send arrow as soon as there is a message or an image.
  // Only typed words change the row. An attachment does not hide the microphone,
  // and an empty box has nothing to send.

  /**
   * Sending with an image attached is refused rather than silently dropping it:
   * the run API takes text, so a picture would leave the composer looking sent
   * while the model never saw it.
   */
  const sendOrExplain = () => {
    if (busy) return;
    if (attachments.length > 0) {
      // Files ride along with the message in the composer only: the run API
      // takes text, so sending with one attached would look sent while the model
      // never saw it.
      toast(
        attachments.length === 1
          ? 'Files cannot be sent yet. Remove it to send this message.'
          : 'Files cannot be sent yet. Remove them to send this message.',
        { tone: 'error' },
      );
      return;
    }
    if (notes.length === 0) {
      onSend();
      return;
    }
    // The notes are the person's own words, so they travel with the message
    // rather than being summarised or dropped.
    const block = notes.map((note) => `- ${note.text}`).join('\n');
    onSend(`${value.trim()}\n\nNotes from the owner:\n${block}`);
  };

  const openNote = () => {
    setNoteDraft('');
    setNoteOpen(true);
  };

  const saveNote = () => {
    const text = noteDraft.trim();
    if (text === '') return;
    const next = [...notes, { id: `${Date.now()}`, text }];
    setNotes(next);
    writeNotes(next);
    setNoteOpen(false);
  };

  const removeNote = (id: string) => {
    const next = notes.filter((note) => note.id !== id);
    setNotes(next);
    writeNotes(next);
  };

  return (
    // The picked files sit in their own block above the box rather than inside
    // it: a grid of squares belongs over the field, and the box stays the
    // standalone rounded container the reference shows.
    <div className="v-chat-composer-stack">
      {attachments.length > 0 && (
        <ul className="v-chat-composer__attachments" aria-label="Attached files">
          {attachments.map((attachment) => (
            <li className="v-chat-composer__attachment" key={attachment.id}>
              {attachment.url === null ? (
                // A file that cannot be previewed keeps the same square so the
                // grid stays aligned; its name is on the tile and on the
                // remove control instead of printed underneath the picture.
                <span className="v-chat-composer__file" title={attachment.name}>
                  <NoteIcon size={20} />
                </span>
              ) : (
                <img
                  className="v-chat-composer__thumb"
                  src={attachment.url}
                  alt={attachment.name}
                />
              )}
              <button
                type="button"
                className="v-chat-composer__dismiss"
                onClick={() => removeAttachment(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
              >
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="v-chat-composer">
        <input
          ref={picker}
          type="file"
          accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx"
          multiple
          className="v-chat-composer__picker"
          onChange={(event) => {
            addAttachments(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <label className="v-chat-composer__label" htmlFor="veltravia-chat-input">
          Message
        </label>
        <textarea
          id="veltravia-chat-input"
          ref={field}
          className="v-chat-composer__input"
          value={value}
          rows={1}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby="veltravia-chat-hint"
        />
        <div className="v-chat-composer__row">
          <Menu
            trigger={<PlusIcon />}
            triggerLabel="More ways to start"
            // The trigger sits at the bottom-left of the screen, so the panel opens
            // upwards from it: opening downwards would fall off the bottom edge.
            // Small and anchored to the button itself, as Base44's own is.
            placement="compact-above-start"
            items={[
              {
                id: 'attach',
                label: 'Attach files',
                icon: <AttachIcon />,
                onSelect: () => picker.current?.click(),
              },
              {
                id: 'note',
                label: 'Add note',
                icon: <NoteIcon />,
                hint: notes.length > 0 ? String(notes.length) : undefined,
                children: [
                  { id: 'write', label: 'Write a note…', onSelect: openNote },
                  ...notes.map((note) => ({
                    id: note.id,
                    label: note.text,
                    hint: 'Remove',
                    onSelect: () => removeNote(note.id),
                  })),
                ],
              },
              {
                id: 'drive',
                // The reference's third row. There is no Drive connection behind
                // it, so it is drawn as unavailable, never as a control that
                // quietly does nothing. The reason is a tooltip and is read aloud
                // rather than printed in the row, so the full name fits.
                label: 'Upload from Google Drive',
                icon: <DriveIcon />,
                description: 'Google Drive is not connected',
                disabled: true,
                onSelect: () => {},
              },
            ]}
          />

          {/* The chip says what will answer: the pinned model, or Automatic when
            the router decides. Choosing one pins it for this person. */}
          <Menu
            trigger={
              <>
                {model === null ? <TuneIcon /> : <ProviderMark providerId={model.providerId} />}
                <span>{providerLabel}</span>
              </>
            }
            triggerLabel={`Model: ${providerLabel}. ${providerDetail}`}
            placement="above-start"
            items={[
              {
                id: 'auto',
                icon: <TuneIcon />,
                label: 'Automatic',
                hint: model === null ? '✓' : undefined,
                onSelect: () => chooseModel(null),
              },
              ...models.map((entry) => ({
                id: `${entry.connectionId}:${entry.modelId}`,
                icon: <ProviderMark providerId={entry.providerId} />,
                label: entry.label,
                hint:
                  model?.modelId === entry.modelId
                    ? '✓'
                    : `${entry.providerName}${entry.isDefaultConnection ? ' · default' : ''}`,
                onSelect: () => chooseModel(entry),
              })),
            ]}
          />

          <div className="v-chat-composer__spacer" />

          {/* Right side of the row, exactly as asked:
              - an empty box shows TWO controls, the plain microphone and the
                filled square;
              - once there is text only the microphone goes, and the square in the
                same place becomes the send control;
              - an attachment changes nothing: only typing counts here.
            The microphone is absent only where the browser cannot dictate. */}
          {dictation && !typed && (
            <button
              type="button"
              className={
                listening
                  ? 'v-chat-composer__mic v-chat-composer__mic--listening'
                  : 'v-chat-composer__mic'
              }
              onClick={startListening}
              aria-label={listening ? 'Stop dictation' : 'Dictate a message'}
              aria-pressed={listening}
            >
              <MicIcon />
            </button>
          )}

          {busy && (
            <button
              type="button"
              className="v-chat-composer__stop"
              onClick={onStop}
              aria-label="Stop the answer"
            >
              <StopIcon />
            </button>
          )}

          {typed ? (
            <button
              type="button"
              className="v-chat-composer__send"
              onClick={sendOrExplain}
              disabled={busy}
              aria-label="Send message"
            >
              <ArrowUpIcon />
            </button>
          ) : dictation ? (
            // Nothing typed: the filled square is the dictation control, so it is
            // never a dead button sitting where send will be.
            <button
              type="button"
              className="v-chat-composer__voice"
              onClick={startListening}
              aria-label={listening ? 'Stop voice input' : 'Start voice input'}
              aria-pressed={listening}
            >
              <WaveIcon />
            </button>
          ) : (
            // No dictation in this browser, so the square would be a dead control.
            <button
              type="button"
              className="v-chat-composer__send"
              onClick={sendOrExplain}
              disabled
              aria-label="Send message"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
        <p className="v-chat-composer__hint" id="veltravia-chat-hint">
          Enter sends, Shift + Enter adds a line.
        </p>
      </div>

      <Dialog
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title="Add a note"
        description="Notes go with the next message you send. They stay in this browser."
      >
        <label className="v-chat-composer__note-label" htmlFor="veltravia-note">
          Note
        </label>
        <textarea
          id="veltravia-note"
          className="v-chat-composer__note"
          rows={4}
          value={noteDraft}
          onChange={(event) => setNoteDraft(event.target.value)}
        />
        <div className="v-chat-composer__note-actions">
          <button type="button" className="v-chat-composer__note-save" onClick={saveNote}>
            Save note
          </button>
          <button
            type="button"
            className="v-chat-composer__note-cancel"
            onClick={() => setNoteOpen(false)}
          >
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  );
}
