import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Menu, Tooltip, useToast } from '../../components/ui';
import { navigateToHash } from '../../shell/useHashRoute';
import { ArrowUpIcon, CloseIcon, MicIcon, PlusIcon, StopIcon, TuneIcon } from './chatIcons';

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
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onNewChat: () => void;
  readonly busy: boolean;
  /** A fresh conversation asks an open question; a thread asks for a message. */
  readonly placeholder: string;
  /** What will answer, in plain words. Always a fact, never a guess. */
  readonly providerLabel: string;
  readonly providerDetail: string;
}

/**
 * The box grows with what is typed and has no character ceiling of its own. It
 * stops growing at 45% of the window so the conversation stays visible, and
 * scrolls inside after that: a long message is never truncated, only scrolled.
 */
const MAX_GROWTH = 0.45;

/** How many pictures one message may carry. */
const MAX_ATTACHMENTS = 10;

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
  onNewChat,
  busy,
  placeholder,
  providerLabel,
  providerDetail,
}: ChatComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const [dictation, setDictation] = useState(false);
  const [images, setImages] = useState<readonly { name: string; url: string }[]>([]);
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
  const revokeAll = (attachments: readonly { url: string }[]) => {
    for (const attachment of attachments) URL.revokeObjectURL(attachment.url);
  };

  const addImages = (files: readonly File[]) => {
    setImages((current) => {
      const room = MAX_ATTACHMENTS - current.length;
      if (room <= 0) {
        toast(`You can attach up to ${MAX_ATTACHMENTS} pictures.`, { tone: 'error' });
        return current;
      }
      const accepted = files.slice(0, room);
      if (files.length > room) {
        toast(`Only ${room} more could be added: the limit is ${MAX_ATTACHMENTS}.`, {
          tone: 'error',
        });
      }
      return [
        ...current,
        ...accepted.map((file) => ({ name: file.name, url: URL.createObjectURL(file) })),
      ];
    });
  };

  const removeImage = (url: string) => {
    setImages((current) => {
      const next = current.filter((attachment) => attachment.url !== url);
      if (next.length !== current.length) URL.revokeObjectURL(url);
      return next;
    });
  };

  useEffect(
    () => () => {
      setImages((current) => {
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
      onSend();
    }
  };

  const typed = value.trim() !== '';
  // The reference swaps the far-right control: a voice control while there is
  // nothing to send, the send arrow as soon as there is a message or an image.
  const hasSomethingToSend = typed || images.length > 0;
  const canSend = hasSomethingToSend && !busy;

  /**
   * Sending with an image attached is refused rather than silently dropping it:
   * the run API takes text, so a picture would leave the composer looking sent
   * while the model never saw it.
   */
  const sendOrExplain = () => {
    if (busy) return;
    if (images.length > 0) {
      toast(
        images.length === 1
          ? 'Pictures cannot be sent yet. Remove it to send this message.'
          : 'Pictures cannot be sent yet. Remove them to send this message.',
        { tone: 'error' },
      );
      return;
    }
    onSend();
  };

  return (
    <div className="v-chat-composer">
      {images.length > 0 && (
        <ul className="v-chat-composer__attachments">
          {images.map((image) => (
            <li className="v-chat-composer__attachment" key={image.url}>
              <img className="v-chat-composer__thumb" src={image.url} alt={image.name} />
              <button
                type="button"
                className="v-chat-composer__dismiss"
                onClick={() => removeImage(image.url)}
                aria-label={`Remove ${image.name}`}
              >
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        className="v-chat-composer__picker"
        onChange={(event) => {
          addImages(Array.from(event.target.files ?? []));
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
          items={[
            { id: 'attach', label: 'Attach a photo', onSelect: () => picker.current?.click() },
            { id: 'new', label: 'New conversation', onSelect: onNewChat },
            {
              id: 'projects',
              label: 'Go to projects',
              onSelect: () => navigateToHash('#/projects'),
            },
            {
              id: 'builder',
              label: 'Open the app builder',
              onSelect: () => navigateToHash('#/builder'),
            },
            {
              id: 'settings',
              label: 'Model settings',
              onSelect: () => navigateToHash('#/settings/models'),
            },
          ]}
        />

        <Tooltip text={providerDetail}>
          <button
            type="button"
            className="v-chat-composer__mode"
            onClick={() => navigateToHash('#/settings/models')}
          >
            <TuneIcon />
            <span>{providerLabel}</span>
          </button>
        </Tooltip>

        <div className="v-chat-composer__spacer" />

        {/* The reference keeps dictation while the box is empty, even with a
            picture attached, and drops it the moment there is text to send. */}
        {dictation && !typed && images.length > 0 && (
          <button
            type="button"
            className={
              listening
                ? 'v-chat-composer__icon v-chat-composer__icon--active'
                : 'v-chat-composer__icon'
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

        {hasSomethingToSend ? (
          <button
            type="button"
            className="v-chat-composer__send"
            onClick={sendOrExplain}
            disabled={!canSend}
            aria-label="Send message"
          >
            <ArrowUpIcon />
          </button>
        ) : dictation ? (
          // Nothing to send: the control becomes a voice control rather than a
          // disabled send button, and it starts dictation, which is the voice
          // capability this build actually has.
          <button
            type="button"
            className="v-chat-composer__voice"
            onClick={startListening}
            aria-label={listening ? 'Stop dictation' : 'Dictate a message'}
            aria-pressed={listening}
          >
            <MicIcon />
          </button>
        ) : (
          // No dictation in this browser, so the voice mark would be a dead
          // control. Fall back to the send arrow, disabled because there is
          // nothing to send.
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
  );
}
