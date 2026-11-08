/**
 * What a unit of measured usage costs in credits (Step 53).
 *
 * These are configurable defaults, not a claim about the market. They exist so
 * the wallet can be exercised end to end with numbers somebody chose on purpose,
 * and they are read from configuration on every call rather than compiled into
 * the ledger, so changing a rate never rewrites history: an entry records the
 * credits it charged at the moment it charged them.
 *
 * The rules that are not configurable, because they are policy rather than
 * price:
 *
 *  - a usage record that is not `recorded` (an excluded duplicate, a superseded
 *    measurement) charges nothing;
 *  - a record whose cost is borne by the user's own provider key charges
 *    nothing. Direct AI-provider spend is the user's contract with the provider
 *    and is never converted into Veltravia credits;
 *  - a category with no rate charges nothing, and the reason is reported rather
 *    than the amount being guessed.
 */

import { round4, type WalletUnit } from './types.js';

export const CREDIT_RATE_VERSION = 'veltravia-credits-2026-11';

export type BillableCategory =
  | 'database_storage'
  | 'backend_execution'
  | 'file_storage'
  | 'bandwidth'
  | 'hosting'
  | 'background_jobs'
  | 'realtime'
  | 'ai_provider';

/** The units the meter publishes, restated here so the wallet compiles alone. */
const CATEGORY_UNIT: Record<
  BillableCategory,
  'bytes' | 'milliseconds' | 'calls' | 'connections' | 'tokens'
> = {
  database_storage: 'bytes',
  backend_execution: 'milliseconds',
  file_storage: 'bytes',
  bandwidth: 'bytes',
  hosting: 'milliseconds',
  background_jobs: 'calls',
  realtime: 'connections',
  ai_provider: 'tokens',
};

export interface CreditRate {
  /** Credits charged per `per` units. */
  readonly credits: number;
  /** Quantity that costs `credits`. */
  readonly per: number;
}

export type CreditRates = Readonly<Record<BillableCategory, CreditRate | null>>;

/**
 * Documented defaults. They are deliberately conservative and deliberately
 * boring: a job is one billed unit, worker time is billed per minute of wall
 * clock, and storage and bandwidth are not billed at all because nothing
 * measures them yet (Step 52 says so too).
 */
export const DEFAULT_CREDIT_RATES: CreditRates = {
  background_jobs: { credits: 5, per: 1 },
  backend_execution: { credits: 1, per: 60_000 },
  hosting: { credits: 1, per: 3_600_000 },
  // Managed provider tokens: only reachable when Veltravia holds the key.
  ai_provider: { credits: 1, per: 1_000 },
  database_storage: null,
  file_storage: null,
  bandwidth: null,
  realtime: null,
};

/** A bare category map, which is what the environment variable holds. */
export type CreditRateConfig = Partial<Record<BillableCategory, CreditRate | null>>;

export function parseCreditRates(raw: unknown): CreditRates {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CREDIT_RATES;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A malformed override must not silently bill at zero; the defaults are
      // the documented behaviour and the caller can see the mistake in logs.
      return DEFAULT_CREDIT_RATES;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CREDIT_RATES;
  const source = parsed as CreditRateConfig;
  const next: Record<BillableCategory, CreditRate | null> = { ...DEFAULT_CREDIT_RATES };
  for (const [key, value] of Object.entries(source)) {
    const category = key as BillableCategory;
    if (!(category in CATEGORY_UNIT)) continue;
    if (value === null) {
      next[category] = null;
      continue;
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as CreditRate).credits === 'number' &&
      typeof (value as CreditRate).per === 'number' &&
      (value as CreditRate).credits >= 0 &&
      (value as CreditRate).per > 0
    ) {
      next[category] = {
        credits: (value as CreditRate).credits,
        per: (value as CreditRate).per,
      };
    }
  }
  return next;
}

/** The part of a usage record this package needs. Structural on purpose. */
export interface BillableUsageRecord {
  readonly operationKey: string;
  readonly category: BillableCategory;
  readonly quantity: number;
  readonly unit: string;
  readonly costBearer: 'veltravia' | 'user_provider' | 'none';
  readonly status: 'recorded' | 'excluded' | 'reconciled';
  readonly occurredAt: string;
  readonly projectId: string | null;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
}

export type BillingSkipReason = 'not_recorded' | 'user_pays_provider' | 'no_rate' | 'zero_quantity';

export interface UsageCharge {
  readonly credits: number;
  readonly category: BillableCategory;
  readonly quantity: number;
  readonly rate: CreditRate;
  readonly unit: WalletUnit;
  readonly rateVersion: string;
}

export interface UsageChargeSkip {
  readonly reason: BillingSkipReason;
  readonly detail: string;
}

/**
 * The one place that decides whether usage becomes a credit charge.
 *
 * `usage:${operationKey}` is the idempotency key the caller should pass, which
 * is what stops the same metered event being charged twice when a worker
 * retries, a route is replayed, or a sweep records the same worker again.
 */
export function chargeForUsage(
  record: BillableUsageRecord,
  rates: CreditRates = DEFAULT_CREDIT_RATES,
): UsageCharge | UsageChargeSkip {
  if (record.status !== 'recorded') {
    return {
      reason: 'not_recorded',
      detail: `Recorded as ${record.status}: it is audit history, not a billable event.`,
    };
  }
  if (record.costBearer === 'user_provider') {
    return {
      reason: 'user_pays_provider',
      detail:
        'The provider call used the owner’s own key, so it is paid on their provider account.',
    };
  }
  const rate = rates[record.category];
  if (rate === null || rate === undefined) {
    return {
      reason: 'no_rate',
      detail: `No credit rate is configured for ${record.category}, so nothing is charged.`,
    };
  }
  if (!(record.quantity > 0)) {
    return {
      reason: 'zero_quantity',
      detail: 'Nothing was consumed, so there is nothing to charge.',
    };
  }
  const credits = Math.max(0.0001, round4((record.quantity / rate.per) * rate.credits));
  return {
    credits,
    category: record.category,
    quantity: record.quantity,
    rate,
    unit: 'credits',
    rateVersion: CREDIT_RATE_VERSION,
  };
}

export function isCharge(value: UsageCharge | UsageChargeSkip): value is UsageCharge {
  return 'credits' in value;
}

/** Human-readable rate table for the dashboard and the docs. */
export function describeRates(rates: CreditRates = DEFAULT_CREDIT_RATES): readonly string[] {
  return Object.entries(rates).map(([category, rate]) =>
    rate === null
      ? `${category}: not billed`
      : `${category}: ${rate.credits} credit${rate.credits === 1 ? '' : 's'} per ${rate.per.toLocaleString('en-US')} ${CATEGORY_UNIT[category as BillableCategory]}`,
  );
}

export function unitForCategory(category: BillableCategory): string {
  return CATEGORY_UNIT[category];
}
