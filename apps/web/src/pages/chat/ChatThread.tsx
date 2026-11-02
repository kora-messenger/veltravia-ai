import { BrandMark } from '../../components/brand/BrandMark';
import { Spinner } from '../../components/ui';
import { navigateToHash } from '../../shell/useHashRoute';
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

export function Message({ message }: { readonly message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="v-chat__turn v-chat__turn--user">
        <div className="v-chat__bubble">{message.text}</div>
      </div>
    );
  }
  return (
    <div className="v-chat__turn v-chat__turn--assistant">
      <div className="v-chat__avatar">
        <BrandMark size={24} decorative />
      </div>
      <div className="v-chat__answer">
        {message.state === 'pending' ? (
          <p className="v-chat__thinking">
            <Spinner size="sm" aria-label="Waiting for an answer" />
            <span>Working on it</span>
          </p>
        ) : (
          message.text !== '' && <p className="v-chat__text">{message.text}</p>
        )}
        <Note message={message} />
      </div>
    </div>
  );
}

export interface ChatThreadProps {
  readonly messages: readonly ChatMessage[];
  readonly agentName: string;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
  readonly onNewChat: () => void;
}

/** The turns themselves, identical on both layouts. */
export function ChatThread({ messages, agentName, canRetry, onRetry, onNewChat }: ChatThreadProps) {
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
          <Message key={message.id} message={message} />
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
