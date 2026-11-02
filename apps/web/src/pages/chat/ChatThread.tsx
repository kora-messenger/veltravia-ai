import { Spinner } from '../../components/ui';
import { navigateToHash } from '../../shell/useHashRoute';
import { RunActivityLine } from './RunActivity';
import { UserAvatar } from './UserAvatar';
import type { ChatMessage } from './useChat';

export function Note({ message }: { readonly message: ChatMessage }) {
  if (message.note === undefined) return null;
  if (message.state === 'needs-approval') {
    return (
      <p className="v-chat__note">
        {message.note}{' '}
        <button
          type="button"
          className="v-chat__link"
          onClick={() => navigateToHash('#/reasoning')}
        >
          Open the reasoning workspace
        </button>
      </p>
    );
  }
  return <p className="v-chat__note">{message.note}</p>;
}

export function Message({
  message,
  ownerName,
}: {
  readonly message: ChatMessage;
  readonly ownerName: string | null;
}) {
  if (message.role === 'user') {
    return (
      <div className="v-chat__turn v-chat__turn--user">
        <div className="v-chat__bubble">{message.text}</div>
        <UserAvatar name={ownerName} />
      </div>
    );
  }
  return (
    <div className="v-chat__turn v-chat__turn--assistant">
      {/* No brand mark on answers: the reply starts at the thread's left edge,
          so the page keeps one logo (the bar) instead of one per turn. */}
      <div className="v-chat__answer">
        {message.activity !== undefined ? (
          <RunActivityLine activity={message.activity} />
        ) : (
          message.state === 'pending' && (
            <p className="v-chat__thinking">
              <Spinner size="sm" aria-label="Waiting for an answer" />
              <span>Working on it</span>
            </p>
          )
        )}
        {message.state !== 'pending' && message.text !== '' && (
          <p className="v-chat__text">{message.text}</p>
        )}
        <Note message={message} />
      </div>
    </div>
  );
}

export interface ChatThreadProps {
  readonly messages: readonly ChatMessage[];
  readonly agentName: string;
  /** The owner's own name, so their turns can carry their picture. */
  readonly ownerName: string | null;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
  readonly onNewChat: () => void;
}

/** The turns themselves, identical on both layouts. */
export function ChatThread({
  messages,
  agentName,
  ownerName,
  canRetry,
  onRetry,
  onNewChat,
}: ChatThreadProps) {
  return (
    <div className="v-chat__thread">
      <div className="v-chat__thread-head">
        <h1 className="v-chat__thread-title">{agentName}</h1>
        <button type="button" className="v-chat__link" onClick={onNewChat}>
          Start a new conversation
        </button>
      </div>
      <div className="v-chat__turns" role="log" aria-live="polite" aria-relevant="additions">
        {messages.map((message) => (
          <Message key={message.id} message={message} ownerName={ownerName} />
        ))}
      </div>
      {canRetry && (
        <button type="button" className="v-chat__retry" onClick={onRetry}>
          Ask again
        </button>
      )}
    </div>
  );
}
