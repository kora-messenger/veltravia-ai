/**
 * Usage metering and quota enforcement (Step 52).
 *
 * This service is the single place where a limit is judged and where a
 * measurement is written down. It does not replace anything: tasks, workers,
 * verification runs, change sets, recovery cases, executions and the gateway's
 * own usage rows all stay authoritative for what happened. A usage record points
 * at one of them; a quota decision reads the ledger plus a live gauge.
 *
 * Three decisions worth stating plainly, because they shape the code:
 *
 *  1. Counters and gauges are different things. Tokens, milliseconds, calls and
 *     jobs accumulate over the month, so they come from the ledger. Storage and
 *     open connections are states, so they come from a measurement of what
 *     exists right now; summing monthly rows would keep billing a file after it
 *     was deleted.
 *  2. A category with no measurement is reported as unenforced, not as green.
 *     Database storage has no byte probe yet, so its limit is published and
 *     labelled as not enforced instead of pretended.
 *  3. Provider cost and infrastructure cost are never added together. BYOK
 *     tokens belong to the caller's provider bill and stop there; only
 *     Veltravia-managed provider calls are deducted from an allowance.
 *
 * The store is owner-scoped internally (it reads the caller from the request
 * context), so every store call here runs inside `runWithOwner` for the owner
 * whose allowance is being judged. One ledger is cached per owner for that
 * reason: a shared ledger would judge one owner's work against another's rows.
 */

import { runWithOwner } from '@veltravia/storage-postgres';

import {
  InMemoryUsageStore,
  PLAN_CATALOG,
  UsageLedger,
  UsageProblem,
  applyAdjustments,
  capabilityFor,
  costTotals,
  monthWindow,
  providerCost,
  quotaForCategory,
  resolveLimit,
  totals,
  unitFor,
  type MeasurementCapability,
  type PlanId,
  type QuotaLimitKey,
  type QuotaDecision,
  type QuotaOverrides,
  type UsageAdjustment,
  type UsageCategory,
  type UsageRecord,
  type UsageReservation,
  type UsageStore,
  type UsageEnvironment,
} from '@veltravia/usage-core';

/**
 * One judged limit.
 *
 * This is deliberately the API's own shape rather than the core's: the core
 * judges a measurable quantity and always knows `used`, while this layer also has
 * to say "nothing measures this yet" without inventing a zero. `not_enforced` is
 * a real answer here, so it exists here.
 */
export interface UsageDecision {
  readonly allowed: boolean;
  readonly code: string | null;
  readonly category: UsageCategory;
  readonly limitKey: QuotaLimitKey;
  readonly unit: string;
  readonly limit: number | null;
  readonly used: number | null;
  readonly requested: number;
  readonly remaining: number | null;
  readonly scope: 'plan' | 'owner' | 'project';
  readonly enforcement: 'hard' | 'best_effort' | 'not_enforced';
  readonly message: string;
  readonly evidence: readonly string[];
}

/** The core's judgement, in this layer's shape (it always knows `used`). */
function fromCoreDecision(decision: QuotaDecision): UsageDecision {
  return {
    ...decision,
    code: decision.code,
    unit: decision.unit ?? capabilityFor(decision.category).unit,
    limitKey: decision.limitKey ?? 'backgroundJobs',
    scope: decision.scope === 'none' ? 'plan' : decision.scope,
    enforcement: decision.enforcement,
  };
}

/** A request was refused because an allowance is spent or a plan is required. */
export class UsageLimitError extends Error {
  readonly code: string;
  readonly status: number;
  readonly decision: UsageDecision | null;

  constructor(code: string, message: string, status: number, decision: UsageDecision | null) {
    super(message);
    this.name = 'UsageLimitError';
    this.code = code;
    this.status = status;
    this.decision = decision;
  }
}

export interface UsageEntitlement {
  readonly planId: PlanId;
  readonly label: string;
  readonly source: 'default' | 'operator';
  readonly developmentMode: boolean;
  /** Managed = Veltravia's own provider keys. Byok = the caller's own key. */
  readonly managedProviders: boolean;
  readonly byokProviders: boolean;
  readonly note: string;
}

export interface UsageLimitView {
  readonly key: QuotaLimitKey;
  readonly category: UsageCategory | null;
  readonly label: string;
  readonly unit: string;
  readonly value: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly scope: 'plan' | 'owner' | 'project';
  readonly enforcement: 'hard' | 'best_effort' | 'not_enforced';
  readonly note: string | null;
}

export interface UsageSnapshot {
  readonly durable: boolean;
  readonly developmentMode: boolean;
  readonly entitlement: UsageEntitlement;
  readonly period: { readonly from: string; readonly to: string };
  readonly projectId: string | null;
  /** Accumulating measurements for this month. */
  readonly counters: Readonly<Record<UsageCategory, number>>;
  /** Point-in-time measurements. Null means "not measured", never zero. */
  readonly gauges: { readonly fileBytes: number | null; readonly openJobs: number | null };
  readonly cost: {
    readonly infrastructureUsd: number;
    readonly managedProviderUsd: number;
    readonly byokProviderUsd: number;
    readonly unpricedCalls: number;
  };
  readonly limits: readonly UsageLimitView[];
  readonly records: number;
}

export interface UsageService {
  readonly durable: boolean;
  readonly developmentMode: boolean;
  capabilities(): {
    readonly durable: boolean;
    readonly developmentMode: boolean;
    readonly categories: readonly (MeasurementCapability & {
      readonly limit: QuotaLimitKey | null;
    })[];
    readonly enforcement: 'enforced' | 'partial';
    readonly notes: readonly string[];
  };
  entitlement(ownerRef: string): Promise<UsageEntitlement>;
  setPlan(input: { ownerRef: string; planId: PlanId; actor: string }): Promise<UsageEntitlement>;
  limits(ownerRef: string, projectId?: string | null): Promise<readonly UsageLimitView[]>;
  setLimit(input: {
    ownerRef: string;
    projectId?: string | null;
    key: QuotaLimitKey;
    value: number | null;
    actor: string;
  }): Promise<readonly UsageLimitView[]>;
  snapshot(ownerRef: string, options?: { projectId?: string | null }): Promise<UsageSnapshot>;
  records(
    ownerRef: string,
    options?: { projectId?: string | null; limit?: number },
  ): Promise<readonly UsageRecord[]>;
  adjustments(
    ownerRef: string,
    options?: { projectId?: string | null; limit?: number },
  ): Promise<readonly UsageAdjustment[]>;

  /** Refuses work before it starts. Throws `UsageLimitError`. */
  guardBackgroundJob(input: {
    ownerRef: string;
    projectId?: string | null;
    operationKey: string;
  }): Promise<UsageReservation | null>;
  guardConcurrency(input: {
    ownerRef: string;
    projectId?: string | null;
    running: number;
  }): Promise<void>;
  guardProviderCall(input: {
    ownerRef: string;
    projectId?: string | null;
    byok: boolean;
    requestedTokens: number;
  }): Promise<void>;

  settleJob(input: {
    ownerRef: string;
    operationKey: string;
    outcome: 'completed' | 'released';
    projectId?: string | null;
  }): Promise<void>;

  recordWorkerExecution(input: {
    ownerRef: string;
    projectId?: string | null;
    workerId: string;
    executionId?: string | null;
    startedAt: string | null;
    finishedAt: string;
  }): Promise<UsageRecord | null>;
  recordProviderCall(input: {
    ownerRef: string;
    projectId?: string | null;
    runId: string;
    providerId: string;
    modelId: string;
    inputTokens: number | null;
    outputTokens: number | null;
    byok: boolean;
    reportedCostUsd?: number | null;
  }): Promise<UsageRecord | null>;
  sampleStorage(input: {
    ownerRef: string;
    projectId?: string | null;
  }): Promise<UsageRecord | null>;
  /**
   * Records one measured infrastructure event (Step 57).
   *
   * The narrow `record*` helpers above stay, because each one knows something
   * specific about its category. This is the generic seam a meter calls when the
   * number was observed by the process itself - an uploaded file, a counted byte,
   * a closed stream - so a new reliable source does not need a new service method.
   *
   * It refuses numbers it cannot stand behind: a negative, non-finite or absurd
   * quantity, an empty operation key, or a category that is not in the published
   * vocabulary. A refused record throws `UsageProblem`; nothing is written.
   */
  recordUsage(input: {
    ownerRef: string;
    projectId?: string | null;
    category: UsageCategory;
    operation: string;
    resource?: string;
    quantity: number;
    operationKey: string;
    source?: UsageRecord['source'];
    detail?: UsageRecord['detail'];
    executionId?: string | null;
    taskId?: string | null;
    workerId?: string | null;
  }): Promise<UsageRecord | null>;
  adjust(input: {
    ownerRef: string;
    category: UsageCategory;
    quantity: number;
    reason: string;
    actor: string;
    targetRecordId?: string | null;
    auditId: string;
    projectId?: string | null;
  }): Promise<UsageAdjustment>;
  sweep(ownerRef: string): Promise<number>;
}

/**
 * Step 60: what the meter needs to hear from a subscription, and nothing more.
 *
 * Kept as its own shape so this file never imports the subscription service: the
 * meter asks one question ("which plan is in force for this account, and is it
 * entitled?") and stays testable without a database.
 */
export interface SubscriptionAccessView {
  readonly planId: string;
  readonly planName: string;
  readonly status: string;
  /** `subscription`, `lapsed`, `suspended` or `development-allowance`. */
  readonly source: string;
  readonly entitled: boolean;
  readonly managedProviders: boolean;
  readonly byokProviders: boolean;
  readonly quotaLimits: Readonly<Record<string, number | null>> | null;
  readonly reason: string | null;
}

export interface UsageServiceOptions {
  /** Durable store when the deployment has a database. */
  readonly store?: UsageStore | undefined;
  /** Process environment, read for the deployment mode and price table. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
  /** Bytes currently stored for an owner (all projects, or one). */
  readonly measureFileBytes?:
    ((ownerRef: string, projectId?: string | null) => Promise<number | null>) | undefined;
  /**
   * Step 57: categories this deployment observes through its own meter rather
   * than through a probe callback. Absent or false means "not observed here", so
   * the capability is published as unavailable instead of claiming a measurement.
   */
  readonly observedCategories?: readonly UsageCategory[] | undefined;
  /** Bytes stored in the database for an owner, when a probe exists. */
  readonly measureDatabaseBytes?:
    ((ownerRef: string, projectId?: string | null) => Promise<number | null>) | undefined;
  /** Jobs or executions currently running for an owner. */
  readonly measureOpenJobs?:
    ((ownerRef: string, projectId?: string | null) => Promise<number | null>) | undefined;
  /**
   * Called once for a newly written usage record, never for a replayed one.
   *
   * This is how the credit wallet (Step 53) is billed without a second meter:
   * the record is written first and is the thing billed, and a failure here must
   * never turn work that already ran into an error, so it is caught and dropped.
   */
  readonly onRecorded?: ((record: UsageRecord) => Promise<void> | void) | undefined;
  /**
   * Step 60: the subscription that decides this account's plan.
   *
   * Absent means the deployment has no subscription wiring and the Step 52
   * behaviour stands, which is what a unit test of this service gets. Present, the
   * plan in force decides the entitlement and the quota set, so a suspended or
   * lapsed account loses the managed keys and the paid quotas without this file
   * knowing what a subscription is.
   */
  readonly subscription?: { access(ownerRef: string): Promise<SubscriptionAccessView> } | undefined;
}

/**
 * Categories whose number comes from a running meter, not from a probe. Kept in
 * one place so the capability table cannot drift from the wiring.
 */
const OBSERVED_EXTERNALLY = new Set<UsageCategory>(['bandwidth', 'realtime']);

const CATEGORIES: readonly UsageCategory[] = [
  'database_storage',
  'backend_execution',
  'file_storage',
  'bandwidth',
  'hosting',
  'background_jobs',
  'realtime',
  'ai_provider',
];

const LIMIT_LABEL: Record<QuotaLimitKey, string> = {
  databaseStorageBytes: 'Database storage',
  fileStorageBytes: 'File storage',
  bandwidthBytes: 'Bandwidth this month',
  backendExecutionMs: 'Backend execution time this month',
  backendExecutionCalls: 'Backend executions this month',
  backgroundJobs: 'Background jobs this month',
  concurrentJobs: 'Jobs running at once',
  realtimeConnections: 'Open realtime connections',
  providerTokens: 'AI provider tokens this month',
};

/** The category a limit key governs. Every key is fed by exactly one. */
function quotaKeyCategory(key: QuotaLimitKey): UsageCategory {
  switch (key) {
    case 'databaseStorageBytes':
      return 'database_storage';
    case 'fileStorageBytes':
      return 'file_storage';
    case 'bandwidthBytes':
      return 'bandwidth';
    case 'backendExecutionMs':
    case 'backendExecutionCalls':
      return 'backend_execution';
    case 'backgroundJobs':
    case 'concurrentJobs':
      return 'background_jobs';
    case 'realtimeConnections':
      return 'realtime';
    case 'providerTokens':
      return 'ai_provider';
  }
}

function formatQuantity(value: number, unit: string): string {
  if (unit === 'bytes') {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = Math.max(0, value);
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${index === 0 ? String(Math.round(size)) : size.toFixed(1)} ${units[index]}`;
  }
  if (unit === 'milliseconds') {
    return value >= 60_000
      ? `${(value / 60_000).toFixed(1)} min`
      : `${(value / 1000).toFixed(1)} s`;
  }
  return Math.round(value).toLocaleString('en-US');
}

function parsePriceTable(env: NodeJS.ProcessEnv) {
  const raw = env.VELTRAVIA_MODEL_PRICING?.trim();
  if (raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const rows = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const providerId = String(row.providerId ?? '');
      const modelId = String(row.modelId ?? '');
      const inputPerMillion = Number(row.inputPerMillion ?? Number.NaN);
      const outputPerMillion = Number(row.outputPerMillion ?? Number.NaN);
      // A malformed row is dropped, not defaulted to free.
      if (providerId === '' || modelId === '') continue;
      if (!Number.isFinite(inputPerMillion) || inputPerMillion < 0) continue;
      if (!Number.isFinite(outputPerMillion) || outputPerMillion < 0) continue;
      rows.push({ providerId, modelId, inputPerMillion, outputPerMillion });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * One store view per owner.
 *
 * The repositories read the owner from the request context rather than a
 * parameter, so each call is wrapped. Optional configuration methods are only
 * forwarded when the store has them, which is how a memory deployment keeps
 * metering without pretending it can remember a plan change.
 */
function bindStore(store: UsageStore, ownerRef: string): UsageStore {
  const wrapped: UsageStore = {
    insertRecord: (record) => runWithOwner(ownerRef, () => store.insertRecord(record)),
    findRecord: (key) => runWithOwner(ownerRef, () => store.findRecord(key)),
    listRecords: (filter) => runWithOwner(ownerRef, () => store.listRecords(filter)),
    insertAdjustment: (adjustment) =>
      runWithOwner(ownerRef, () => store.insertAdjustment(adjustment)),
    listAdjustments: (filter) => runWithOwner(ownerRef, () => store.listAdjustments(filter)),
    claimReservation: (input) => runWithOwner(ownerRef, () => store.claimReservation(input)),
    settleReservation: (input) => runWithOwner(ownerRef, () => store.settleReservation(input)),
    listReservations: (filter) => runWithOwner(ownerRef, () => store.listReservations(filter)),
    countLiveReservations: (category) =>
      runWithOwner(ownerRef, () => store.countLiveReservations(category)),
  };
  if (store.findReservation !== undefined) {
    const find = store.findReservation.bind(store);
    wrapped.findReservation = (key) => runWithOwner(ownerRef, () => find(key));
  }
  if (store.expireReservations !== undefined) {
    const expire = store.expireReservations.bind(store);
    wrapped.expireReservations = (at) => runWithOwner(ownerRef, () => expire(at));
  }
  if (store.readOverrides !== undefined) {
    const read = store.readOverrides.bind(store);
    wrapped.readOverrides = () => runWithOwner(ownerRef, () => read());
  }
  if (store.writeOverride !== undefined) {
    const write = store.writeOverride.bind(store);
    wrapped.writeOverride = (input) => runWithOwner(ownerRef, () => write(input));
  }
  if (store.readPlan !== undefined) {
    const read = store.readPlan.bind(store);
    wrapped.readPlan = () => runWithOwner(ownerRef, () => read());
  }
  if (store.writePlan !== undefined) {
    const write = store.writePlan.bind(store);
    wrapped.writePlan = (input) => runWithOwner(ownerRef, () => write(input));
  }
  return wrapped;
}

export function createUsageService(options: UsageServiceOptions = {}): UsageService {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const durable = options.store !== undefined;
  const base: UsageStore = options.store ?? new InMemoryUsageStore();
  const developmentMode =
    (env.VELTRAVIA_DEPLOYMENT_MODE?.trim() ??
      (env.NODE_ENV === 'production' ? 'production' : 'development')) !== 'production';

  let seq = 0;
  const stores = new Map<string, UsageStore>();
  const ledgers = new Map<string, UsageLedger>();
  const ledgerOptions: { now: () => Date; environment: UsageEnvironment } = {
    now,
    environment: developmentMode ? 'development' : 'production',
  };

  const storeFor = (ownerRef: string): UsageStore => {
    const cached = stores.get(ownerRef);
    if (cached !== undefined) return cached;
    const bound = bindStore(base, ownerRef);
    stores.set(ownerRef, bound);
    return bound;
  };

  /**
   * One place that writes a record and, when it is a new one, tells the billing
   * hook. A duplicate (the meter recognised a retry) is not billed again.
   */
  const recordWithBilling = async (
    ownerRef: string,
    input: Parameters<UsageLedger['record']>[0],
  ): Promise<UsageRecord> => {
    const { record, duplicate } = await ledgerFor(ownerRef).record(input);
    if (!duplicate && options.onRecorded !== undefined) {
      try {
        await options.onRecorded(record);
      } catch {
        // Billing is downstream of metering: a wallet that refuses a charge must
        // not make the metered work look like it failed.
      }
    }
    return record;
  };

  const ledgerFor = (ownerRef: string): UsageLedger => {
    const cached = ledgers.get(ownerRef);
    if (cached !== undefined) return cached;
    const ledger = new UsageLedger({
      ...ledgerOptions,
      store: storeFor(ownerRef),
      newId: () => `usg_${now().getTime().toString(36)}_${++seq}`,
    });
    ledgers.set(ownerRef, ledger);
    return ledger;
  };

  const window = () => monthWindow(now().toISOString());

  const subscriptionOf = options.subscription;

  /**
   * Step 60: the subscription in force, or `null` when the account has no
   * subscription row at all.
   *
   * The distinction carries the whole policy. A row - live, lapsed or suspended -
   * owns the answer, so a lapsed subscription loses the paid quotas and a
   * suspended one loses everything. No row means the account was never on a
   * subscription, and the Step 52 plan switch still decides; taking that away
   * would silently push an account an operator marked paid down to the included
   * allowance the moment subscriptions were wired in.
   */
  const subscriptionOfOwner = async (ownerRef: string): Promise<SubscriptionAccessView | null> => {
    if (subscriptionOf === undefined) return null;
    const access = await subscriptionOf.access(ownerRef);
    return access.source === 'development-allowance' ? null : access;
  };

  const planFromSubscription = async (
    ownerRef: string,
  ): Promise<{ planId: PlanId; source: 'default' | 'operator' } | null> => {
    const access = await subscriptionOfOwner(ownerRef);
    if (access === null) return null;
    // A live subscription is `paid`; a lapsed or suspended one is the included
    // allowance, so nothing keeps paid quotas by leaving a row behind.
    return {
      planId: access.source === 'subscription' ? 'paid' : 'development',
      source: 'operator',
    };
  };

  const legacyPlanFor = async (
    ownerRef: string,
  ): Promise<{ planId: PlanId; source: 'default' | 'operator' }> => {
    const stored = await storeFor(ownerRef).readPlan?.();
    if (
      stored !== null &&
      stored !== undefined &&
      (stored.planId === 'development' || stored.planId === 'paid')
    ) {
      return {
        planId: stored.planId,
        source: stored.source === 'operator' ? 'operator' : 'default',
      };
    }
    // The included tier is the same tier in both modes; what changes in
    // production is that a managed provider key needs a paid entitlement.
    return { planId: 'development', source: 'default' };
  };

  const planFor = async (
    ownerRef: string,
  ): Promise<{ planId: PlanId; source: 'default' | 'operator' }> => {
    const fromSubscription = await planFromSubscription(ownerRef);
    if (fromSubscription !== null) return fromSubscription;
    return legacyPlanFor(ownerRef);
  };

  const entitlementOf = async (ownerRef: string): Promise<UsageEntitlement> => {
    const subscription = await subscriptionOfOwner(ownerRef);
    if (subscription !== null) {
      const access = subscription;
      return {
        planId: access.source === 'subscription' ? 'paid' : 'development',
        label: access.planName,
        source: 'operator',
        developmentMode,
        // A suspension grants neither route: not the managed keys and not the
        // right to spend through a personal one.
        managedProviders: access.entitled && access.managedProviders,
        byokProviders: access.entitled && access.byokProviders,
        note:
          access.reason ??
          (access.entitled
            ? `Plan in force: ${access.planName}.`
            : `No plan entitlements are in force: ${access.planName}.`),
      };
    }
    const plan = await planFor(ownerRef);
    const paid = plan.planId === 'paid';
    return {
      planId: plan.planId,
      label: paid
        ? PLAN_CATALOG.paid.label
        : developmentMode
          ? PLAN_CATALOG.development.label
          : 'Included allowance',
      source: plan.source,
      developmentMode,
      managedProviders: paid || developmentMode,
      byokProviders: true,
      note: paid
        ? 'Paid entitlements use the paid limits and may use managed provider keys.'
        : developmentMode
          ? 'Development mode: managed keys and the included allowance are available.'
          : 'Included allowance: your own provider keys are used; managed provider keys need a paid plan.',
    };
  };

  const overridesFor = async (
    ownerRef: string,
    projectId: string | null,
  ): Promise<{ plan: PlanId; owner: QuotaOverrides | null; project: QuotaOverrides | null }> => {
    const plan = await planFor(ownerRef);
    const stored = await storeFor(ownerRef).readOverrides?.();
    return {
      plan: plan.planId,
      owner: stored?.owner ?? null,
      project: projectId === null ? null : (stored?.project[projectId] ?? null),
    };
  };

  const monthRecords = async (
    ownerRef: string,
    projectId: string | null,
  ): Promise<readonly UsageRecord[]> =>
    (
      await storeFor(ownerRef).listRecords({
        projectId,
        from: window().from,
        to: window().to,
        limit: 5000,
      })
    ).filter((record) => record.ownerRef === ownerRef);

  const monthAdjustments = async (ownerRef: string, projectId: string | null) =>
    storeFor(ownerRef).listAdjustments({
      projectId,
      from: window().from,
      to: window().to,
      limit: 500,
    });

  /** Holds still inside their window, counted from the store rather than memory. */
  const liveHolds = async (ownerRef: string, category: UsageCategory): Promise<number> => {
    const holds = await storeFor(ownerRef).listReservations({ status: 'held', limit: 500 });
    const at = now().toISOString();
    return holds.filter((hold) => hold.category === category && hold.expiresAt > at).length;
  };

  const measuredFileBytes = async (
    ownerRef: string,
    projectId: string | null,
  ): Promise<number | null> => {
    if (options.measureFileBytes === undefined) return null;
    try {
      return await options.measureFileBytes(ownerRef, projectId);
    } catch {
      // A failed probe is "unmeasured"; never "zero used".
      return null;
    }
  };

  const measuredDatabaseBytes = async (
    ownerRef: string,
    projectId: string | null,
  ): Promise<number | null> => {
    if (options.measureDatabaseBytes === undefined) return null;
    try {
      return await options.measureDatabaseBytes(ownerRef, projectId);
    } catch {
      return null;
    }
  };

  const measuredOpenJobs = async (
    ownerRef: string,
    projectId: string | null,
  ): Promise<number | null> => {
    if (options.measureOpenJobs === undefined) return null;
    try {
      return await options.measureOpenJobs(ownerRef, projectId);
    } catch {
      return null;
    }
  };

  /** What has been consumed for one limit key, with the numbers behind it. */
  const consumedFor = async (
    ownerRef: string,
    key: QuotaLimitKey,
    projectId: string | null,
  ): Promise<{ used: number | null; evidence: readonly string[] }> => {
    const category = quotaKeyCategory(key);

    if (category === 'file_storage') {
      const measured = await measuredFileBytes(ownerRef, projectId);
      return {
        used: measured,
        evidence:
          measured === null
            ? ['measurement:file_storage=unavailable']
            : [`gauge:file_storage=${measured}`],
      };
    }

    // A gauge with no probe on this deployment is unmeasured: reporting the sum
    // of monthly rows would keep charging for space already given back, and
    // reporting zero would be a lie in the other direction.
    if (category === 'database_storage') {
      const bytes = await measuredDatabaseBytes(ownerRef, projectId);
      return {
        used: bytes,
        evidence:
          bytes === null
            ? ['measurement:database_storage=unavailable']
            : [`gauge:database_storage=${bytes}`],
      };
    }
    if (category === 'bandwidth' || category === 'realtime') {
      return { used: null, evidence: [`measurement:${category}=unavailable`] };
    }

    if (key === 'concurrentJobs') {
      const open = await measuredOpenJobs(ownerRef, projectId);
      const holds = await liveHolds(ownerRef, 'background_jobs');
      if (open === null && holds === 0) {
        return { used: null, evidence: ['measurement:concurrentJobs=unavailable'] };
      }
      return {
        used: (open ?? 0) + holds,
        evidence: [`gauge:concurrentJobs=${(open ?? 0) + holds}`, `holds:background_jobs=${holds}`],
      };
    }

    const records = await monthRecords(ownerRef, projectId);
    // A record with no allowance is somebody else's bill (a BYOK provider call):
    // it is kept for transparency and excluded from what this allowance spent.
    const onAllowance = records.filter((row) => row.allowance !== null);
    const excluded = records.length - onAllowance.length;
    const monthTotal = totals(onAllowance)[category] ?? 0;
    const adjusted = applyAdjustments(
      { [category]: monthTotal } as Record<UsageCategory, number>,
      await monthAdjustments(ownerRef, projectId),
    );
    const used = adjusted[category] ?? 0;
    const holds = category === 'background_jobs' ? await liveHolds(ownerRef, category) : 0;
    return {
      used: used + holds,
      evidence: [
        `records:${category}=${onAllowance.filter((row) => row.category === category).length}`,
        `total:${category}=${used}`,
        ...(excluded === 0 ? [] : [`excluded:off-allowance=${excluded}`]),
        ...(holds === 0 ? [] : [`holds:${category}=${holds}`]),
      ],
    };
  };

  const evaluate = (
    input: { category: UsageCategory; requested: number },
    limit: ReturnType<typeof resolveLimit>,
    used: number | null,
    evidence: readonly string[],
  ): UsageDecision => {
    const quota = quotaForCategory(input.category);
    const capability = capabilityFor(input.category);
    const unit = quota === null ? capability.unit : unitFor(input.category);
    const base = {
      category: input.category,
      limitKey: limit.key,
      unit,
      limit: limit.value,
      used,
      requested: Math.max(0, input.requested),
      scope: (limit.scope === 'none' ? 'plan' : limit.scope) as 'plan' | 'owner' | 'project',
    } as const;

    if (capability.status === 'unavailable') {
      return {
        ...base,
        allowed: true,
        code: null,
        remaining: null,
        enforcement: 'not_enforced',
        message: `${capability.note} That limit is therefore not enforced.`,
        evidence: [...evidence, `measurement:${input.category}=unavailable`],
      };
    }
    if (limit.value === null) {
      return {
        ...base,
        allowed: true,
        code: null,
        remaining: null,
        enforcement: limit.enforcement,
        message: `No limit is set for ${LIMIT_LABEL[limit.key]}.`,
        evidence,
      };
    }
    if (used === null) {
      return {
        ...base,
        allowed: true,
        code: null,
        remaining: null,
        enforcement: 'not_enforced',
        message: `${LIMIT_LABEL[limit.key]} is not measured here, so its limit is not enforced.`,
        evidence: [...evidence, `measurement:${input.category}=unavailable`],
      };
    }
    const remaining = Math.max(0, limit.value - used);
    if (remaining >= base.requested) {
      return {
        ...base,
        allowed: true,
        code: null,
        remaining,
        enforcement: limit.enforcement,
        message: `${formatQuantity(remaining, unit)} left of ${formatQuantity(limit.value, unit)}.`,
        evidence,
      };
    }
    return {
      ...base,
      allowed: false,
      code: quota?.code ?? 'USAGE_LIMIT_REACHED',
      remaining,
      enforcement: 'hard',
      message:
        `${LIMIT_LABEL[limit.key]} is at ${formatQuantity(used, unit)} of ${formatQuantity(limit.value, unit)}. ` +
        `The request needs ${formatQuantity(base.requested, unit)} more, so it was refused before it started.`,
      evidence,
    };
  };

  const resolveFor = async (
    ownerRef: string,
    key: QuotaLimitKey,
    projectId: string | null,
  ): Promise<{
    limit: ReturnType<typeof resolveLimit>;
    scope: { plan: PlanId; owner: QuotaOverrides | null; project: QuotaOverrides | null };
  }> => {
    const scope = await overridesFor(ownerRef, projectId);
    // Step 60: the plan in force supplies the quota set; an override still wins,
    // and a key the plan does not state keeps the Step 52 value.
    const planQuotas = (await subscriptionOfOwner(ownerRef))?.quotaLimits ?? null;
    const planLimits =
      planQuotas === null || Object.keys(planQuotas).length === 0
        ? scope.plan
        : { ...PLAN_CATALOG[scope.plan].limits, ...planQuotas };
    return {
      limit: resolveLimit(key, {
        plan: planLimits,
        ...(scope.owner === null ? {} : { owner: scope.owner }),
        ...(scope.project === null ? {} : { project: scope.project }),
      }),
      scope,
    };
  };

  const limits = async (
    ownerRef: string,
    projectId: string | null,
  ): Promise<readonly UsageLimitView[]> => {
    const rows: UsageLimitView[] = [];
    for (const key of Object.keys(LIMIT_LABEL) as QuotaLimitKey[]) {
      const category = quotaKeyCategory(key);
      const { limit } = await resolveFor(ownerRef, key, projectId);
      const consumed = await consumedFor(ownerRef, key, projectId);
      const decision = evaluate(
        { category, requested: 0 },
        limit,
        consumed.used,
        consumed.evidence,
      );
      rows.push({
        key,
        category,
        label: LIMIT_LABEL[key],
        unit:
          quotaForCategory(category) === null ? capabilityFor(category).unit : unitFor(category),
        value: limit.value,
        used: consumed.used,
        remaining: decision.remaining,
        scope: decision.scope,
        enforcement: decision.enforcement,
        note:
          decision.enforcement === 'not_enforced'
            ? (capabilityFor(category).note ?? 'No measurement feeds this limit yet.')
            : null,
      });
    }
    return rows;
  };

  const guardBackgroundJob: UsageService['guardBackgroundJob'] = async (input) => {
    const projectId = input.projectId ?? null;
    const { limit, scope } = await resolveFor(input.ownerRef, 'backgroundJobs', projectId);
    const consumed = await consumedFor(input.ownerRef, 'backgroundJobs', projectId);
    const decision = evaluate(
      { category: 'background_jobs', requested: 1 },
      limit,
      consumed.used,
      consumed.evidence,
    );
    if (!decision.allowed) {
      throw new UsageLimitError('USAGE_LIMIT_REACHED', decision.message, 429, decision);
    }
    if (limit.value === null || consumed.used === null) return null;
    try {
      return await ledgerFor(input.ownerRef).reserve({
        ownerRef: input.ownerRef,
        projectId,
        category: 'background_jobs',
        quantity: 1,
        operationKey: input.operationKey,
        plan: scope.plan,
        ownerOverrides: scope.owner,
        projectOverrides: scope.project,
        ttlMs: 30 * 60_000,
      });
    } catch (error) {
      if (error instanceof UsageProblem) {
        throw new UsageLimitError(
          'USAGE_LIMIT_REACHED',
          error.decision?.message ?? 'That allowance is spent.',
          429,
          error.decision === undefined || error.decision === null
            ? null
            : fromCoreDecision(error.decision),
        );
      }
      throw error;
    }
  };

  const settleJob: UsageService['settleJob'] = async (input) => {
    const store = storeFor(input.ownerRef);
    // A store that cannot look a hold up by key still has it in its list; the
    // settle must find it either way or the hold leaks until it expires.
    const hold =
      store.findReservation === undefined
        ? ((await store.listReservations({ limit: 500 })).find(
            (row) => row.operationKey === input.operationKey,
          ) ?? null)
        : await store.findReservation(input.operationKey);
    if (hold === null) return;
    const ledger = ledgerFor(input.ownerRef);
    if (input.outcome === 'completed') {
      await ledger.commit(input.operationKey);
      // The hold becomes a record, so the month keeps the job after the hold ends.
      await recordWithBilling(input.ownerRef, {
        ownerRef: input.ownerRef,
        projectId: input.projectId ?? hold.projectId,
        category: 'background_jobs',
        operation: 'execution.job',
        resource: hold.operationId ?? input.operationKey,
        quantity: 1,
        operationKey: `${input.operationKey}:completed`,
        allowance: (await planFor(input.ownerRef)).planId,
        detail: { reservationId: hold.id },
      });
      return;
    }
    await ledger.release(input.operationKey, 'cancelled before it counted');
  };

  const observedHere = new Set<UsageCategory>(options.observedCategories ?? []);
  const isObserved = (category: UsageCategory): boolean => observedHere.has(category);

  const service: UsageService = {
    durable,
    developmentMode,
    capabilities: () => {
      // The core says what each number *could* be; this deployment says what it
      // actually observes. A category with no probe here is reported as
      // unavailable, because "derived" would claim a number this process cannot
      // produce.
      const categories = CATEGORIES.map((category) => {
        const base = capabilityFor(category);
        const probed =
          base.status !== 'unavailable' &&
          (category !== 'database_storage' || options.measureDatabaseBytes !== undefined) &&
          // Step 57: bandwidth and realtime are observed only when the deployment
          // actually wired the meter that observes them. The flag comes from the
          // caller instead of a hardcoded "not yet", so a category cannot claim to
          // be measured because the code was updated and the wiring was not.
          (!OBSERVED_EXTERNALLY.has(category) || isObserved(category));
        return {
          ...base,
          ...(probed
            ? {}
            : {
                status: 'unavailable' as const,
                note: 'Nothing in this deployment observes this yet, so its limit is reported but not enforced.',
              }),
          limit: quotaForCategory(category)?.limitKey ?? null,
        };
      });
      const enforced = categories.filter(
        (entry) =>
          entry.limit !== null && entry.status !== 'unavailable' && entry.status !== 'estimated',
      );
      return {
        durable,
        developmentMode,
        categories,
        enforcement: enforced.length === categories.length ? 'enforced' : 'partial',
        notes: [
          'Counters (tokens, milliseconds, calls, jobs) accumulate over the calendar month.',
          'Storage and open connections are measured as they are, not summed over the month.',
          'A category without a measurement is reported as unenforced rather than assumed to be zero.',
          'BYOK provider tokens are recorded for transparency and never deducted from an allowance.',
        ],
      };
    },
    entitlement: entitlementOf,
    async setPlan(input) {
      const store = storeFor(input.ownerRef);
      if (store.writePlan === undefined) {
        throw new UsageLimitError('USAGE_NOT_DURABLE', 'Plan changes need a database.', 503, null);
      }
      await store.writePlan({
        planId: input.planId,
        source: 'operator',
        actor: input.actor,
        now: now().toISOString(),
      });
      return entitlementOf(input.ownerRef);
    },
    limits,
    async setLimit(input) {
      const projectId = input.projectId ?? null;
      const store = storeFor(input.ownerRef);
      if (store.writeOverride === undefined) {
        throw new UsageLimitError('USAGE_NOT_DURABLE', 'Limit changes need a database.', 503, null);
      }
      await store.writeOverride({
        scope: projectId === null ? 'owner' : 'project',
        scopeId: projectId ?? input.ownerRef,
        key: input.key,
        value: input.value,
        actor: input.actor,
        now: now().toISOString(),
      });
      return limits(input.ownerRef, projectId);
    },
    async snapshot(ownerRef, snapshotOptions = {}) {
      const projectId = snapshotOptions.projectId ?? null;
      const records = await monthRecords(ownerRef, projectId);
      const counters = applyAdjustments(
        totals(records),
        await monthAdjustments(ownerRef, projectId),
      );
      const cost = costTotals(records);
      const fileBytes = await measuredFileBytes(ownerRef, projectId);
      const openJobs = await measuredOpenJobs(ownerRef, projectId);
      const complete = {} as Record<UsageCategory, number>;
      for (const category of CATEGORIES) complete[category] = counters[category] ?? 0;
      return {
        durable,
        developmentMode,
        entitlement: await entitlementOf(ownerRef),
        period: window(),
        projectId,
        counters: complete,
        gauges: { fileBytes, openJobs },
        cost: {
          infrastructureUsd: cost.infrastructureUsd,
          managedProviderUsd: cost.providerUsd,
          byokProviderUsd: cost.byokProviderUsd,
          unpricedCalls: records.filter(
            (row) => row.category === 'ai_provider' && row.costUsd === null,
          ).length,
        },
        limits: await limits(ownerRef, projectId),
        records: records.length,
      };
    },
    records: async (ownerRef, recordOptions = {}) =>
      // Step 57: the store is owner-bound on Postgres, but the in-memory driver
      // keeps one list for everyone, so the same read has to filter for itself.
      // Without this an in-process deployment answers one person's request with
      // somebody else's bandwidth rows.
      (
        await storeFor(ownerRef).listRecords({
          projectId: recordOptions.projectId ?? null,
          from: window().from,
          to: window().to,
          limit: Math.min(500, recordOptions.limit ?? 100),
        })
      ).filter((record) => record.ownerRef === ownerRef),
    adjustments: (ownerRef, adjustmentOptions = {}) =>
      storeFor(ownerRef).listAdjustments({
        projectId: adjustmentOptions.projectId ?? null,
        from: window().from,
        to: window().to,
        limit: Math.min(500, adjustmentOptions.limit ?? 100),
      }),
    guardBackgroundJob,
    async guardConcurrency(input) {
      const projectId = input.projectId ?? null;
      const { limit } = await resolveFor(input.ownerRef, 'concurrentJobs', projectId);
      const holds = await liveHolds(input.ownerRef, 'background_jobs');
      const decision = evaluate(
        { category: 'background_jobs', requested: 1 },
        { ...limit, key: 'concurrentJobs' },
        input.running + holds,
        [`gauge:running=${input.running}`, `holds:background_jobs=${holds}`],
      );
      if (!decision.allowed) {
        throw new UsageLimitError(
          'USAGE_CONCURRENCY_REACHED',
          `${input.running + holds} of ${decision.limit ?? 0} jobs can run at once. Wait for one to finish, or raise the limit.`,
          429,
          decision,
        );
      }
    },
    async guardProviderCall(input) {
      const entitlement = await entitlementOf(input.ownerRef);
      if (!input.byok && !entitlement.managedProviders) {
        throw new UsageLimitError(
          'USAGE_PLAN_REQUIRED',
          'Managed provider keys need a paid plan. Add your own provider key to keep going.',
          402,
          null,
        );
      }
      if (input.byok) {
        // Step 60: a personal key is not a way around a plan. Development mode is
        // free, a paid plan includes it, and a suspended or lapsed subscription
        // does not - which is what stops a held account from spending through a
        // key it stored before the hold.
        if (!entitlement.byokProviders) {
          throw new UsageLimitError(
            'USAGE_BYOK_NOT_IN_PLAN',
            entitlement.note === '' || entitlement.note === undefined
              ? 'Your own provider keys are not available on this plan right now. Nothing was sent.'
              : `${entitlement.note} Your own provider keys are not in force right now, so nothing was sent.`,
            402,
            null,
          );
        }
        return;
      }
      const projectId = input.projectId ?? null;
      const { limit } = await resolveFor(input.ownerRef, 'providerTokens', projectId);
      const consumed = await consumedFor(input.ownerRef, 'providerTokens', projectId);
      const decision = evaluate(
        { category: 'ai_provider', requested: input.requestedTokens },
        limit,
        consumed.used,
        consumed.evidence,
      );
      if (!decision.allowed) {
        throw new UsageLimitError('USAGE_LIMIT_REACHED', decision.message, 429, decision);
      }
    },
    settleJob,
    async recordWorkerExecution(input) {
      if (input.startedAt === null) return null;
      const started = Date.parse(input.startedAt);
      const finished = Date.parse(input.finishedAt);
      if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started)
        return null;
      const entitlement = await entitlementOf(input.ownerRef);
      const record = await recordWithBilling(input.ownerRef, {
        ownerRef: input.ownerRef,
        projectId: input.projectId ?? null,
        category: 'backend_execution',
        operation: 'worker.run',
        resource: input.workerId,
        quantity: finished - started,
        operationKey: `worker:${input.workerId}:run`,
        allowance: entitlement.planId,
        workerId: input.workerId,
        executionId: input.executionId ?? null,
        // Wall clock between start and review, not an instrumented CPU timer.
        source: 'derived',
        detail: { from: input.startedAt, to: input.finishedAt },
      });
      return record;
    },
    async recordProviderCall(input) {
      const tokens = (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
      if (tokens <= 0) return null;
      const entitlement = await entitlementOf(input.ownerRef);
      const cost = providerCost({
        providerId: input.providerId,
        modelId: input.modelId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        reportedCostUsd: input.reportedCostUsd ?? null,
        priceTable: parsePriceTable(env),
      });
      const record = await recordWithBilling(input.ownerRef, {
        ownerRef: input.ownerRef,
        projectId: input.projectId ?? null,
        category: 'ai_provider',
        operation: 'ai.request',
        resource: input.runId,
        quantity: tokens,
        operationKey: `run:${input.runId}`,
        providerId: input.providerId,
        modelId: input.modelId,
        // A BYOK call never touches an allowance, whatever the numbers are.
        allowance: input.byok ? null : entitlement.planId,
        costBearer: input.byok ? 'user_provider' : 'veltravia',
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        source: 'provider_reported',
        executionId: input.runId,
        detail: {
          inputTokens: input.inputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          byok: input.byok,
        },
      });
      return record;
    },
    async sampleStorage(input) {
      const bytes = await measuredFileBytes(input.ownerRef, input.projectId ?? null);
      if (bytes === null) return null;
      const day = now().toISOString().slice(0, 10);
      const record = await recordWithBilling(input.ownerRef, {
        ownerRef: input.ownerRef,
        projectId: input.projectId ?? null,
        category: 'file_storage',
        operation: 'storage.sample',
        resource: input.projectId ?? 'all-projects',
        quantity: bytes,
        // One sample a day: a gauge history, not a running total.
        operationKey: `storage:${input.projectId ?? 'all'}:${day}`,
        source: 'measured',
        detail: { gauge: true },
      });
      return record;
    },
    async recordUsage(input) {
      const category = input.category;
      if (!CATEGORIES.includes(category)) {
        throw new UsageProblem('USAGE_INVALID', `"${category}" is not a metered category.`);
      }
      const operation = input.operation.trim();
      if (operation === '' || operation.length > 80) {
        throw new UsageProblem(
          'USAGE_INVALID',
          'A usage record needs an operation name of at most 80 characters.',
        );
      }
      const operationKey = input.operationKey.trim();
      if (operationKey === '' || operationKey.length > 200) {
        throw new UsageProblem(
          'USAGE_INVALID',
          'A usage record needs an operation key of at most 200 characters.',
        );
      }
      if (input.ownerRef.trim() === '') {
        throw new UsageProblem('USAGE_INVALID', 'A usage record needs an owner.');
      }
      // The ledger re-checks finiteness and sign; this refuses the one number
      // that would silently poison a month's total.
      const quantity = input.quantity;
      if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000_000_000) {
        throw new UsageProblem(
          'USAGE_INVALID',
          'A usage quantity must be a measured, finite, non-negative number.',
        );
      }
      return recordWithBilling(input.ownerRef, {
        ownerRef: input.ownerRef,
        ...(input.projectId === undefined || input.projectId === null
          ? {}
          : { projectId: input.projectId }),
        category,
        operation,
        ...(input.resource === undefined ? {} : { resource: input.resource }),
        quantity,
        operationKey,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
      });
    },
    async adjust(input) {
      const { adjustment } = await ledgerFor(input.ownerRef).adjust({
        ownerRef: input.ownerRef,
        projectId: input.projectId ?? null,
        category: input.category,
        quantity: input.quantity,
        reason: input.reason,
        actor: input.actor,
        adjustmentKey: input.auditId,
        ...(input.targetRecordId === undefined || input.targetRecordId === null
          ? {}
          : { targetRecordId: input.targetRecordId }),
      });
      return adjustment;
    },
    async sweep(ownerRef) {
      const expire = storeFor(ownerRef).expireReservations;
      if (expire === undefined) return 0;
      return expire(now().toISOString());
    },
  };

  return service;
}

export { PLAN_CATALOG, capabilityFor, resolveLimit };
