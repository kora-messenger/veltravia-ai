import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../components/ui';

export interface MessageComposerProps {
  /**
   * Called with the trimmed message when the user submits. NOT wired to any
   * API in this checkpoint — the parent decides what happens (Step 11C-2
   * will connect this to the agent API).
   */
  onSend(text: string): void;
  /** Disables input while a future operation is in flight. */
  busy?: boolean;
  /** Hard disable (e.g. archived project). */
  disabled?: boolean;
}

const MAX_LENGTH = 8000;

/**
 * The workspace message composer: a multiline input with send affordance.
 * Enter submits, Shift+Enter inserts a newline; the input grows with
 * content up to a ceiling. No network activity happens here.
 */
export function MessageComposer({ onSend, busy = false, disabled = false }: MessageComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendHintId = useId();

  const trimmed = text.trim();
  const canSend = !busy && !disabled && trimmed.length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // Don't submit while composing with an IME.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const blocked = busy || disabled;

  return (
    <form
      className="v-composer"
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="v-composer__label" htmlFor={sendHintId + '-input'}>
        Message Veltravia AI
      </label>
      <div className="v-composer__row">
        <textarea
          id={sendHintId + '-input'}
          ref={textareaRef}
          className="v-composer__input"
          value={text}
          placeholder={
            disabled
              ? 'The workspace is read-only'
              : 'Ask Veltravia to build, modify, explain or analyze\u2026'
          }
          aria-describedby={sendHintId}
          maxLength={MAX_LENGTH}
          rows={2}
          disabled={blocked}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Button
          type="submit"
          disabled={!canSend}
          className="v-composer__send"
          aria-label="Send message"
        >
          {busy ? 'Sending\u2026' : 'Send'}
        </Button>
      </div>
      <p className="v-composer__hint" id={sendHintId}>
        Enter to send, Shift+Enter for a new line. AI responses arrive in a later release — your
        messages are not sent anywhere yet.
      </p>
    </form>
  );
}
