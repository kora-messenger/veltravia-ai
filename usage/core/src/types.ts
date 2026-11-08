/**
 * Usage metering vocabulary (Step 52).
 *
 * Three things are kept apart on purpose, because adding them together produces
 * a number that means nothing:
 *
 *  - what Veltravia spends running the platform (`costClass: 'infrastructure'`);
 *  - what an AI provider charges for a request (`costClass: 'provider'`), which
 *    is the user's bill when they bring their own key and Veltravia's when the
 *    key is managed;
 *  - what the user has consumed out of an included allowance (`countsAgainst`
 *    on the record and the reserved capacity beside it).
 *
 * Every record also carries HOW it was obtained. `measured` is something the
 * process watched happen; `provider_reported` came from the provider; `derived`
 * is computed from stored records; `estimated` is a bound or a formula. Nothing
 * is ever labelled `measured` because it was convenient.
 */

export const USAGE_CATEGORIES = [
  'database_storage',
  'backend_execution',
  'file_storage',
  'bandwidth',
  'hosting',
  'background_jobs',
  'realtime',
  'ai_provider',
] as const;

export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

export const USAGE_UNITS = ['bytes', 'milliseconds', 'calls', 'connections', 'tokens'] as const;

export type UsageUnit = (typeof USAGE_UNITS)[number];

/** How a quantity was obtained. Never inferred; always set by the caller. */
export type MeasurementSource = 'measured' | 'provider_reported' | 'derived' | 'estimated';

/** Who pays for the resource this record describes. */
export type CostBearer = 'veltravia' | 'user_provider' | 'none';

/** Which side of the bill a record belongs to. */
export type CostClass = 'infrastructure' | 'provider';

export type UsageEnvironment = 'development' | 'production';

export type CostSource = 'provider_reported' | 'price_table' | 'unknown';

/**
 * `recorded` is a normal metered event. `excluded` is stored for audit but kept
 * out of totals (a duplicate that was recognised, an operation that was refused
 * before it consumed anything). `reconciled` is a record whose quantity was
 * revised from a later, better measurement; the original stays in the history.
 */
export type RecordStatus = 'recorded' | 'excluded' | 'reconciled';

export interface UsageRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly category: UsageCategory;
  /** What happened, e.g. `worker.run`, `file.upload`, `ai.usage`. */
  readonly operation: string;
  /** What the quantity is about, e.g. a model id, a file path, a queue name. */
  readonly resource: string;
  readonly quantity: number;
  readonly unit: UsageUnit;
  /**
   * Deduplication key: one operation is metered once. Retries pass the same key
   * and the store answers the record it already holds.
   */
  readonly operationKey: string;
  readonly occurredAt: string;
  readonly environment: UsageEnvironment;
  readonly costClass: CostClass;
  readonly costBearer: CostBearer;
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** Name of the allowance this consumption was counted against, when any. */
  readonly allowance: string | null;
  readonly costUsd: number | null;
  readonly costSource: CostSource;
  readonly source: MeasurementSource;
  readonly status: RecordStatus;
  readonly executionId: string | null;
  readonly taskId: string | null;
  readonly workerId: string | null;
  /** Free-form audit detail. Never credentials, prompts or file contents. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export const RESERVATION_STATUSES = ['held', 'committed', 'released', 'expired'] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Capacity claimed before the work starts. A hold is what makes a concurrency
 * limit real: two requests racing for the last slot both see the other's hold
 * only if the claim is atomic, so the store decides, not the caller.
 */
export interface UsageReservation {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly category: UsageCategory;
  readonly quantity: number;
  readonly unit: UsageUnit;
  readonly operationKey: string;
  readonly operationId: string | null;
  readonly status: ReservationStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly settledAt: string | null;
  readonly note: string | null;
}

/** An audited correction. Records are never rewritten; adjustments are added. */
export interface UsageAdjustment {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly category: UsageCategory;
  readonly quantity: number;
  readonly unit: UsageUnit;
  /** Positive credits capacity back, negative adds consumption. */
  readonly reason: string;
  readonly actor: string;
  readonly recordedAt: string;
  /** The record or reservation being corrected, when there is one. */
  readonly targetRecordId: string | null;
  readonly auditId: string;
}

export interface QuotaLimits {
  readonly databaseStorageBytes: number | null;
  readonly fileStorageBytes: number | null;
  readonly bandwidthBytes: number | null;
  readonly backendExecutionMs: number | null;
  readonly backendExecutionCalls: number | null;
  readonly backgroundJobs: number | null;
  readonly concurrentJobs: number | null;
  readonly realtimeConnections: number | null;
  readonly providerTokens: number | null;
}

export type QuotaLimitKey = keyof QuotaLimits;

/** One limit, resolved from the most specific scope that sets it. */
export interface ResolvedLimit {
  readonly key: QuotaLimitKey;
  readonly value: number | null;
  readonly scope: 'plan' | 'owner' | 'project' | 'none';
  readonly source: string;
  /**
   * `hard` means the server refuses the operation atomically. `best_effort`
   * means the quantity cannot be measured exactly before the work happens and
   * the limit is checked against what is observed.
   */
  readonly enforcement: 'hard' | 'best_effort';
}

export type QuotaCode =
  | 'QUOTA_EXCEEDED'
  | 'STORAGE_LIMIT_REACHED'
  | 'BANDWIDTH_LIMIT_REACHED'
  | 'EXECUTION_LIMIT_REACHED'
  | 'CONCURRENCY_LIMIT_REACHED'
  | 'PROVIDER_ALLOWANCE_EXHAUSTED';

export interface QuotaDecision {
  readonly allowed: boolean;
  readonly code: QuotaCode | null;
  readonly category: UsageCategory;
  readonly limitKey: QuotaLimitKey | null;
  readonly unit: UsageUnit | null;
  readonly limit: number | null;
  readonly used: number;
  readonly requested: number;
  readonly remaining: number | null;
  readonly scope: ResolvedLimit['scope'];
  readonly enforcement: ResolvedLimit['enforcement'];
  readonly message: string;
  /** The stored rows the decision rested on, so a refusal can be checked. */
  readonly evidence: readonly string[];
}

/**
 * What the platform can actually observe for a category, published by the API so
 * nobody mistakes a bound for a measurement.
 */
export interface MeasurementCapability {
  readonly category: UsageCategory;
  readonly status: 'measured' | 'derived' | 'estimated' | 'unavailable';
  readonly unit: UsageUnit;
  readonly source: MeasurementSource | null;
  readonly note: string;
}

export const USAGE_LIMITS = {
  /** Records one owner may hold before the oldest are pruned by the sweep. */
  maxRecordsPerOwner: 20_000,
  /** A hold nobody settles is released after this. */
  reservationTtlMs: 15 * 60 * 1000,
  /** Guard rail on the size of one record's audit detail. */
  maxDetailEntries: 24,
} as const;

export interface UsageError extends Error {
  readonly code: QuotaCode | 'USAGE_INVALID' | 'USAGE_DUPLICATE' | 'USAGE_UNAVAILABLE';
  readonly decision?: QuotaDecision;
}

export function isQuotaCode(value: string): value is QuotaCode {
  return (
    value === 'QUOTA_EXCEEDED' ||
    value === 'STORAGE_LIMIT_REACHED' ||
    value === 'BANDWIDTH_LIMIT_REACHED' ||
    value === 'EXECUTION_LIMIT_REACHED' ||
    value === 'CONCURRENCY_LIMIT_REACHED' ||
    value === 'PROVIDER_ALLOWANCE_EXHAUSTED'
  );
}

export class UsageProblem extends Error implements UsageError {
  readonly code: UsageError['code'];
  readonly decision?: QuotaDecision;

  constructor(code: UsageError['code'], message: string, decision?: QuotaDecision) {
    super(message);
    this.name = 'UsageProblem';
    this.code = code;
    if (decision !== undefined) this.decision = decision;
  }
}

export const isUsageProblem = (error: unknown): error is UsageProblem =>
  error instanceof UsageProblem ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'UsageProblem' &&
    typeof (error as { code?: unknown }).code === 'string');

/** The HTTP status a metering refusal answers with. */
export function usageHttpStatus(code: UsageError['code']): number {
  switch (code) {
    case 'QUOTA_EXCEEDED':
    case 'STORAGE_LIMIT_REACHED':
    case 'BANDWIDTH_LIMIT_REACHED':
    case 'EXECUTION_LIMIT_REACHED':
    case 'CONCURRENCY_LIMIT_REACHED':
    case 'PROVIDER_ALLOWANCE_EXHAUSTED':
      return 429;
    case 'USAGE_DUPLICATE':
      return 409;
    case 'USAGE_UNAVAILABLE':
      return 503;
    default:
      return 400;
  }
}

/** Which unit a category is measured in. One unit per category, so totals add up. */
export const CATEGORY_UNITS: Readonly<Record<UsageCategory, UsageUnit>> = {
  database_storage: 'bytes',
  backend_execution: 'milliseconds',
  file_storage: 'bytes',
  bandwidth: 'bytes',
  hosting: 'milliseconds',
  background_jobs: 'calls',
  realtime: 'connections',
  ai_provider: 'tokens',
};

export function unitFor(category: UsageCategory): UsageUnit {
  return CATEGORY_UNITS[category];
}
