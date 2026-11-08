/**
 * Usage records, holds, adjustments and quota configuration in PostgreSQL
 * (Step 52).
 *
 * The one guarantee that matters is in `claimReservation`. Checking a limit and
 * then inserting a hold as two statements lets two requests each see one free
 * slot and both take it. Here the check and the insert run inside one
 * transaction that first takes an advisory lock keyed on the owner and category,
 * so concurrent claims for the same allowance queue behind each other and the
 * second one sees the first one's row. The lock is transaction-scoped, so it is
 * released by commit, rollback or a dead connection - never leaked.
 *
 * Everything else is append-only. `usage_records` has `(owner_ref,
 * operation_key)` as its key, so a retried worker's second write is recognised
 * instead of counted. A correction is a new `usage_adjustments` row; no quantity
 * is ever rewritten in place.
 */

import type {
  QuotaLimitKey,
  QuotaOverrides,
  UsageAdjustment,
  UsageCategory,
  UsageRecord,
  UsageReservation,
  UsageStore,
} from '@veltravia/usage-core';

import { requireOwner } from '../owner-scope.js';
import type { Queryable } from '../pool.js';

const num = (value: number | string | null): number | null =>
  value === null ? null : typeof value === 'number' ? value : Number(value);

interface RecordRow {
  id: string;
  owner_ref: string;
  project_id: string | null;
  category: UsageCategory;
  operation: string;
  resource: string;
  quantity: string;
  unit: UsageRecord['unit'];
  operation_key: string;
  occurred_at: Date;
  environment: UsageRecord['environment'];
  cost_class: UsageRecord['costClass'];
  cost_bearer: UsageRecord['costBearer'];
  provider_id: string | null;
  model_id: string | null;
  allowance: string | null;
  cost_usd: string | null;
  cost_source: UsageRecord['costSource'];
  source: UsageRecord['source'];
  status: UsageRecord['status'];
  execution_id: string | null;
  task_id: string | null;
  worker_id: string | null;
  detail: Record<string, string | number | boolean | null>;
}

const toRecord = (row: RecordRow): UsageRecord => ({
  id: row.id,
  ownerRef: row.owner_ref,
  projectId: row.project_id,
  category: row.category,
  operation: row.operation,
  resource: row.resource,
  quantity: num(row.quantity) ?? 0,
  unit: row.unit,
  operationKey: row.operation_key,
  occurredAt: new Date(row.occurred_at).toISOString(),
  environment: row.environment,
  costClass: row.cost_class,
  costBearer: row.cost_bearer,
  providerId: row.provider_id,
  modelId: row.model_id,
  allowance: row.allowance,
  costUsd: num(row.cost_usd),
  costSource: row.cost_source,
  source: row.source,
  status: row.status,
  executionId: row.execution_id,
  taskId: row.task_id,
  workerId: row.worker_id,
  detail: row.detail ?? {},
});

interface ReservationRow {
  id: string;
  owner_ref: string;
  project_id: string | null;
  category: UsageCategory;
  quantity: string;
  unit: UsageReservation['unit'];
  operation_key: string;
  operation_id: string | null;
  status: UsageReservation['status'];
  created_at: Date;
  expires_at: Date;
  settled_at: Date | null;
  note: string | null;
}

const toReservation = (row: ReservationRow): UsageReservation => ({
  id: row.id,
  ownerRef: row.owner_ref,
  projectId: row.project_id,
  category: row.category,
  quantity: num(row.quantity) ?? 0,
  unit: row.unit,
  operationKey: row.operation_key,
  operationId: row.operation_id,
  status: row.status,
  createdAt: new Date(row.created_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
  settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
  note: row.note,
});

interface AdjustmentRow {
  id: string;
  owner_ref: string;
  project_id: string | null;
  category: UsageCategory;
  quantity: string;
  unit: UsageAdjustment['unit'];
  reason: string;
  actor: string;
  recorded_at: Date;
  target_record_id: string | null;
  audit_id: string;
}

const toAdjustment = (row: AdjustmentRow): UsageAdjustment => ({
  id: row.id,
  ownerRef: row.owner_ref,
  projectId: row.project_id,
  category: row.category,
  quantity: num(row.quantity) ?? 0,
  unit: row.unit,
  reason: row.reason,
  actor: row.actor,
  recordedAt: new Date(row.recorded_at).toISOString(),
  targetRecordId: row.target_record_id,
  auditId: row.audit_id,
});

const RECORD_COLUMNS = `id, owner_ref, project_id, category, operation, resource, quantity, unit,
  operation_key, occurred_at, environment, cost_class, cost_bearer, provider_id, model_id,
  allowance, cost_usd, cost_source, source, status, execution_id, task_id, worker_id, detail`;

export class PostgresUsageStore implements UsageStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  private async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const withTx = this.query as Queryable & {
      withTransaction?: <R>(fn: (tx: Queryable) => Promise<R>) => Promise<R>;
    };
    if (withTx.withTransaction === undefined) return work(this.query);
    return withTx.withTransaction(work);
  }

  async insertRecord(record: UsageRecord): Promise<boolean> {
    const owner = requireOwner();
    const result = await this.query.query<{ id: string }>(
      `insert into usage_records (${RECORD_COLUMNS}, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, $24, now())
       on conflict (owner_ref, operation_key) do nothing
       returning id`,
      [
        record.id,
        owner,
        record.projectId,
        record.category,
        record.operation,
        record.resource,
        record.quantity,
        record.unit,
        record.operationKey,
        record.occurredAt,
        record.environment,
        record.costClass,
        record.costBearer,
        record.providerId,
        record.modelId,
        record.allowance,
        record.costUsd,
        record.costSource,
        record.source,
        record.status,
        record.executionId,
        record.taskId,
        record.workerId,
        JSON.stringify(record.detail),
      ],
    );
    return result.rowCount > 0;
  }

  async findRecord(operationKey: string): Promise<UsageRecord | null> {
    const owner = requireOwner();
    const result = await this.query.query<RecordRow>(
      `select ${RECORD_COLUMNS} from usage_records
        where owner_ref = $1 and operation_key = $2`,
      [owner, operationKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async listRecords(filter: {
    projectId?: string | null;
    category?: UsageCategory;
    from?: string;
    to?: string;
    limit: number;
    offset?: number;
  }): Promise<readonly UsageRecord[]> {
    const owner = requireOwner();
    const result = await this.query.query<RecordRow>(
      `select ${RECORD_COLUMNS} from usage_records
        where owner_ref = $1
          and ($2::text is null or project_id = $2)
          and ($3::text is null or category = $3)
          and ($4::timestamptz is null or occurred_at >= $4)
          and ($5::timestamptz is null or occurred_at < $5)
        order by occurred_at desc, id desc
        limit $6 offset $7`,
      [
        owner,
        filter.projectId ?? null,
        filter.category ?? null,
        filter.from ?? null,
        filter.to ?? null,
        filter.limit,
        filter.offset ?? 0,
      ],
    );
    return result.rows.map(toRecord);
  }

  async insertAdjustment(adjustment: UsageAdjustment): Promise<boolean> {
    const owner = requireOwner();
    const result = await this.query.query<{ id: string }>(
      `insert into usage_adjustments
         (owner_ref, audit_id, id, project_id, category, quantity, unit, reason, actor,
          recorded_at, target_record_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (owner_ref, audit_id) do nothing
       returning id`,
      [
        owner,
        adjustment.auditId,
        adjustment.id,
        adjustment.projectId,
        adjustment.category,
        adjustment.quantity,
        adjustment.unit,
        adjustment.reason,
        adjustment.actor,
        adjustment.recordedAt,
        adjustment.targetRecordId,
      ],
    );
    return result.rowCount > 0;
  }

  async listAdjustments(filter: {
    projectId?: string | null;
    from?: string;
    to?: string;
    limit: number;
  }): Promise<readonly UsageAdjustment[]> {
    const owner = requireOwner();
    const result = await this.query.query<AdjustmentRow>(
      `select id, owner_ref, project_id, category, quantity, unit, reason, actor,
              recorded_at, target_record_id, audit_id
         from usage_adjustments
        where owner_ref = $1
          and ($2::text is null or project_id = $2)
          and ($3::timestamptz is null or recorded_at >= $3)
          and ($4::timestamptz is null or recorded_at < $4)
        order by recorded_at desc
        limit $5`,
      [owner, filter.projectId ?? null, filter.from ?? null, filter.to ?? null, filter.limit],
    );
    return result.rows.map(toAdjustment);
  }

  /**
   * Claim capacity or refuse it, in one serialised step.
   *
   * The advisory lock is keyed on owner and category (two int4 halves built from
   * one hash), so unrelated categories never block each other while two claims
   * on the same allowance always do. `expires_at <= now` holds count as free,
   * which is how a crashed process gives its slots back without an operator.
   */
  async claimReservation(input: {
    reservation: UsageReservation;
    limitKey: QuotaLimitKey | null;
    limit: number | null;
    now: string;
  }): Promise<UsageReservation | null> {
    const owner = requireOwner();
    const reservation = input.reservation;

    return this.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `${owner}:${reservation.category}`,
      ]);

      const existing = await tx.query<ReservationRow>(
        `select id, owner_ref, project_id, category, quantity, unit, operation_key,
                operation_id, status, created_at, expires_at, settled_at, note
           from usage_reservations
          where owner_ref = $1 and operation_key = $2`,
        [owner, reservation.operationKey],
      );
      const already = existing.rows[0];
      if (already !== undefined) return toReservation(already);

      if (input.limit !== null) {
        const live = await tx.query<{ used: string }>(
          `select coalesce(sum(quantity), 0) as used
             from usage_reservations
            where owner_ref = $1 and category = $2 and status = 'held' and expires_at > $3`,
          [owner, reservation.category, input.now],
        );
        const used = num(live.rows[0]?.used ?? '0') ?? 0;
        if (used + reservation.quantity > input.limit) return null;
      }

      const inserted = await tx.query<ReservationRow>(
        `insert into usage_reservations
           (owner_ref, operation_key, id, project_id, category, quantity, unit, operation_id,
            status, created_at, expires_at, settled_at, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'held', $9, $10, null, $11)
         returning id, owner_ref, project_id, category, quantity, unit, operation_key,
                   operation_id, status, created_at, expires_at, settled_at, note`,
        [
          owner,
          reservation.operationKey,
          reservation.id,
          reservation.projectId,
          reservation.category,
          reservation.quantity,
          reservation.unit,
          reservation.operationId,
          reservation.createdAt,
          reservation.expiresAt,
          reservation.note,
        ],
      );
      const row = inserted.rows[0];
      return row === undefined ? null : toReservation(row);
    });
  }

  async settleReservation(input: {
    operationKey: string;
    status: Exclude<UsageReservation['status'], 'held'>;
    now: string;
    note?: string | null;
  }): Promise<UsageReservation | null> {
    const owner = requireOwner();
    const result = await this.query.query<ReservationRow>(
      `update usage_reservations
          set status = $3, settled_at = $4, note = coalesce($5, note)
        where owner_ref = $1 and operation_key = $2 and status = 'held'
        returning id, owner_ref, project_id, category, quantity, unit, operation_key,
                  operation_id, status, created_at, expires_at, settled_at, note`,
      [owner, input.operationKey, input.status, input.now, input.note ?? null],
    );
    const row = result.rows[0];
    if (row !== undefined) return toReservation(row);
    // Already settled (a retried release) or never held: report what is stored
    // rather than failing the caller's cleanup path.
    const existing = await this.query.query<ReservationRow>(
      `select id, owner_ref, project_id, category, quantity, unit, operation_key,
              operation_id, status, created_at, expires_at, settled_at, note
         from usage_reservations where owner_ref = $1 and operation_key = $2`,
      [owner, input.operationKey],
    );
    const found = existing.rows[0];
    return found === undefined ? null : toReservation(found);
  }

  async listReservations(filter: {
    projectId?: string | null;
    status?: UsageReservation['status'];
    now?: string;
    limit: number;
  }): Promise<readonly UsageReservation[]> {
    const owner = requireOwner();
    const result = await this.query.query<ReservationRow>(
      `select id, owner_ref, project_id, category, quantity, unit, operation_key,
              operation_id, status, created_at, expires_at, settled_at, note
         from usage_reservations
        where owner_ref = $1
          and ($2::text is null or project_id = $2)
          and ($3::text is null or status = $3)
        order by created_at desc
        limit $4`,
      [owner, filter.projectId ?? null, filter.status ?? null, filter.limit],
    );
    return result.rows.map(toReservation);
  }

  /** The one hold an operation key names, so a settle closes that row. */
  async findReservation(operationKey: string): Promise<UsageReservation | null> {
    const owner = requireOwner();
    const result = await this.query.query<ReservationRow>(
      `select id, owner_ref, project_id, category, quantity, unit, operation_key,
              operation_id, status, created_at, expires_at, settled_at, note
         from usage_reservations
        where owner_ref = $1 and operation_key = $2
        limit 1`,
      [owner, operationKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toReservation(row);
  }

  async countLiveReservations(category: UsageCategory): Promise<number> {
    const owner = requireOwner();
    const result = await this.query.query<{ live: string }>(
      `select count(*)::text as live
         from usage_reservations
        where owner_ref = $1 and category = $2 and status = 'held' and expires_at > now()`,
      [owner, category],
    );
    return Number(result.rows[0]?.live ?? '0');
  }

  /** Holds nobody settled, released by the sweep. Returns how many were freed. */
  async expireReservations(now: string): Promise<number> {
    const owner = requireOwner();
    const result = await this.query.query<{ id: string }>(
      `update usage_reservations
          set status = 'expired', settled_at = $2, note = coalesce(note, 'expired by sweep')
        where owner_ref = $1 and status = 'held' and expires_at <= $2
        returning id`,
      [owner, now],
    );
    return result.rowCount;
  }

  /** Quota configuration for one owner, by scope. */
  async readOverrides(): Promise<{
    readonly owner: QuotaOverrides;
    readonly project: Readonly<Record<string, QuotaOverrides>>;
  }> {
    const owner = requireOwner();
    const result = await this.query.query<{
      scope: 'owner' | 'project';
      scope_id: string;
      limit_key: QuotaLimitKey;
      limit_value: string | null;
    }>(
      `select scope, scope_id, limit_key, limit_value
         from usage_quota_overrides where owner_ref = $1`,
      [owner],
    );
    const ownerLimits: Partial<Record<QuotaLimitKey, number | null>> = {};
    const projects: Record<string, Partial<Record<QuotaLimitKey, number | null>>> = {};
    for (const row of result.rows) {
      const value = num(row.limit_value);
      if (row.scope === 'owner') ownerLimits[row.limit_key] = value;
      else {
        const target = projects[row.scope_id] ?? {};
        target[row.limit_key] = value;
        projects[row.scope_id] = target;
      }
    }
    return { owner: ownerLimits, project: projects };
  }

  async writeOverride(input: {
    scope: 'owner' | 'project';
    scopeId: string;
    key: QuotaLimitKey;
    value: number | null;
    actor: string;
    now: string;
  }): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into usage_quota_overrides
         (owner_ref, scope, scope_id, limit_key, limit_value, updated_at, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (owner_ref, scope, scope_id, limit_key)
       do update set limit_value = excluded.limit_value,
                     updated_at = excluded.updated_at,
                     updated_by = excluded.updated_by`,
      [owner, input.scope, input.scopeId, input.key, input.value, input.now, input.actor],
    );
  }

  async readPlan(): Promise<{ planId: 'development' | 'paid'; source: string } | null> {
    const owner = requireOwner();
    const result = await this.query.query<{ plan_id: 'development' | 'paid'; source: string }>(
      `select plan_id, source from usage_entitlements where owner_ref = $1`,
      [owner],
    );
    const row = result.rows[0];
    return row === undefined ? null : { planId: row.plan_id, source: row.source };
  }

  async writePlan(input: {
    planId: 'development' | 'paid';
    source: 'default' | 'operator';
    actor: string;
    now: string;
  }): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into usage_entitlements (owner_ref, plan_id, source, updated_at, updated_by)
       values ($1, $2, $3, $4, $5)
       on conflict (owner_ref) do update set plan_id = excluded.plan_id,
                                             source = excluded.source,
                                             updated_at = excluded.updated_at,
                                             updated_by = excluded.updated_by`,
      [owner, input.planId, input.source, input.now, input.actor],
    );
  }
}
