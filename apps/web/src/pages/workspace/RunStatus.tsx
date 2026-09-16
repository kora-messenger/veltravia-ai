import { Button, Spinner } from '../../components/ui';
import type { AgentRunUiState } from './use-agent-run';

export interface RunStatusProps {
  /** The live run state (from useAgentRun). */
  state: AgentRunUiState;
  onRetry(): void;
  onCancel(): void;
  onRefresh(): void;
}

/**
 * The live status strip under the conversation: a restrained, accessible
 * presentation of the one active/last agent run. Announces changes via
 * aria-live; never claims a state the backend has not confirmed.
 */
export function RunStatus({ state, onRetry, onCancel, onRefresh }: RunStatusProps) {
  const { phase } = state;
  if (phase === 'idle' || phase === 'completed') return null;

  if (phase === 'creating' || phase === 'running') {
    return (
      <div className="v-run-status" role="status" aria-live="polite">
        <Spinner size="sm" />
        <span className="v-run-status__label">
          {phase === 'creating' ? 'Starting your run…' : 'Working…'}
          <span className="v-run-status__hint">
            Veltravia AI is processing your request on the server.
          </span>
        </span>
        {state.pollingPaused && phase === 'running' ? (
          <Button variant="secondary" size="sm" onClick={onRefresh}>
            Check now
          </Button>
        ) : null}
        {phase === 'running' ? (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel run
          </Button>
        ) : null}
        {state.cancelError !== null ? (
          <span className="v-run-status__hint v-run-status__hint--error">{state.cancelError}</span>
        ) : null}
      </div>
    );
  }

  if (phase === 'paused') {
    return (
      <div className="v-run-status v-run-status--paused" role="status" aria-live="polite">
        <span className="v-run-status__label">
          {'Paused — this run is waiting for a required confirmation.'}
          <span className="v-run-status__hint">
            Approve or reject the request below. The run stays paused until you decide.
          </span>
        </span>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel run
        </Button>
      </div>
    );
  }

  if (phase === 'cancelled') {
    return (
      <div className="v-run-status v-run-status--stopped" role="status" aria-live="polite">
        <span className="v-run-status__label">
          {'Cancelled — this run stopped at your request.'}
        </span>
        {state.retryable ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  // failed, limit-reached, error
  const title =
    phase === 'limit-reached' ? 'Stopped — this run reached a safety limit.' : 'This run failed.';
  return (
    <div className="v-run-status v-run-status--failed" role="alert">
      <span className="v-run-status__label">
        {title}
        {state.failureMessage !== null ? (
          <span className="v-run-status__hint">{state.failureMessage}</span>
        ) : null}
      </span>
      {state.retryable ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
