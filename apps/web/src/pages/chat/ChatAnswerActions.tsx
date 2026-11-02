import { useEffect, useRef, useState } from 'react';
import { CopyIcon, ShareIcon, SpeakerIcon, ThumbDownIcon, ThumbUpIcon } from './chatIcons';

/**
 * The row of controls under an answer: copy it, say whether it helped, hear it,
 * hand it on.
 *
 * Every control does something real or is not drawn:
 *
 *   - Copy writes the answer to the clipboard.
 *   - The thumbs record one opinion per answer, in this browser only. Nothing is
 *     sent anywhere, because there is nowhere to send it, and the tooltip says so
 *     rather than implying the owner is training something.
 *   - Read aloud uses the browser's own speech synthesis and disappears when the
 *     browser has none.
 *   - Share appears only where the platform can share; otherwise copying is the
 *     honest equivalent and no button pretends otherwise.
 */

const FEEDBACK_KEY = 'veltravia:answer-feedback';

type Feedback = 'up' | 'down';

function readFeedback(): Record<string, Feedback> {
  try {
    const raw = window.localStorage.getItem(FEEDBACK_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, Feedback>;
  } catch {
    return {};
  }
}

function storeFeedback(map: Record<string, Feedback>): void {
  try {
    window.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(map));
  } catch {
    // A browser that refuses storage loses the record, not the answer.
  }
}

/** Copies text, falling back to the old selection path where the API is absent. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection path.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

export interface ChatAnswerActionsProps {
  readonly messageId: string;
  /** The answer exactly as shown. Never the run record, never the report. */
  readonly text: string;
}

export function ChatAnswerActions({ messageId, text }: ChatAnswerActionsProps) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [spoken, setSpoken] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const resetCopied = useRef<number | null>(null);

  useEffect(() => {
    setFeedback(readFeedback()[messageId] ?? null);
  }, [messageId]);

  // Both capabilities are detected after mount: the first paint must not claim a
  // control the browser cannot honour.
  useEffect(() => {
    setCanSpeak(typeof window.speechSynthesis !== 'undefined');
    setCanShare(typeof navigator.share === 'function');
  }, []);

  useEffect(
    () => () => {
      if (resetCopied.current !== null) window.clearTimeout(resetCopied.current);
      if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel();
    },
    [],
  );

  const onCopy = async () => {
    const ok = await copyText(text);
    setCopied(ok);
    if (resetCopied.current !== null) window.clearTimeout(resetCopied.current);
    resetCopied.current = window.setTimeout(() => setCopied(false), 1600);
  };

  const onFeedback = (next: Feedback) => {
    const chosen = feedback === next ? null : next;
    setFeedback(chosen);
    const map = readFeedback();
    if (chosen === null) delete map[messageId];
    else map[messageId] = chosen;
    storeFeedback(map);
  };

  const onSpeak = () => {
    const synthesis = window.speechSynthesis;
    if (synthesis === undefined) return;
    if (speaking) {
      synthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    synthesis.speak(utterance);
    setSpeaking(true);
  };

  const onShare = async () => {
    try {
      await navigator.share({ text });
      setSpoken(true);
      resetCopied.current = window.setTimeout(() => setSpoken(false), 1600);
    } catch {
      // A dismissed share sheet is not a failure worth a message.
    }
  };

  return (
    <div className="v-chat-actions">
      <button
        type="button"
        className="v-chat-actions__button"
        onClick={() => void onCopy()}
        aria-label="Copy this answer"
      >
        <CopyIcon />
      </button>
      <button
        type="button"
        className={
          feedback === 'up'
            ? 'v-chat-actions__button v-chat-actions__button--on'
            : 'v-chat-actions__button'
        }
        onClick={() => onFeedback('up')}
        aria-label="This answer was helpful"
        aria-pressed={feedback === 'up'}
        title="Kept in this browser only"
      >
        <ThumbUpIcon />
      </button>
      <button
        type="button"
        className={
          feedback === 'down'
            ? 'v-chat-actions__button v-chat-actions__button--on'
            : 'v-chat-actions__button'
        }
        onClick={() => onFeedback('down')}
        aria-label="This answer was not helpful"
        aria-pressed={feedback === 'down'}
        title="Kept in this browser only"
      >
        <ThumbDownIcon />
      </button>
      {canSpeak ? (
        <button
          type="button"
          className={
            speaking
              ? 'v-chat-actions__button v-chat-actions__button--on'
              : 'v-chat-actions__button'
          }
          onClick={onSpeak}
          aria-label={speaking ? 'Stop reading this answer' : 'Read this answer aloud'}
          aria-pressed={speaking}
        >
          <SpeakerIcon />
        </button>
      ) : null}
      {canShare ? (
        <button
          type="button"
          className="v-chat-actions__button"
          onClick={() => void onShare()}
          aria-label="Share this answer"
        >
          <ShareIcon />
        </button>
      ) : null}
      {/* One polite line, so a copy is confirmed without a toast covering the
          answer the person just copied. */}
      <span className="v-chat-actions__status" role="status" aria-live="polite">
        {copied ? 'Copied' : spoken ? 'Shared' : ''}
      </span>
    </div>
  );
}
