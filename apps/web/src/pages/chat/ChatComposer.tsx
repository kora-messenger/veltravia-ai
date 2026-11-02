import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Menu, Tooltip, useToast } from '../../components/ui';
import { navigateToHash } from '../../shell/useHashRoute';
import { ArrowUpIcon, MicIcon, PlusIcon, StopIcon, TuneIcon } from './chatIcons';

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
  /** What will answer, in plain words. Always a fact, never a guess. */
  readonly providerLabel: string;
  readonly providerDetail: string;
}

const MAX_ROWS_PX = 180;

/**
 * The message composer: a borderless field over a control row, with the send
 * control carrying the brand colour. Every control does something real; the
 * microphone is omitted entirely when the browser has no speech recognition.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  onNewChat,
  busy,
  providerLabel,
  providerDetail,
}: ChatComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const [dictation, setDictation] = useState(false);
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
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS_PX)}px`;
  }, [value]);

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

  const canSend = value.trim() !== '' && !busy;

  return (
    <div className="v-chat-composer">
      <label className="v-chat-composer__label" htmlFor="veltravia-chat-input">
        Message
      </label>
      <textarea
        id="veltravia-chat-input"
        ref={field}
        className="v-chat-composer__input"
        value={value}
        rows={1}
        placeholder="Ask anything, or describe what you want to build"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        aria-describedby="veltravia-chat-hint"
      />
      <div className="v-chat-composer__row">
        <Menu
          trigger={<PlusIcon />}
          triggerLabel="More ways to start"
          items={[
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

        {dictation && (
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

        {busy ? (
          <button
            type="button"
            className="v-chat-composer__send v-chat-composer__send--stop"
            onClick={onStop}
            aria-label="Stop the answer"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="v-chat-composer__send"
            onClick={onSend}
            disabled={!canSend}
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
