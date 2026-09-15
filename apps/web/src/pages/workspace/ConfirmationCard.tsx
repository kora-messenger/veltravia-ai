import { Button } from '../../components/ui/Button';
import type { PendingConfirmationView } from '../../api/agents';

/**
 * Human-confirmation card (Step 11C-3).
 *
 * Renders the run's pending tool confirmation and collects the human
 * decision. The card is a pure presentation surface: it never decides,
 * never retries on its own, and never fabricates state. Every visible
 * fact comes from the server's confirmation metadata; every decision is
 * delivered to the server, which alone validates it (expiry, input
 * binding, permissions) and returns the run's next state.
 */

export interface ConfirmationCardProps {
  /** The server-reported pending confirmation. */
  pendingConfirmation: PendingConfirmationView;
  /** True while a decision is being delivered to the server. */
  submitting: boolean;
  /** Friendly text when delivering a decision failed. */
  error: string | null;
  /** Delivers the human decision to the server. */
  onDecision(decision: 'approve' | 'reject'): void;
}

const RISK_LABEL: Record<string, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

const STATE_NOTE: Record<NonNullable<PendingConfirmationView['state']>, string> = {
  required: 'The run stays paused until you decide.',
  approved: 'A decision was recorded. The run is resuming.',
  rejected: 'The tool call was denied. Nothing was executed.',
  expired: 'This request expired before a decision was made. It can no longer be approved.',
};

export function ConfirmationCard({
  pendingConfirmation,
  submitting,
  error,
  onDecision,
}: ConfirmationCardProps) {
  const state = pendingConfirmation.state;
  const decidable = state === 'required' && !submitting;
  const riskLabel =
    pendingConfirmation.riskLevel !== null
      ? (RISK_LABEL[pendingConfirmation.riskLevel] ?? `${pendingConfirmation.riskLevel} risk`)
      : 'Risk level unavailable';

  return (
    <section
      className="v-confirm-card"
      role="group"
      aria-labelledby="v-confirm-card__title"
      data-testid="confirmation-card"
    >
      <p className="v-confirm-card__eyebrow">Veltravia AI needs your approval</p>
      <h3 className="v-confirm-card__title" id="v-confirm-card__title">
        Run {pendingConfirmation.toolId}?
      </h3>
      <p className="v-confirm-card__body">
        The agent asked to run the tool{' '}
        <code className="v-confirm-card__tool">{pendingConfirmation.toolId}</code>. Approving lets
        Veltravia's Tool System execute it once; rejecting skips it and the run continues without
        it.
      </p>
      <div className="v-confirm-card__meta">
        <span
          className={`v-confirm-card__risk v-confirm-card__risk--${pendingConfirmation.riskLevel ?? 'unknown'}`}
        >
          {riskLabel}
        </span>
        {state !== null && (
          <span className="v-confirm-card__state" data-testid="confirmation-state">
            {state === 'required'
              ? 'Awaiting your decision'
              : state === 'approved'
                ? 'Approved'
                : state === 'rejected'
                  ? 'Rejected'
                  : 'Expired'}
          </span>
        )}
      </div>
      <div className="v-confirm-card__actions">
        <Button
          variant="danger"
          onClick={() => onDecision('reject')}
          disabled={!decidable}
          data-testid="confirmation-reject"
        >
          Reject
        </Button>
        <Button
          variant="primary"
          onClick={() => onDecision('approve')}
          disabled={!decidable}
          data-testid="confirmation-approve"
        >
          Approve
        </Button>
      </div>
      {state !== null && <p className="v-confirm-card__note">{STATE_NOTE[state]}</p>}
      {submitting && <p className="v-confirm-card__note">Sending your decision…</p>}
      {error !== null && (
        <p className="v-confirm-card__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
