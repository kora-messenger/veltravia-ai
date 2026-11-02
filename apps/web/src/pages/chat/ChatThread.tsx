import { Spinner } from '../../components/ui';
import { navigateToHash } from '../../shell/useHashRoute';
import { AgentActivityTimeline } from './AgentActivityTimeline';
import { ChatErrorState, failureReason } from './ChatErrorState';
import { FinalReportCard } from './FinalReportCard';
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

/**
 * One turn of the conversation.
 *
 * While the request is still on its way (`thinking`) the turn shows a spinner and
 * the word for it, and nothing else: no timeline, because no run exists yet. Once
 * the server has a run, the turn shows that run's activity and then its report.
 */
export function Message({
  message,
  ownerName,
  onRetry,
  retrying,
}: {
  readonly message: ChatMessage;
  readonly ownerName: string | null;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}) {
  if (message.role === 'user') {
    return (
      <div className="v-chat__turn v-chat__turn--user">
        <div className="v-chat__bubble">{message.text}</div>
        <UserAvatar name={ownerName} />
      </div>
    );
  }

  const thinking = message.phase === 'thinking';
  const hasActivity = message.activities.length > 0;

  // A turn that never got an answer shows its own state and its own retry, in
  // the place the answer would have been.
  if (message.state === 'failed') {
    return (
      <div className="v-chat__turn v-chat__turn--assistant">
        <div className="v-chat__answer">
          <ChatErrorState
            reason={
              // A send that never left uses the plain word for it; a run that
              // came back failed keeps whatever the server said went wrong.
              message.failure
                ? failureReason(message.failure.kind)
                : (message.note ?? 'The run did not produce an answer')
            }
            retrying={retrying}
            onRetry={onRetry}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="v-chat__turn v-chat__turn--assistant">
      {/* No brand mark on answers: the reply starts at the thread's left edge,
          so the page keeps one logo (the bar) instead of one per turn. */}
      <div className="v-chat__answer">
        {thinking ? (
          <p className="v-chat__thinking">
            <Spinner size="sm" aria-label="Sending your message" />
            <span>Thinking</span>
          </p>
        ) : hasActivity ? (
          <AgentActivityTimeline
            activities={message.activities}
            runStatus={message.runStatus}
            connection={message.connection ?? 'closed'}
          />
        ) : message.phase === 'running' ? (
          <p className="v-chat__thinking">
            <Spinner size="sm" aria-label="Waiting for the first step" />
            <span>Working on it</span>
          </p>
        ) : null}

        {message.text !== '' && !thinking && <p className="v-chat__text">{message.text}</p>}

        {message.report !== null && message.phase === 'finished' ? (
          <FinalReportCard report={message.report} />
        ) : null}

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
  // A lone warning is not a conversation: nothing has been said, so the row that
  // names the thread and offers to start another one would be chrome around a
  // single error. It appears once there is a real turn to head.
  const hasRealTurn = messages.some(
    (message) => message.role === 'user' || message.failedQuestion == null,
  );

  return (
    <div className="v-chat__thread">
      {hasRealTurn ? (
        <div className="v-chat__thread-head">
          <h1 className="v-chat__thread-title">{agentName}</h1>
          <button type="button" className="v-chat__link" onClick={onNewChat}>
            Start a new conversation
          </button>
        </div>
      ) : null}
      <div className="v-chat__turns" role="log" aria-live="polite" aria-relevant="additions">
        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            ownerName={ownerName}
            onRetry={onRetry}
            retrying={!canRetry}
          />
        ))}
      </div>
    </div>
  );
}
