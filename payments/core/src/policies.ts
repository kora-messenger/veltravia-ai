/**
 * Billing policies: the choices an operator makes that change behaviour.
 *
 * Every one of these is a value in configuration with a default that is safe and
 * visible. None of them is a guess about a market, a tax office or a provider's
 * terms:
 *
 *  - **Refund policy** decides whether money back also ends the plan. The default
 *    (`none`) leaves the paid period alone, because a refund is a commercial
 *    decision and taking access away in the same breath is not one this build
 *    should make silently.
 *  - **Grace policy** decides how long a workspace keeps working after a failed
 *    renewal. It never deletes work: the default keeps everything readable and
 *    only stops new paid-tier work.
 *  - **Retry policy** decides when a failed renewal is tried again. It is a finite
 *    list, never "keep trying".
 *  - **Top-ups** are off by default. A subscription is not a purchase of extra
 *    credits, and this build will not assume that it is.
 */

export const REFUND_POLICIES = ['none', 'cancel-at-period-end', 'cancel-immediately'] as const;
export type RefundPolicy = (typeof REFUND_POLICIES)[number];

export const DEFAULT_REFUND_POLICY: RefundPolicy = 'none';

export interface RefundEffect {
  readonly policy: RefundPolicy;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelImmediately: boolean;
  readonly note: string;
  /** True when this build will not change the subscription at all. */
  readonly leavesSubscriptionAlone: boolean;
}

export function refundEffect(policy: RefundPolicy): RefundEffect {
  switch (policy) {
    case 'cancel-at-period-end':
      return {
        policy,
        cancelAtPeriodEnd: true,
        cancelImmediately: false,
        note: 'The subscription keeps its paid period and will not renew.',
        leavesSubscriptionAlone: false,
      };
    case 'cancel-immediately':
      return {
        policy,
        cancelAtPeriodEnd: false,
        cancelImmediately: true,
        note: 'The subscription ends now and the account falls back to the included allowance.',
        leavesSubscriptionAlone: false,
      };
    case 'none':
      return {
        policy,
        cancelAtPeriodEnd: false,
        cancelImmediately: false,
        note: 'The paid period is untouched: a refund does not shorten what was paid for.',
        leavesSubscriptionAlone: true,
      };
  }
}

export interface GracePolicy {
  /** Days a workspace keeps its plan after a failed renewal. `0` means no grace. */
  readonly days: number;
  /** Days before a renewal is attempted that the owner is told it is coming. */
  readonly reminderDays: number;
  /** Minutes between retries of a failed renewal, in order. */
  readonly retryScheduleMinutes: readonly number[];
  /** Whether a lapsed plan falls back to the included allowance (it always does). */
  readonly fallsBackToIncludedAllowance: true;
}

export const DEFAULT_GRACE_POLICY: GracePolicy = {
  days: 7,
  reminderDays: 3,
  retryScheduleMinutes: [1440, 4320],
  fallsBackToIncludedAllowance: true,
};

export function normalizeGracePolicy(input: unknown): GracePolicy {
  const draft = (input ?? {}) as Record<string, unknown>;
  const days = draft.days === undefined ? DEFAULT_GRACE_POLICY.days : Number(draft.days);
  if (!Number.isInteger(days) || days < 0 || days > 90) {
    throw new Error('A grace period is 0 to 90 whole days.');
  }
  const reminderDays =
    draft.reminderDays === undefined
      ? DEFAULT_GRACE_POLICY.reminderDays
      : Number(draft.reminderDays);
  if (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 60) {
    throw new Error('A renewal reminder is 0 to 60 whole days before the renewal.');
  }
  const rawSchedule = draft.retryScheduleMinutes;
  let schedule: readonly number[] = DEFAULT_GRACE_POLICY.retryScheduleMinutes;
  if (Array.isArray(rawSchedule)) {
    if (rawSchedule.length > 5) throw new Error('At most five renewal retries are scheduled.');
    const parsed = rawSchedule.map((value) => Number(value));
    if (parsed.some((value) => !Number.isInteger(value) || value < 1 || value > 20_160)) {
      throw new Error('A renewal retry is 1 to 20,160 minutes after the previous attempt.');
    }
    schedule = parsed;
  }
  return {
    days,
    reminderDays,
    retryScheduleMinutes: schedule,
    fallsBackToIncludedAllowance: true,
  };
}

export interface TopUpPolicy {
  /** Off unless an operator turns it on. A subscription does not imply top-ups. */
  readonly enabled: boolean;
  /** The smallest and largest top-up an operator is willing to sell, in credits. */
  readonly minimumCredits: number;
  readonly maximumCredits: number;
  /** Which lanes may be topped up. The two lanes are never converted into one another. */
  readonly lanes: readonly ('message' | 'integration')[];
}

export const DEFAULT_TOP_UP_POLICY: TopUpPolicy = {
  enabled: false,
  minimumCredits: 1_000,
  maximumCredits: 100_000,
  lanes: [],
};

/** How long a customer has to finish a hosted checkout before it stops being payable. */
export const INTENT_TTL_MS = 60 * 60 * 1000;

/**
 * The renewal charge for a plan. A renewal keeps the price *and* the currency the
 * subscription was bought in, so a price change does not silently move somebody
 * to a different currency.
 */
export interface RenewalExpectation {
  readonly planId: string;
  readonly interval: 'monthly' | 'yearly';
  readonly currency: string;
  readonly amountMinor: number;
}

export function renewalDueAt(input: {
  readonly currentPeriodEnd: string;
  readonly graceDays: number;
}): { readonly graceEndsAt: string; readonly retryAt: (index: number) => string } {
  const end = Date.parse(input.currentPeriodEnd);
  const graceEndsAt = new Date(end + input.graceDays * 86_400_000).toISOString();
  return {
    graceEndsAt,
    retryAt: (index: number) =>
      new Date(Date.parse(graceEndsAt) + Math.max(0, index) * 86_400_000).toISOString(),
  };
}
