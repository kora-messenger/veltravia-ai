/**
 * Retry policy.
 *
 * Two failures this file prevents: retrying forever, and retrying the same
 * thing without waiting. Every attempt is charged against a budget that the
 * caller cannot widen at the call site, and backoff is measured from the
 * attempt number rather than from wall-clock guesses.
 */

import {
  DEFAULT_RECOVERY_LIMITS,
  HARD_RECOVERY_LIMITS,
  type RecoveryCaseRecord,
  type RecoveryDiagnosis,
  type RecoveryLimits,
} from './types.js';

/** Clamp a caller's requested limits to the deployment ceilings. */
export function clampLimits(requested: Partial<RecoveryLimits> | null | undefined): RecoveryLimits {
  const pick = (key: keyof RecoveryLimits): number => {
    const wanted = requested?.[key];
    const fallback = DEFAULT_RECOVERY_LIMITS[key];
    const ceiling = HARD_RECOVERY_LIMITS[key];
    if (wanted === undefined || wanted === null || Number.isNaN(wanted)) return fallback;
    if (wanted < 1) return fallback;
    return Math.min(Math.floor(wanted), ceiling);
  };
  return {
    maxAttempts: pick('maxAttempts'),
    maxTotalDurationMs: pick('maxTotalDurationMs'),
    maxReassignments: pick('maxReassignments'),
    maxModelCalls: pick('maxModelCalls'),
    maxConcurrentRepairs: pick('maxConcurrentRepairs'),
    backoffBaseMs: pick('backoffBaseMs'),
    backoffCeilingMs: pick('backoffCeilingMs'),
  };
}

/** Doubling backoff, capped. Attempt 1 waits nothing. */
export function backoffFor(attempt: number, limits: RecoveryLimits): number {
  if (attempt <= 1) return 0;
  const raw = limits.backoffBaseMs * 2 ** (attempt - 2);
  return Math.min(raw, limits.backoffCeilingMs);
}

export interface BudgetState {
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
  readonly attemptsExhausted: boolean;
  readonly timeUsedMs: number;
  readonly timeExhausted: boolean;
  readonly reassignmentsUsed: number;
  readonly reassignmentsExhausted: boolean;
  readonly modelCallsUsed: number;
  readonly modelCallsExhausted: boolean;
  readonly nextAttemptAt: string | null;
  readonly waiting: boolean;
  /** First exhausted budget, or null when the case may still make progress. */
  readonly exhaustedBy: 'attempts' | 'time' | 'reassignments' | 'model_calls' | null;
}

export function budgetOf(record: RecoveryCaseRecord, now: Date): BudgetState {
  const started = Date.parse(record.createdAt);
  const timeUsedMs = Math.max(0, now.getTime() - started);
  const notBefore =
    record.nextAttemptNotBefore === null ? null : Date.parse(record.nextAttemptNotBefore);
  const waiting = notBefore !== null && notBefore > now.getTime();

  const attemptsExhausted = record.attempts >= record.limits.maxAttempts;
  const timeExhausted = timeUsedMs >= record.limits.maxTotalDurationMs;
  const reassignmentsExhausted = record.reassignments >= record.limits.maxReassignments;
  const modelCallsExhausted = record.modelCalls >= record.limits.maxModelCalls;

  return {
    attemptsUsed: record.attempts,
    attemptsRemaining: Math.max(0, record.limits.maxAttempts - record.attempts),
    attemptsExhausted,
    timeUsedMs,
    timeExhausted,
    reassignmentsUsed: record.reassignments,
    reassignmentsExhausted,
    modelCallsUsed: record.modelCalls,
    modelCallsExhausted,
    nextAttemptAt: record.nextAttemptNotBefore,
    waiting,
    exhaustedBy: attemptsExhausted
      ? 'attempts'
      : timeExhausted
        ? 'time'
        : reassignmentsExhausted
          ? 'reassignments'
          : modelCallsExhausted
            ? 'model_calls'
            : null,
  };
}

export type Rejection =
  | 'budget_exhausted'
  | 'backoff_waiting'
  | 'insufficient_evidence'
  | 'policy_refusal'
  | 'needs_human'
  | 'case_closed'
  | 'concurrency_limit'
  | 'duplicate_attempt';

export interface Decision {
  readonly allowed: boolean;
  readonly rejection: Rejection | null;
  /** Plain-language explanation, always present. */
  readonly reason: string;
  readonly waitedMs: number;
}

const CLOSED: readonly string[] = ['recovered', 'escalated', 'blocked', 'cancelled'];

/**
 * May another repair attempt start for this case, right now?
 *
 * The diagnosis is a second gate on purpose: a case with no justified cause is
 * escalated, never retried "to see what happens".
 */
export function canAttempt(input: {
  readonly record: RecoveryCaseRecord;
  readonly diagnosis: RecoveryDiagnosis | null;
  readonly now: Date;
  readonly activeRepairs: number;
}): Decision {
  const { record, diagnosis, now } = input;
  if (CLOSED.includes(record.status)) {
    return {
      allowed: false,
      rejection: 'case_closed',
      reason: `The case is ${record.status}; no further attempt may start.`,
      waitedMs: 0,
    };
  }
  if (diagnosis === null || diagnosis.insufficient || diagnosis.recommendedAction === null) {
    return {
      allowed: false,
      rejection: 'insufficient_evidence',
      reason: 'No diagnosis justifies a repair attempt.',
      waitedMs: 0,
    };
  }
  const budget = budgetOf(record, now);
  if (budget.exhaustedBy !== null) {
    return {
      allowed: false,
      rejection: 'budget_exhausted',
      reason: `The ${budget.exhaustedBy.replace('_', ' ')} budget is spent.`,
      waitedMs: 0,
    };
  }
  if (budget.waiting) {
    const notBefore = record.nextAttemptNotBefore as string;
    return {
      allowed: false,
      rejection: 'backoff_waiting',
      reason: `Backoff is still running until ${notBefore}.`,
      waitedMs: Math.max(0, Date.parse(notBefore) - now.getTime()),
    };
  }
  if (input.activeRepairs >= record.limits.maxConcurrentRepairs) {
    return {
      allowed: false,
      rejection: 'concurrency_limit',
      reason: `${input.activeRepairs} repair attempts are already running; the limit is ${record.limits.maxConcurrentRepairs}.`,
      waitedMs: 0,
    };
  }
  if (diagnosis.classification === 'policy') {
    return {
      allowed: false,
      rejection: 'policy_refusal',
      reason: 'A policy refusal is not retried automatically.',
      waitedMs: 0,
    };
  }
  if (diagnosis.classification === 'needs_human') {
    return {
      allowed: false,
      rejection: 'needs_human',
      reason: 'This needs an owner decision before any further work.',
      waitedMs: 0,
    };
  }
  const waitedMs = backoffFor(record.attempts + 1, record.limits);
  return { allowed: true, rejection: null, reason: 'A bounded attempt may start.', waitedMs };
}

/** What the case looks like once its budget is gone. */
export function exhaustionMessage(record: RecoveryCaseRecord): string {
  const budget = budgetOf(record, new Date(Date.parse(record.updatedAt)));
  switch (budget.exhaustedBy) {
    case 'attempts':
      return `Stopped after ${record.attempts} of ${record.limits.maxAttempts} repair attempts without a verified result.`;
    case 'time':
      return `Stopped after ${Math.round(budget.timeUsedMs / 60_000)} minutes, the ceiling for this case.`;
    case 'reassignments':
      return `Stopped after ${record.reassignments} reassignments; moving the work again was not permitted.`;
    case 'model_calls':
      return `Stopped after ${record.modelCalls} model calls, the ceiling for this case.`;
    default:
      return 'Recovery stopped.';
  }
}
