/**
 * The ledger: the only way a usage row is created, and the only way capacity is
 * claimed before work starts.
 *
 * Two guarantees are promised, and only two:
 *
 *  1. One `operationKey` produces one counted record. The store enforces it with
 *     a unique key, so a retried worker, a resumed sweep or a duplicated HTTP
 *     request adds nothing. The second call gets the record that already exists
 *     plus a flag saying so - it is not an error, because a retry is normal.
 *  2. A hold that the store accepts is capacity reserved against the limit. The
 *     store performs the check and the insert in one atomic step, so two
 *     concurrent claims cannot both take the last slot. This is what makes
 *     `concurrentJobs` a real limit rather than a suggestion.
 *
 * What is not promised: that a record reflects physical infrastructure billing.
 * It reflects what this platform observed, and every record says which of
 * measured / provider_reported / derived / estimated that was.
 */

import { capabilityFor } from './catalog.js';
import { evaluateQuota, resolveLimit, type QuotaOverrides } from './quotas.js';
import {
  CATEGORY_UNITS,
  USAGE_LIMITS,
  UsageProblem,
  type MeasurementCapability,
  type QuotaDecision,
  type QuotaLimitKey,
  type ReservationStatus,
  type UsageAdjustment,
  type UsageCategory,
  type UsageEnvironment,
  type UsageRecord,
  type UsageReservation,
} from './types.js';

export interface UsageStore {
  /** True when inserted, false when `operationKey` was already present. */
  insertRecord(record: UsageRecord): Promise<boolean>;
  findRecord(operationKey: string): Promise<UsageRecord | null>;
  listRecords(filter: {
    readonly projectId?: string | null;
    readonly category?: UsageCategory;
    readonly from?: string;
    readonly to?: string;
    readonly limit: number;
    readonly offset?: number;
  }): Promise<readonly UsageRecord[]>;
  /** Insert if the operation key is new; used for adjustments too. */
  insertAdjustment(adjustment: UsageAdjustment): Promise<boolean>;
  listAdjustments(filter: {
    readonly projectId?: string | null;
    readonly from?: string;
    readonly to?: string;
    readonly limit: number;
  }): Promise<readonly UsageAdjustment[]>;

  /**
   * Atomically reserve capacity. The store MUST evaluate `limitKey` against
   * `limit` inside the same step that inserts the hold, including holds that are
   * still live. Returns null when the limit would be exceeded.
   */
  claimReservation(input: {
    readonly reservation: UsageReservation;
    readonly limitKey: QuotaLimitKey | null;
    readonly limit: number | null;
    readonly now: string;
  }): Promise<UsageReservation | null>;
  /** Commit or release a hold. Returns the settled row, or null if unknown. */
  settleReservation(input: {
    readonly operationKey: string;
    readonly status: Exclude<ReservationStatus, 'held'>;
    readonly now: string;
    readonly note?: string | null;
  }): Promise<UsageReservation | null>;
  listReservations(filter: {
    readonly projectId?: string | null;
    readonly status?: ReservationStatus;
    readonly now?: string;
    readonly limit: number;
  }): Promise<readonly UsageReservation[]>;
  /** Live holds, used for concurrency decisions and health. */
  countLiveReservations(category: UsageCategory): Promise<number>;
}

export interface LedgerOptions {
  readonly now: () => Date;
  readonly store: UsageStore;
  readonly environment: UsageEnvironment;
  readonly newId: () => string;
  readonly reservationTtlMs?: number;
}

/** Everything a caller may state. The ledger fills the rest, never guesses. */
export interface RecordInput {
  readonly ownerRef: string;
  readonly projectId?: string | null;
  readonly category: UsageCategory;
  readonly operation: string;
  readonly resource?: string;
  readonly quantity: number;
  readonly operationKey: string;
  readonly occurredAt?: string;
  readonly environment?: UsageEnvironment;
  readonly costClass?: UsageRecord['costClass'];
  readonly costBearer?: UsageRecord['costBearer'];
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  readonly allowance?: string | null;
  readonly costUsd?: number | null;
  readonly costSource?: UsageRecord['costSource'];
  readonly source?: UsageRecord['source'];
  readonly executionId?: string | null;
  readonly taskId?: string | null;
  readonly workerId?: string | null;
  readonly detail?: UsageRecord['detail'];
}

const MAX_REASONABLE_QUANTITY = 1_000_000_000_000_000;

function trimDetail(
  detail: Record<string, string | number | boolean | null> | undefined,
): UsageRecord['detail'] {
  if (detail === undefined) return {};
  const entries = Object.entries(detail).slice(0, USAGE_LIMITS.maxDetailEntries);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries) {
    if (typeof value === 'string') out[key] = value.slice(0, 400);
    else out[key] = value;
  }
  return out;
}

export class UsageLedger {
  private readonly options: LedgerOptions;

  constructor(options: LedgerOptions) {
    this.options = options;
  }

  get environment(): UsageEnvironment {
    return this.options.environment;
  }

  get store(): UsageStore {
    return this.options.store;
  }

  private nowIso(): string {
    return this.options.now().toISOString();
  }

  /**
   * Record one metered operation.
   *
   * `duplicate: true` means the row already existed and nothing was counted
   * twice. The caller can treat that as success: a retried worker did the right
   * thing by asking again.
   */
  async record(
    input: RecordInput,
  ): Promise<{ readonly record: UsageRecord; readonly duplicate: boolean }> {
    if (!Number.isFinite(input.quantity) || input.quantity < 0) {
      throw new UsageProblem(
        'USAGE_INVALID',
        'A usage quantity must be a finite, non-negative number.',
      );
    }
    if (input.quantity > MAX_REASONABLE_QUANTITY) {
      throw new UsageProblem(
        'USAGE_INVALID',
        'That quantity is beyond any value this platform can produce; it was refused rather than stored.',
      );
    }
    if (input.operationKey.trim() === '') {
      throw new UsageProblem('USAGE_INVALID', 'A usage record needs an operation key.');
    }
    if (input.ownerRef.trim() === '') {
      throw new UsageProblem('USAGE_INVALID', 'A usage record needs an owner.');
    }

    const capability = capabilityFor(input.category);
    const source = input.source ?? capability.source ?? 'measured';
    const record: UsageRecord = {
      id: this.options.newId(),
      ownerRef: input.ownerRef,
      projectId: input.projectId ?? null,
      category: input.category,
      operation: input.operation,
      resource: input.resource ?? input.operation,
      quantity: Math.round(input.quantity * 1000) / 1000,
      unit: CATEGORY_UNITS[input.category],
      operationKey: input.operationKey,
      occurredAt: input.occurredAt ?? this.nowIso(),
      environment: input.environment ?? this.options.environment,
      costClass:
        input.costClass ?? (input.category === 'ai_provider' ? 'provider' : 'infrastructure'),
      costBearer:
        input.costBearer ?? (input.category === 'ai_provider' ? 'veltravia' : 'veltravia'),
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      allowance: input.allowance ?? null,
      costUsd: input.costUsd ?? null,
      costSource: input.costSource ?? 'unknown',
      source,
      status: 'recorded',
      executionId: input.executionId ?? null,
      taskId: input.taskId ?? null,
      workerId: input.workerId ?? null,
      detail: trimDetail(input.detail),
    };

    const inserted = await this.options.store.insertRecord(record);
    if (inserted) return { record, duplicate: false };

    const existing = await this.options.store.findRecord(input.operationKey);
    if (existing === null) {
      // The store refused the insert but cannot show what is there. Reporting
      // success would be a lie; reporting a hard failure invites a retry that
      // will also fail. Name it.
      throw new UsageProblem(
        'USAGE_UNAVAILABLE',
        'The usage record could not be stored or read back.',
      );
    }
    return { record: existing, duplicate: true };
  }

  /**
   * Reserve capacity before the work happens. The plan and any overrides are
   * required because a hold must be judged against the limits that actually
   * apply to this owner and project, not against a default.
   */
  async reserve(input: {
    readonly ownerRef: string;
    readonly projectId?: string | null;
    readonly category: UsageCategory;
    readonly quantity: number;
    readonly operationKey: string;
    readonly operationId?: string | null;
    readonly note?: string | null;
    readonly ttlMs?: number;
    readonly plan: Parameters<typeof resolveLimit>[1]['plan'];
    readonly ownerOverrides?: QuotaOverrides | null;
    readonly projectOverrides?: QuotaOverrides | null;
    /** Judge the hold against how many run at once, not the monthly count. */
    readonly concurrency?: boolean;
  }): Promise<UsageReservation> {
    return this.reserveWithLimits(input);
  }

  /** Reserve against explicit limits, for a caller that resolved its own scopes. */
  async reserveWithLimits(input: {
    readonly ownerRef: string;
    readonly projectId?: string | null;
    readonly category: UsageCategory;
    readonly quantity: number;
    readonly operationKey: string;
    readonly operationId?: string | null;
    readonly note?: string | null;
    readonly plannedOwner?: QuotaOverrides | null;
    readonly plannedProject?: QuotaOverrides | null;
    readonly plan: Parameters<typeof resolveLimit>[1]['plan'];
    readonly concurrency?: boolean;
  }): Promise<UsageReservation> {
    const now = this.options.now();
    const ttl = this.options.reservationTtlMs ?? USAGE_LIMITS.reservationTtlMs;
    const categoryLimitKey =
      input.concurrency === true
        ? ('concurrentJobs' as QuotaLimitKey)
        : this.limitKeyFor(input.category);
    let limitKey: QuotaLimitKey | null = null;
    let limitValue: number | null = null;
    if (categoryLimitKey !== null) {
      const resolved = resolveLimit(categoryLimitKey, {
        plan: input.plan,
        owner: input.plannedOwner ?? null,
        project: input.plannedProject ?? null,
      });
      limitKey = resolved.value === null ? null : resolved.key;
      limitValue = resolved.value;
    }
    const reservation: UsageReservation = {
      id: this.options.newId(),
      ownerRef: input.ownerRef,
      projectId: input.projectId ?? null,
      category: input.category,
      quantity: input.quantity,
      unit: CATEGORY_UNITS[input.category],
      operationKey: input.operationKey,
      operationId: input.operationId ?? null,
      status: 'held',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      settledAt: null,
      note: input.note ?? null,
    };
    const held = await this.options.store.claimReservation({
      reservation,
      limitKey,
      limit: limitValue,
      now: now.toISOString(),
    });
    if (held !== null) return held;
    // The store refused the hold. The decision restates the arithmetic so the
    // caller can explain it; the store is what actually refused.
    const categoryKey =
      input.concurrency === true
        ? ('concurrentJobs' as QuotaLimitKey)
        : this.limitKeyFor(input.category);
    const decision: QuotaDecision =
      categoryKey === null
        ? evaluateQuota({
            category: input.category,
            requested: input.quantity,
            limit: {
              key: 'backgroundJobs',
              value: null,
              scope: 'none',
              source: 'unset',
              enforcement: 'best_effort',
            },
            consumed: {},
          })
        : evaluateQuota({
            category: input.category,
            requested: input.quantity,
            limit: resolveLimit(categoryKey, {
              plan: input.plan,
              owner: input.plannedOwner ?? null,
              project: input.plannedProject ?? null,
            }),
            consumed: { liveJobs: await this.options.store.countLiveReservations(input.category) },
            evidence: [
              `reservations:${input.category}:${await this.options.store.countLiveReservations(input.category)}`,
            ],
          });
    throw new UsageProblem(decision.code ?? 'QUOTA_EXCEEDED', decision.message, decision);
  }

  async release(operationKey: string, note?: string): Promise<UsageReservation | null> {
    return this.options.store.settleReservation({
      operationKey,
      status: 'released',
      now: this.nowIso(),
      note: note ?? null,
    });
  }

  async commit(operationKey: string, note?: string): Promise<UsageReservation | null> {
    return this.options.store.settleReservation({
      operationKey,
      status: 'committed',
      now: this.nowIso(),
      note: note ?? null,
    });
  }

  /**
   * Record an audited correction. The original record is untouched; the
   * adjustment is a new row with its reason, actor and audit id.
   */
  async adjust(input: {
    readonly ownerRef: string;
    readonly projectId?: string | null;
    readonly category: UsageCategory;
    readonly quantity: number;
    readonly reason: string;
    readonly actor: string;
    readonly targetRecordId?: string | null;
    readonly adjustmentKey: string;
  }): Promise<{ readonly adjustment: UsageAdjustment; readonly duplicate: boolean }> {
    if (input.reason.trim().length < 8) {
      throw new UsageProblem('USAGE_INVALID', 'An adjustment needs a reason a person can review.');
    }
    if (!Number.isFinite(input.quantity)) {
      throw new UsageProblem('USAGE_INVALID', 'An adjustment must be a finite number.');
    }
    const adjustment: UsageAdjustment = {
      id: this.options.newId(),
      ownerRef: input.ownerRef,
      projectId: input.projectId ?? null,
      category: input.category,
      quantity: input.quantity,
      unit: CATEGORY_UNITS[input.category],
      reason: input.reason.slice(0, 500),
      actor: input.actor,
      recordedAt: this.nowIso(),
      targetRecordId: input.targetRecordId ?? null,
      auditId: input.adjustmentKey,
    };
    const inserted = await this.options.store.insertAdjustment(adjustment);
    return { adjustment, duplicate: !inserted };
  }

  /** Ask whether an operation may proceed. Records nothing. */
  async check(input: {
    readonly ownerRef: string;
    readonly projectId?: string | null;
    readonly category: UsageCategory;
    readonly requested: number;
    readonly plan?: Parameters<typeof resolveLimit>[1]['plan'];
    readonly ownerOverrides?: QuotaOverrides | null;
    readonly projectOverrides?: QuotaOverrides | null;
    readonly consumed?: Parameters<typeof evaluateQuota>[0]['consumed'];
    readonly evidence?: readonly string[];
  }): Promise<QuotaDecision> {
    const key = this.limitKeyFor(input.category);
    if (key === null) {
      const capability: MeasurementCapability = capabilityFor(input.category);
      return {
        allowed: true,
        code: null,
        category: input.category,
        limitKey: null,
        unit: capability.unit,
        limit: null,
        used: 0,
        requested: input.requested,
        remaining: null,
        scope: 'none',
        enforcement: 'best_effort',
        message: `No quota governs ${input.category}.`,
        evidence: [],
      };
    }
    const limit =
      input.plan === undefined
        ? {
            key,
            value: null,
            scope: 'none' as const,
            source: 'unset',
            enforcement: 'best_effort' as const,
          }
        : resolveLimit(key, {
            plan: input.plan,
            owner: input.ownerOverrides ?? null,
            project: input.projectOverrides ?? null,
          });
    return evaluateQuota({
      category: input.category,
      requested: input.requested,
      limit,
      consumed: input.consumed ?? {},
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
  }

  async liveHolds(category: UsageCategory): Promise<number> {
    return this.options.store.countLiveReservations(category);
  }

  private limitKeyFor(category: UsageCategory): QuotaLimitKey | null {
    switch (category) {
      case 'database_storage':
        return 'databaseStorageBytes';
      case 'file_storage':
        return 'fileStorageBytes';
      case 'bandwidth':
        return 'bandwidthBytes';
      case 'backend_execution':
        return 'backendExecutionMs';
      case 'background_jobs':
        return 'backgroundJobs';
      case 'realtime':
        return 'realtimeConnections';
      case 'ai_provider':
        return 'providerTokens';
      case 'hosting':
        return null;
    }
  }
}
