import { Spinner } from '../../components/ui';
import { navigateToHash } from '../../shell/useHashRoute';
import { AgentActivityTimeline } from './AgentActivityTimeline';
import { ChatErrorState, failureReason } from './ChatErrorState';
import { FinalReportCard } from './FinalReportCard';
import { UserAvatar } from './UserAvatar';
import type { ChatBudget, ChatMessage } from './useChat';

/** "5 of 5 tool calls", in the words the engine used. */
export function budgetLine(budget: ChatBudget): string {
  const noun =
    budget.kind === 'tool_calls'
      ? 'tool call'
      : budget.kind === 'duration'
        ? 'minute'
        : budget.kind === 'output_tokens'
          ? 'output token'
          : 'step';
  const plural = budget.ceiling === 1 ? noun : `${noun}s`;
  if (budget.kind === 'duration') {
    const used = Math.max(1, Math.round(budget.used / 60000));
    const ceiling = Math.max(1, Math.round(budget.ceiling / 60000));
    return `${used} of ${ceiling} minutes used`;
  }
  return `${budget.used} of ${budget.ceiling} ${plural} used`;
}

/** A run that stopped at its budget: not a fault, and it can usually carry on. */
export function BudgetState({
  budget,
  canContinue,
  continuing,
  onContinue,
}: {
  readonly budget: ChatBudget | null;
  readonly canContinue: boolean;
  readonly continuing: boolean;
  readonly onContinue: () => void;
}) {
  return (
    <div className="v-chat__budget">
      <p className="v-chat__note">
        The run stopped at its budget{budget === null ? '' : `: ${budgetLine(budget)}`}. Its
        finished steps are kept.
      </p>
      {canContinue ? (
        <button
          type="button"
          className="v-chat__link"
          onClick={onContinue}
          disabled={continuing}
          aria-label="Continue this run with a fresh budget"
        >
          {continuing ? 'Continuing…' : 'Continue'}
        </button>
      ) : (
        <p className="v-chat__note">
          It has no continuations left. Ask again to start a fresh run.
        </p>
      )}
    </div>
  );
}

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
  onContinue,
}: {
  readonly message: ChatMessage;
  readonly ownerName: string | null;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  readonly onContinue: () => void;
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

  // A run that stopped at its budget did not break: it ran out. Showing it as a
  // failure would be a lie, and the fix is to continue, not to start over.
  if (message.runStatus === 'limit_reached' && message.state === 'failed') {
    return (
      <div className="v-chat__turn v-chat__turn--assistant">
        <div className="v-chat__answer">
          <BudgetState
            budget={message.budget ?? null}
            canContinue={message.canContinue === true}
            continuing={message.phase === 'thinking'}
            onContinue={onContinue}
          />
        </div>
      </div>
    );
  }

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
            canRetry={message.failure ? message.failure.kind !== 'missing' : true}
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
  /** The owner's own name, so their turns can carry their picture. */
  readonly ownerName: string | null;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
  /** Carries a stopped run on with a fresh budget. */
  readonly onContinue: () => void;
}

/**
 * The turns themselves, identical on both layouts.
 *
 * There is no thread header here on purpose. The agent is named once, in the top
 * bar, and starting over lives in the chrome too, so repeating either above the
 * conversation would only push the words down the screen.
 */
export function ChatThread({
  messages,
  ownerName,
  canRetry,
  onRetry,
  onContinue,
}: ChatThreadProps) {
  return (
    <div className="v-chat__thread">
      <div className="v-chat__turns" role="log" aria-live="polite" aria-relevant="additions">
        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            ownerName={ownerName}
            onRetry={onRetry}
            retrying={!canRetry}
            onContinue={onContinue}
          />
        ))}
      </div>
    </div>
  );
}
