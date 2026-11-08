/**
 * Limits: where a number comes from, and what happens when it is reached.
 *
 * A limit is resolved from the most specific scope that sets it - project, then
 * owner, then plan - and the resolution is returned with the decision so a
 * refusal can always name its source. `undefined` means "this scope says
 * nothing"; `null` means "explicitly unlimited here", which is a different
 * statement and is preserved as one.
 */

import { PLAN_CATALOG, capabilityFor, quotaForCategory, type PlanId } from './catalog.js';
import type {
  MeasurementCapability,
  QuotaDecision,
  QuotaLimitKey,
  QuotaLimits,
  ResolvedLimit,
  UsageCategory,
  UsageUnit,
} from './types.js';
import { unitFor } from './types.js';

/** Per-scope overrides. A missing key is "not set" for that scope. */
export type QuotaOverrides = Readonly<Partial<Record<QuotaLimitKey, number | null>>>;

export const QUOTA_LIMIT_KEYS: readonly QuotaLimitKey[] = [
  'databaseStorageBytes',
  'fileStorageBytes',
  'bandwidthBytes',
  'backendExecutionMs',
  'backendExecutionCalls',
  'backgroundJobs',
  'concurrentJobs',
  'realtimeConnections',
  'providerTokens',
];

export function isQuotaLimitKey(value: string): value is QuotaLimitKey {
  return (QUOTA_LIMIT_KEYS as readonly string[]).includes(value);
}

export function resolveLimit(
  key: QuotaLimitKey,
  scopes: {
    readonly plan: PlanId | QuotaLimits;
    readonly owner?: QuotaOverrides | null;
    readonly project?: QuotaOverrides | null;
  },
): ResolvedLimit {
  const planLimits =
    typeof scopes.plan === 'string' ? PLAN_CATALOG[scopes.plan].limits : scopes.plan;
  const planValue = planLimits[key];
  const ownerValue = scopes.owner?.[key];
  const projectValue = scopes.project?.[key];
  const enforcement = enforcementFor(key);

  if (projectValue !== undefined) {
    return {
      key,
      value: projectValue,
      scope: 'project',
      source: 'project override',
      enforcement,
    };
  }
  if (ownerValue !== undefined) {
    return { key, value: ownerValue, scope: 'owner', source: 'owner override', enforcement };
  }
  if (planValue !== null) {
    return {
      key,
      value: planValue,
      scope: 'plan',
      source: typeof scopes.plan === 'string' ? `plan:${scopes.plan}` : 'plan',
      enforcement,
    };
  }
  return { key, value: null, scope: 'none', source: 'unset', enforcement };
}

/**
 * A limit is `hard` when the quantity is known before the work happens and the
 * store can refuse atomically. Bytes of an upload are known from the declared
 * length; a month of execution time is not, so that one is checked against what
 * has already happened and is labelled best effort.
 */
function enforcementFor(key: QuotaLimitKey): 'hard' | 'best_effort' {
  switch (key) {
    case 'fileStorageBytes':
    case 'backgroundJobs':
    case 'concurrentJobs':
      return 'hard';
    default:
      return 'best_effort';
  }
}

/** A point-in-time view of what one owner has consumed, in the limit's units. */
export interface ConsumptionView {
  readonly backendExecutionMs?: number;
  readonly backendExecutionCalls?: number;
  readonly backgroundJobs?: number;
  readonly fileStorageBytes?: number;
  readonly databaseStorageBytes?: number;
  readonly bandwidthBytes?: number;
  readonly providerTokens?: number;
  readonly liveJobs?: number;
  readonly realtimeConnections?: number;
}

export function consumedFor(view: ConsumptionView, key: QuotaLimitKey): number {
  switch (key) {
    case 'backendExecutionMs':
      return view.backendExecutionMs ?? 0;
    case 'backendExecutionCalls':
      return view.backendExecutionCalls ?? 0;
    case 'backgroundJobs':
      return view.backgroundJobs ?? 0;
    case 'fileStorageBytes':
      return view.fileStorageBytes ?? 0;
    case 'databaseStorageBytes':
      return view.databaseStorageBytes ?? 0;
    case 'bandwidthBytes':
      return view.bandwidthBytes ?? 0;
    case 'providerTokens':
      return view.providerTokens ?? 0;
    case 'concurrentJobs':
      return view.liveJobs ?? 0;
    case 'realtimeConnections':
      return view.realtimeConnections ?? 0;
  }
}

export interface EvaluateInput {
  readonly category: UsageCategory;
  /** How much this operation is about to consume. */
  readonly requested: number;
  readonly limit: ResolvedLimit;
  readonly consumed: ConsumptionView;
  readonly capability?: MeasurementCapability;
  /** Rows the caller read to build `consumed`; copied into the decision. */
  readonly evidence?: readonly string[];
  /** For concurrency, the hold is counted on top of live work. */
  readonly includeReservation?: boolean;
}

const fmt = (value: number, unit: UsageUnit): string => {
  if (unit === 'bytes') {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} bytes`;
  }
  if (unit === 'milliseconds') {
    if (value >= 3_600_000) return `${(value / 3_600_000).toFixed(1)} h`;
    if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
    return `${value} ms`;
  }
  if (unit === 'tokens') return `${Math.round(value).toLocaleString('en-US')} tokens`;
  return `${Math.round(value).toLocaleString('en-US')} ${unit}`;
};

/**
 * The decision, with its arithmetic exposed. A refusal never says "quota
 * exceeded": it names the limit, what has been used, what was asked for, and
 * which scope set the number.
 */
export function evaluateQuota(input: EvaluateInput): QuotaDecision {
  const quota = quotaForCategory(input.category);
  const capability = input.capability ?? capabilityFor(input.category);
  const limit = input.limit;
  const used = consumedFor(input.consumed, limit.key);
  const requested = Math.max(0, input.requested);
  const unit = quota === null ? capability.unit : unitFor(input.category);
  const evidence = [...(input.evidence ?? [])];

  if (capability.status === 'unavailable') {
    return {
      allowed: true,
      code: null,
      category: input.category,
      limitKey: limit.key,
      unit,
      limit: limit.value,
      used,
      requested,
      remaining: null,
      scope: limit.scope,
      enforcement: 'best_effort',
      message: `${capability.note} ${quota === null ? 'Its limit' : `The limit for ${quota.label}`} is therefore not enforced.`,
      evidence: [...evidence, `measurement:${input.category}=unavailable`],
    };
  }

  if (limit.value === null || quota === null) {
    return {
      allowed: true,
      code: null,
      category: input.category,
      limitKey: limit.key,
      unit,
      limit: null,
      used,
      requested,
      remaining: null,
      scope: limit.scope,
      enforcement: limit.enforcement,
      message: `No limit is set for ${quota?.label ?? input.category}.`,
      evidence,
    };
  }

  const remaining = limit.value - used;
  if (remaining >= requested) {
    return {
      allowed: true,
      code: null,
      category: input.category,
      limitKey: limit.key,
      unit,
      limit: limit.value,
      used,
      requested,
      remaining: remaining - requested,
      scope: limit.scope,
      enforcement: limit.enforcement,
      message:
        requested === 0
          ? `${fmt(used, unit)} of ${fmt(limit.value, unit)} used.`
          : `${fmt(requested, unit)} requested; ${fmt(remaining, unit)} of ${fmt(limit.value, unit)} remains.`,
      evidence,
    };
  }

  const where =
    limit.scope === 'plan' ? `the ${limit.source.replace('plan:', '')} plan` : limit.source;
  return {
    allowed: false,
    code: quota.code,
    category: input.category,
    limitKey: limit.key,
    unit,
    limit: limit.value,
    used,
    requested,
    remaining: Math.max(0, remaining),
    scope: limit.scope,
    enforcement: limit.enforcement,
    message:
      `${capability.status === 'measured' ? '' : 'Measured against stored records: '}` +
      `${fmt(used, unit)} of the ${fmt(limit.value, unit)} ${quota.label} allowance is used` +
      `${limit.scope === 'plan' ? '' : ` (${where})`}; this operation asks for ${fmt(requested, unit)}. ` +
      (limit.enforcement === 'hard'
        ? 'It was refused before it started.'
        : 'It was refused, but a concurrent request could pass a check like this one.'),
    evidence,
  };
}

/** Limits that have no governing category mapping, published as they are. */
export function resolveAllLimits(scopes: {
  readonly plan: PlanId | QuotaLimits;
  readonly owner?: QuotaOverrides | null;
  readonly project?: QuotaOverrides | null;
}): readonly ResolvedLimit[] {
  return QUOTA_LIMIT_KEYS.map((key) => resolveLimit(key, scopes));
}
