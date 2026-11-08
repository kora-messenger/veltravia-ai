import type { BadgeTone } from '../../components/ui';
import type {
  FailureCategory,
  RecoveryCaseView,
  RecoveryConfidence,
  RecoveryStatus,
  RecoveryVerificationView,
} from '../../api/recovery';

/**
 * Presentation for the recovery records (Step 49).
 *
 * Two rules live here rather than in the page:
 *  - a case is only described as recovered when a stored verification run
 *    actually passed and actually ran something;
 *  - every label names a fact the server reported, never a guess about why a
 *    worker failed.
 */

export const RECOVERY_STATUS_LABEL: Record<RecoveryStatus, string> = {
  open: 'Awaiting diagnosis',
  diagnosing: 'Diagnosing',
  repairing: 'Being repaired',
  awaiting_verification: 'Awaiting verification',
  recovered: 'Recovered',
  escalated: 'Needs intervention',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

export const RECOVERY_STATUS_TONE: Record<RecoveryStatus, BadgeTone> = {
  open: 'info',
  diagnosing: 'info',
  repairing: 'info',
  awaiting_verification: 'warning',
  recovered: 'success',
  escalated: 'error',
  blocked: 'warning',
  cancelled: 'neutral',
};

export const CATEGORY_LABEL: Record<FailureCategory, string> = {
  missing_deliverables: 'Declared work was not produced',
  unverified_completion: 'Finished without proof',
  verification_failed: 'Tests or checks failed',
  worker_timeout: 'Ran out of time',
  worker_cancelled: 'Cancelled while running',
  worker_blocked: 'Blocked, not finished',
  permission_refused: 'Not allowed to do the work',
  change_conflict: 'Conflicting changes',
  incompatible_output: 'Output did not fit',
  repeated_attempts: 'Repeated attempts failed',
  unknown: 'Cause not established',
};

export const CONFIDENCE_LABEL: Record<RecoveryConfidence, string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

export const CONFIDENCE_TONE: Record<RecoveryConfidence, BadgeTone> = {
  low: 'warning',
  medium: 'info',
  high: 'success',
};

/** Plain words for a failure category, including one this build does not know. */
export function categoryLabel(category: string | null): string {
  if (category === null) return 'Not classified';
  return CATEGORY_LABEL[category as FailureCategory] ?? category.replace(/_/g, ' ');
}

export interface AttemptBudget {
  readonly used: number;
  readonly max: number;
  readonly remaining: number;
  readonly exhausted: boolean;
}

export function attemptBudget(record: RecoveryCaseView): AttemptBudget {
  const max = Math.max(record.limits.maxAttempts, 0);
  const used = Math.max(record.attempts, 0);
  return {
    used,
    max,
    remaining: Math.max(max - used, 0),
    exhausted: max > 0 && used >= max,
  };
}

export type VerificationTone = 'success' | 'error' | 'neutral';

export interface VerificationSummary {
  readonly label: string;
  readonly tone: VerificationTone;
  /** What the run actually proves, or why it proves nothing. */
  readonly detail: string;
  readonly ran: boolean;
}

/**
 * Reads the stored run only. `executed` is the field that separates "the tests
 * passed" from "no command ran, so nothing was proven".
 */
export function summariseRecoveryVerification(
  verification: RecoveryVerificationView | null,
): VerificationSummary {
  if (verification === null) {
    return {
      label: 'No verification run',
      tone: 'neutral',
      detail: 'Nothing has been executed for this case, so no outcome is proven.',
      ran: false,
    };
  }
  if (!verification.executed) {
    return {
      label: 'Nothing was executed',
      tone: 'neutral',
      detail: 'The run was recorded but no command ran, so it cannot support a recovery.',
      ran: false,
    };
  }
  if (verification.status === 'passed') {
    return {
      label: 'Passed',
      tone: 'success',
      detail: 'Stored evidence from the verification run for this case.',
      ran: true,
    };
  }
  const failed =
    verification.failedOperations.length === 0
      ? ''
      : ` Failing: ${verification.failedOperations.join(', ')}.`;
  return {
    label: verification.status === 'failed' ? 'Failed' : verification.status,
    tone: 'error',
    detail: `The run did not pass, so the case is not recovered.${failed}`,
    ran: true,
  };
}

/**
 * The one place that answers "may this be called recovered?". The server's
 * status alone is not enough: a stored, executed, passing run must exist.
 */
export function isRecoveredWithEvidence(record: RecoveryCaseView): boolean {
  if (record.status !== 'recovered') return false;
  const verification = record.verification;
  return verification !== null && verification.executed && verification.status === 'passed';
}

export interface CaseHeadline {
  readonly label: string;
  readonly tone: BadgeTone;
  /** Set when the record and the evidence disagree. */
  readonly warning: string | null;
}

/**
 * What to show as the case's state. A record that says recovered without a
 * passing stored run is shown as awaiting verification with a warning, because
 * displaying "recovered" there would be a claim nothing backs.
 */
export function caseHeadline(record: RecoveryCaseView): CaseHeadline {
  if (record.status === 'recovered') {
    if (isRecoveredWithEvidence(record)) {
      return { label: RECOVERY_STATUS_LABEL.recovered, tone: 'success', warning: null };
    }
    return {
      label: RECOVERY_STATUS_LABEL.awaiting_verification,
      tone: 'warning',
      warning:
        'This case is marked recovered, but no stored verification run passed. It is shown as awaiting verification until evidence exists.',
    };
  }
  return {
    label: RECOVERY_STATUS_LABEL[record.status],
    tone: RECOVERY_STATUS_TONE[record.status],
    warning: null,
  };
}

export const RECOVERY_NOTIFICATION_LABEL = {
  recovery_started: 'A Superagent failure was diagnosed',
  repair_assigned: 'A repair Superagent was assigned',
  recovery_needs_intervention: 'A recovery needs your decision',
  recovery_budget_exhausted: 'A recovery used all its attempts',
  recovery_recovered: 'A recovery finished with passing evidence',
  recovery_cancelled: 'A recovery was cancelled',
} as const;

export type RecoveryNotification = keyof typeof RECOVERY_NOTIFICATION_LABEL;

/**
 * Announces recovery transitions once each. Routine progress (diagnosing,
 * repairing) is deliberately not announced: it is visible on the page and would
 * otherwise fire a toast every poll.
 */
export function recoveryNotificationsFor(
  previous: readonly RecoveryCaseView[],
  next: readonly RecoveryCaseView[],
  seen: Set<string>,
): readonly { readonly key: string; readonly event: RecoveryNotification }[] {
  const before = new Map(previous.map((record) => [record.id, record]));
  const out: { key: string; event: RecoveryNotification }[] = [];
  const push = (key: string, event: RecoveryNotification): void => {
    if (seen.has(key)) return;
    out.push({ key, event });
  };

  for (const record of next) {
    const was = before.get(record.id);
    if (was === undefined) {
      // A newly seen case is only news once it has a diagnosis; a fresh 'open'
      // case in the same poll as its creation is the same event.
      if (record.status !== 'open') push(`${record.id}:started`, 'recovery_started');
      continue;
    }
    if (was.status === record.status) continue;
    if (record.status === 'repairing') {
      push(`${record.id}:${record.attempts}:repair`, 'repair_assigned');
    }
    if (record.status === 'escalated') {
      push(`${record.id}:${record.status}:escalated`, 'recovery_needs_intervention');
      if (attemptBudget(record).exhausted) {
        push(`${record.id}:budget:exhausted`, 'recovery_budget_exhausted');
      }
    }
    if (record.status === 'cancelled') {
      push(`${record.id}:cancelled`, 'recovery_cancelled');
    }
    if (isRecoveredWithEvidence(record)) {
      push(`${record.id}:recovered`, 'recovery_recovered');
    }
  }
  return out;
}
