/**
 * What a plan includes, and what the platform can honestly observe.
 *
 * Both tables are data, not branches: a limit is changed by editing a plan or an
 * override row, never by adding an `if` to a route. The measurement table is the
 * part that keeps the product honest. It states, per category, whether a number
 * is watched happening, computed from stored records, a bound, or simply not
 * observable here - and the API publishes it verbatim.
 */

import type {
  MeasurementCapability,
  QuotaCode,
  QuotaLimitKey,
  QuotaLimits,
  UsageCategory,
  UsageUnit,
} from './types.js';

export const PLAN_IDS = ['development', 'paid'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanDefinition {
  readonly id: PlanId;
  readonly label: string;
  readonly description: string;
  readonly limits: QuotaLimits;
}

const unlimited: QuotaLimits = {
  databaseStorageBytes: null,
  fileStorageBytes: null,
  bandwidthBytes: null,
  backendExecutionMs: null,
  backendExecutionCalls: null,
  backgroundJobs: null,
  concurrentJobs: null,
  realtimeConnections: null,
  providerTokens: null,
};

/**
 * Development is a real allowance, not an absence of limits: it is sized so the
 * managed infrastructure can be exercised without a billing integration, and it
 * still refuses work when the allowance is gone. Values are deliberately modest
 * and every one of them can be overridden per owner or per project.
 */
export const PLAN_CATALOG: Readonly<Record<PlanId, PlanDefinition>> = {
  development: {
    id: 'development',
    label: 'Development allowance',
    description:
      'Included development resources. Managed infrastructure and managed providers are available without a payment method; limits still apply.',
    limits: {
      databaseStorageBytes: 64 * 1024 * 1024,
      fileStorageBytes: 512 * 1024 * 1024,
      bandwidthBytes: 2 * 1024 * 1024 * 1024,
      backendExecutionMs: 60 * 60 * 1000,
      backendExecutionCalls: 5_000,
      backgroundJobs: 500,
      concurrentJobs: 3,
      realtimeConnections: 5,
      providerTokens: 250_000,
    },
  },
  paid: {
    id: 'paid',
    label: 'Paid plan',
    description: 'Billed resources with the limits of the subscribed plan.',
    limits: {
      databaseStorageBytes: 2 * 1024 * 1024 * 1024,
      fileStorageBytes: 20 * 1024 * 1024 * 1024,
      bandwidthBytes: 50 * 1024 * 1024 * 1024,
      backendExecutionMs: 40 * 60 * 60 * 1000,
      backendExecutionCalls: 200_000,
      backgroundJobs: 20_000,
      concurrentJobs: 6,
      realtimeConnections: 25,
      providerTokens: 5_000_000,
    },
  },
};

export const isPlanId = (value: string): value is PlanId =>
  (PLAN_IDS as readonly string[]).includes(value);

/**
 * Reading the platform's own instrumented behaviour.
 *
 * `measured` - this process watched it (a dispatched worker's wall clock, an
 * uploaded file's byte count).
 * `derived` - computed from stored records, exact as far as those records go.
 * `estimated` - a bound, because the traffic is not all visible from here.
 * `unavailable` - nothing observes it, so the product reports nothing rather
 * than a plausible number.
 */
export const MEASUREMENT_CAPABILITIES: readonly MeasurementCapability[] = [
  {
    category: 'backend_execution',
    status: 'measured',
    unit: 'milliseconds',
    source: 'measured',
    note: 'Wall-clock time of work this API dispatched (Primary Agent steps, Superagent workers, verification runs). Time spent waiting on an external provider is included and stated in the record detail.',
  },
  {
    category: 'background_jobs',
    status: 'measured',
    unit: 'calls',
    source: 'measured',
    note: 'One record per dispatched job, with its outcome. A job that fails still consumed compute, so it counts; a job refused before it started records nothing.',
  },
  {
    category: 'file_storage',
    status: 'measured',
    unit: 'bytes',
    source: 'measured',
    note: 'Byte counts reported by the upload handlers, and deletions that release them. Bytes written outside those handlers are not seen.',
  },
  {
    category: 'database_storage',
    status: 'derived',
    unit: 'bytes',
    source: 'derived',
    note: 'Computed from the stored rows this API owns (source content, change sets, records). Table overhead, indexes and WAL are not attributable per owner, so the number is a floor rather than the physical size.',
  },
  {
    category: 'bandwidth',
    status: 'estimated',
    unit: 'bytes',
    source: 'estimated',
    note: 'Request and response bytes observed by this API process. Static assets served by a CDN, provider egress and traffic that never reaches this process are not counted.',
  },
  {
    category: 'realtime',
    status: 'unavailable',
    unit: 'connections',
    source: null,
    note: 'Stream connections are not instrumented yet, so no realtime usage is recorded and the limit is published as unenforced.',
  },
  {
    category: 'hosting',
    status: 'unavailable',
    unit: 'milliseconds',
    source: null,
    note: 'Applications are not hosted by a deployment integration in this build, so hosting runtime is not measured.',
  },
  {
    category: 'ai_provider',
    status: 'measured',
    unit: 'tokens',
    source: 'provider_reported',
    note: "Token counts and cost only when the provider reported them. Nothing is imputed. BYOK requests are recorded for transparency with the user as cost bearer and never deducted from Veltravia's allowance.",
  },
];

export function capabilityFor(category: UsageCategory): MeasurementCapability {
  const found = MEASUREMENT_CAPABILITIES.find((entry) => entry.category === category);
  // Every category in the vocabulary has an entry; the fallback keeps a future
  // category from being silently presented as measured.
  return (
    found ?? {
      category,
      status: 'unavailable',
      unit: 'coalesced' as UsageUnit,
      source: null,
      note: 'No measurement source is declared for this category.',
    }
  );
}

/** The limit that governs a category, and the refusal it produces. */
export interface CategoryQuota {
  readonly category: UsageCategory;
  readonly limitKey: QuotaLimitKey;
  readonly code: QuotaCode;
  readonly enforcement: 'hard' | 'best_effort';
  readonly label: string;
}

export const CATEGORY_QUOTAS: readonly CategoryQuota[] = [
  {
    category: 'database_storage',
    limitKey: 'databaseStorageBytes',
    code: 'STORAGE_LIMIT_REACHED',
    enforcement: 'best_effort',
    label: 'database storage',
  },
  {
    category: 'file_storage',
    limitKey: 'fileStorageBytes',
    code: 'STORAGE_LIMIT_REACHED',
    enforcement: 'hard',
    label: 'file storage',
  },
  {
    category: 'bandwidth',
    limitKey: 'bandwidthBytes',
    code: 'BANDWIDTH_LIMIT_REACHED',
    enforcement: 'best_effort',
    label: 'bandwidth',
  },
  {
    category: 'backend_execution',
    limitKey: 'backendExecutionMs',
    code: 'EXECUTION_LIMIT_REACHED',
    enforcement: 'best_effort',
    label: 'backend execution time',
  },
  {
    category: 'background_jobs',
    limitKey: 'backgroundJobs',
    code: 'EXECUTION_LIMIT_REACHED',
    enforcement: 'hard',
    label: 'background jobs',
  },
  {
    category: 'realtime',
    limitKey: 'realtimeConnections',
    code: 'CONCURRENCY_LIMIT_REACHED',
    enforcement: 'best_effort',
    label: 'realtime connections',
  },
  {
    category: 'ai_provider',
    limitKey: 'providerTokens',
    code: 'PROVIDER_ALLOWANCE_EXHAUSTED',
    enforcement: 'best_effort',
    label: 'provider tokens',
  },
];

export function quotaForCategory(category: UsageCategory): CategoryQuota | null {
  return CATEGORY_QUOTAS.find((entry) => entry.category === category) ?? null;
}

export const DEFAULT_LIMITS = unlimited;
