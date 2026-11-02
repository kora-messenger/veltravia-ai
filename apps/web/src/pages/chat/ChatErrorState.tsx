import { RetryIcon } from './chatIcons';

/**
 * The state a turn shows when it did not get an answer.
 *
 * Laid out from the reference: a pale red rounded tile with a speech-bubble mark
 * and no brand logo anywhere in it, a plain headline, one short reason line, and
 * a single retry control. The mark is drawn in the tile rather than the product
 * logo on purpose: a failing turn should look like an error, not like the app.
 */
export interface ChatErrorStateProps {
  /** Short reason, e.g. "Network Error". Never a stack trace or a raw code. */
  readonly reason: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}

export function ChatErrorState({ reason, retrying, onRetry }: ChatErrorStateProps) {
  return (
    <div className="v-chat-error" role="alert">
      <div className="v-chat-error__tile" aria-hidden="true">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable="false"
        >
          <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H7l-4 3v-5.2A8.5 8.5 0 1 1 21 11.5Z" />
        </svg>
      </div>
      <p className="v-chat-error__title">Something went wrong</p>
      <p className="v-chat-error__reason">{reason}</p>
      <button type="button" className="v-chat-error__retry" onClick={onRetry} disabled={retrying}>
        <RetryIcon size={16} />
        <span>{retrying ? 'Retrying' : 'Retry'}</span>
      </button>
    </div>
  );
}

/**
 * Turns a failure into the one line under the headline. The vocabulary stays
 * plain: a person reading it should know whether to retry, wait, or check their
 * connection, without seeing an error code.
 */
export function failureReason(kind: string): string {
  switch (kind) {
    case 'offline':
      return 'Network Error';
    case 'timeout':
      return 'The service took too long to answer';
    case 'unavailable':
      return 'The service is unavailable';
    case 'auth':
      return 'Not authorised to run here';
    case 'rejected':
      return 'The request was not accepted';
    default:
      return 'Network Error';
  }
}
