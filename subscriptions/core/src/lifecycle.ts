/**
 * The subscription lifecycle, as pure functions.
 *
 * Nothing here reads a database or a clock: every function takes `now` and
 * returns a new record, so a test can walk a year of renewals in microseconds
 * and a handler cannot accidentally use two different times inside one change.
 *
 * The three decisions that matter:
 *
 *  - **Status follows the clock.** A record whose period has run out is expired
 *    even if no sweep has run, because the check is derived rather than hoped
 *    for. That is what stops an expired subscription from quietly keeping its
 *    entitlements until somebody notices.
 *  - **No proration, no refunds, no invented money.** A plan change takes effect
 *    now and leaves the period exactly where it was. What a plan change is worth
 *    in credit belongs to the payment milestone, not to this one.
 *  - **One period per renewal.** `applyRenewal` advances a single period, and the
 *    period it consumed is what the store records under a unique key, so a
 *    retried job cannot advance twice.
 */

import {
  canTransition,
  SubscriptionError,
  type SubscriptionPlanDefinition,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from './types.js';
import { DEVELOPMENT_PLAN_ID } from './plans.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses whose entitlements are in force while the period has not ended. */
export function entitledFor(status: SubscriptionStatus, periodEnded: boolean): boolean {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due':
      return true;
    case 'canceled':
      // A cancellation runs to the end of the period that was paid for.
      return !periodEnded;
    case 'suspended':
    case 'expired':
      return false;
  }
}

/**
 * Adds whole months in UTC, clamping the day.
 *
 * A period that starts on the 31st ends on the last day of a shorter month
 * rather than sliding into the next one, which is what a calendar month means.
 */
export function addMonths(iso: string, months: number): string {
  const from = new Date(iso);
  if (Number.isNaN(from.getTime())) {
    throw new SubscriptionError('INVALID_PERIOD', `"${iso}" is not a date.`, 400);
  }
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();
  const target = new Date(Date.UTC(year, month + months, 1, 0, 0, 0, 0));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  target.setUTCHours(
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds(),
    from.getUTCMilliseconds(),
  );
  return target.toISOString();
}

export interface Period {
  readonly start: string;
  readonly end: string;
}

/** One monthly period beginning at `start`. */
export function periodFor(start: string): Period {
  return { start, end: addMonths(start, 1) };
}

export interface StatusAssessment {
  /** What is actually true now, which is not always what is stored. */
  readonly status: SubscriptionStatus;
  readonly periodEnded: boolean;
  readonly entitled: boolean;
  readonly daysRemaining: number;
  /** True when the period ended and renewal is on: a sweep has work to do. */
  readonly renewalDue: boolean;
  /** True when the stored status is behind the clock. */
  readonly stale: boolean;
}

export function assess(record: SubscriptionRecord, now: string): StatusAssessment {
  const end = new Date(record.currentPeriodEnd).getTime();
  const at = new Date(now).getTime();
  const periodEnded = Number.isFinite(end) && at >= end;
  const daysRemaining = Number.isFinite(end) ? Math.max(0, Math.ceil((end - at) / DAY_MS)) : 0;

  let status: SubscriptionStatus = record.status;
  if (record.status === 'active' || record.status === 'trialing') {
    if (periodEnded) status = record.renews ? 'past_due' : 'expired';
  } else if (record.status === 'canceled' && periodEnded) {
    status = 'expired';
  } else if (record.status === 'past_due' && !periodEnded) {
    // A period was advanced but the status was not reset: the row is behind.
    status = 'active';
  }

  return {
    status,
    periodEnded,
    entitled: entitledFor(status, periodEnded),
    daysRemaining,
    renewalDue: periodEnded && record.renews && record.status !== 'suspended',
    stale: status !== record.status,
  };
}

/** The status a row should carry, for a sweep that wants to settle the row. */
export function settled(
  record: SubscriptionRecord,
  now: string,
  actor: string,
): SubscriptionRecord {
  const assessment = assess(record, now);
  if (!assessment.stale) return record;
  return {
    ...record,
    status: assessment.status,
    expiredAt: assessment.status === 'expired' ? (record.expiredAt ?? now) : record.expiredAt,
    updatedAt: now,
    lastChangedAt: now,
    lastChangedBy: actor,
    version: record.version + 1,
  };
}

function assertTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new SubscriptionError(
      'INVALID_TRANSITION',
      `A ${from} subscription cannot become ${to}.`,
      409,
      { from, to },
    );
  }
}

export interface AssignInput {
  readonly id: string;
  readonly ownerRef: string;
  readonly plan: SubscriptionPlanDefinition;
  readonly now: string;
  readonly actor: string;
  /** Renew automatically when the period ends. Defaults to true. */
  readonly renews?: boolean;
}

/** A brand new subscription, starting its first period now. */
export function assignSubscription(input: AssignInput): SubscriptionRecord {
  assertAssignable(input.plan);
  const period = periodFor(input.now);
  return {
    id: input.id,
    ownerRef: input.ownerRef,
    planId: input.plan.id,
    status: 'active',
    startedAt: input.now,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    renews: input.renews ?? true,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    suspendedAt: null,
    suspensionReason: null,
    expiredAt: null,
    lastChangedAt: input.now,
    lastChangedBy: input.actor,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function assertAssignable(plan: SubscriptionPlanDefinition): void {
  if (!plan.active) {
    throw new SubscriptionError(
      'PLAN_INACTIVE',
      `The ${plan.name} plan is not being assigned at the moment.`,
      409,
      { planId: plan.id },
    );
  }
}

export type PlanChangeDirection = 'upgrade' | 'downgrade' | 'same';

export interface PlanChangeInput {
  readonly record: SubscriptionRecord;
  readonly plan: SubscriptionPlanDefinition;
  readonly previousRank: number;
  readonly now: string;
  readonly actor: string;
}

/**
 * Moves a subscription onto another plan.
 *
 * The period is untouched on purpose: this build has no payment step, so there
 * is nothing to prorate and inventing one would be a claim about money the
 * product cannot honour. What the change does is swap the entitlements and the
 * quotas from this instant, and record that it happened.
 *
 * A suspended subscription is not moved by a plan change: it stays suspended
 * until somebody reactivates it, so a plan change cannot be used to melt a
 * suspension.
 */
export function changePlan(input: PlanChangeInput): {
  readonly record: SubscriptionRecord;
  readonly direction: PlanChangeDirection;
} {
  const { record, plan, now, actor } = input;
  assertAssignable(plan);
  if (record.status === 'suspended') {
    throw new SubscriptionError(
      'SUBSCRIPTION_SUSPENDED',
      'This subscription is suspended. Reactivate it before changing its plan.',
      409,
      { ownerRef: record.ownerRef },
    );
  }
  const assessment = assess(record, now);
  if (assessment.status === 'expired') {
    throw new SubscriptionError(
      'SUBSCRIPTION_EXPIRED',
      'This subscription has expired. Assign a plan instead of changing it.',
      409,
      { ownerRef: record.ownerRef },
    );
  }
  const direction: PlanChangeDirection =
    plan.rank === input.previousRank
      ? 'same'
      : plan.rank > input.previousRank
        ? 'upgrade'
        : 'downgrade';

  return {
    record: {
      ...record,
      planId: plan.id,
      status: assessment.status,
      lastChangedAt: now,
      lastChangedBy: actor,
      updatedAt: now,
      version: record.version + 1,
    },
    direction,
  };
}

export interface RenewalResult {
  readonly record: SubscriptionRecord;
  /** False when the period had not run out: the call did nothing. */
  readonly applied: boolean;
  /** The period that was consumed, which is the idempotency key. */
  readonly period: Period | null;
  /** How many further periods are still overdue after this one. */
  readonly stillBehind: number;
}

/**
 * Advances exactly one period.
 *
 * One period per call, not "jump to today": a subscription that lapsed for three
 * months is three renewals, and recording each one keeps the history honest and
 * the unique key meaningful. The caller loops while `stillBehind` is nonzero.
 */
export function applyRenewal(
  record: SubscriptionRecord,
  now: string,
  actor: string,
): RenewalResult {
  const assessment = assess(record, now);
  if (!assessment.periodEnded || !record.renews || record.status === 'suspended') {
    return { record, applied: false, period: null, stillBehind: 0 };
  }
  const consumed: Period = {
    start: record.currentPeriodStart,
    end: record.currentPeriodEnd,
  };
  const next: Period = periodFor(record.currentPeriodEnd);
  const renewed: SubscriptionRecord = {
    ...record,
    status: 'active',
    currentPeriodStart: next.start,
    currentPeriodEnd: next.end,
    expiredAt: null,
    lastChangedAt: now,
    lastChangedBy: actor,
    updatedAt: now,
    version: record.version + 1,
  };
  const nextAssessment = assess(renewed, now);
  return {
    record: renewed,
    applied: true,
    period: consumed,
    stillBehind: nextAssessment.periodEnded && renewed.renews ? 1 : 0,
  };
}

export function cancelSubscription(
  record: SubscriptionRecord,
  now: string,
  actor: string,
  immediate = false,
): SubscriptionRecord {
  const assessment = assess(record, now);
  assertTransition(assessment.status, 'canceled');
  return {
    ...record,
    status: immediate ? 'expired' : 'canceled',
    renews: false,
    cancelAtPeriodEnd: !immediate,
    canceledAt: now,
    expiredAt: immediate ? now : record.expiredAt,
    lastChangedAt: now,
    lastChangedBy: actor,
    updatedAt: now,
    version: record.version + 1,
  };
}

export function suspendSubscription(
  record: SubscriptionRecord,
  now: string,
  actor: string,
  reason: string,
): SubscriptionRecord {
  const assessment = assess(record, now);
  assertTransition(assessment.status, 'suspended');
  return {
    ...record,
    status: 'suspended',
    suspendedAt: now,
    suspensionReason: reason.trim() === '' ? 'Suspended by an operator.' : reason.trim(),
    lastChangedAt: now,
    lastChangedBy: actor,
    updatedAt: now,
    version: record.version + 1,
  };
}

/**
 * Puts a suspended subscription back in force.
 *
 * If its period ran out while it was suspended, reactivation starts a fresh
 * period from now rather than back-dating one, because the account did not have
 * the entitlements in between.
 */
export function reactivateSubscription(
  record: SubscriptionRecord,
  now: string,
  actor: string,
): SubscriptionRecord {
  const assessment = assess(record, now);
  assertTransition('suspended', 'active');
  if (assessment.periodEnded) {
    const period = periodFor(now);
    return {
      ...record,
      status: 'active',
      renews: true,
      cancelAtPeriodEnd: false,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      suspendedAt: null,
      suspensionReason: null,
      canceledAt: null,
      expiredAt: null,
      lastChangedAt: now,
      lastChangedBy: actor,
      updatedAt: now,
      version: record.version + 1,
    };
  }
  return {
    ...record,
    status: 'active',
    suspendedAt: null,
    suspensionReason: null,
    lastChangedAt: now,
    lastChangedBy: actor,
    updatedAt: now,
    version: record.version + 1,
  };
}

export function expireSubscription(
  record: SubscriptionRecord,
  now: string,
  actor: string,
): SubscriptionRecord {
  return {
    ...record,
    status: 'expired',
    renews: false,
    expiredAt: record.expiredAt ?? now,
    lastChangedAt: now,
    lastChangedBy: actor,
    updatedAt: now,
    version: record.version + 1,
  };
}

/** True when a plan is the fallback allowance, so a change *to* it is a downgrade. */
export function isDevelopmentPlan(planId: string): boolean {
  return planId === DEVELOPMENT_PLAN_ID;
}
