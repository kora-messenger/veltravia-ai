/**
 * Integration charges in PostgreSQL (Step 56).
 *
 * `insertCharge` relies on the unique `(owner_ref, idempotency_key)` index: on a
 * retry the insert does nothing and the existing row is read back, so an
 * operation that arrives twice is charged once. `saveCharge` is a
 * compare-and-set on the state, which is what stops two settlements of one hold
 * from both posting.
 */

import type {
  ChargeFilter,
  ChargePage,
  IntegrationCharge,
  IntegrationCreditStore,
  IntegrationSpendingSettings,
  LimitUsageGroup,
  LimitUsageOptions,
  MeasurementUnit,
  UsageDimension,
  UsageGroup,
} from '@veltravia/integration-credits-core';

import { type Database } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

/**
 * Namespace for the Step 59 spending-decision advisory lock. A different number
 * from any other advisory lock in the codebase, so two features can never block
 * each other by sharing a key space.
 */
const SPENDING_LOCK_NAMESPACE = 5949;

interface ChargeRow {
  owner_ref: string;
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  integration_id: string | null;
  connector_id: string | null;
  plugin_id: string | null;
  operation_id: string | null;
  execution_id: string | null;
  request_id: string | null;
  connection_id: string | null;
  kind: IntegrationCharge['kind'];
  billing_class: IntegrationCharge['billingClass'];
  plan_id: string;
  policy_id: string;
  credits: string;
  estimated_credits: string;
  state: IntegrationCharge['state'];
  basis: IntegrationCharge['basis'];
  requests: number | null;
  units: Partial<Record<MeasurementUnit, number>> | null;
  duration_ms: string | null;
  limitations: IntegrationCharge['limitations'] | null;
  measurement_source: IntegrationCharge['measurementSource'];
  byok: boolean;
  idempotency_key: string;
  reservation_id: string | null;
  wallet_entry_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  settled_at: Date | null;
  refunded_at: Date | null;
}

const num = (value: string | number | null): number | null => {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toCharge = (row: ChargeRow): IntegrationCharge => ({
  id: row.id,
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  projectId: row.project_id,
  integrationId: row.integration_id,
  connectorId: row.connector_id,
  pluginId: row.plugin_id,
  operationId: row.operation_id,
  executionId: row.execution_id,
  requestId: row.request_id,
  connectionId: row.connection_id,
  kind: row.kind,
  billingClass: row.billing_class,
  planId: row.plan_id,
  policyId: row.policy_id,
  credits: num(row.credits) ?? 0,
  estimatedCredits: num(row.estimated_credits) ?? 0,
  state: row.state,
  basis: row.basis,
  requests: row.requests,
  units: row.units ?? {},
  durationMs: num(row.duration_ms),
  limitations: row.limitations ?? [],
  measurementSource: row.measurement_source ?? null,
  byok: row.byok,
  idempotencyKey: row.idempotency_key,
  reservationId: row.reservation_id,
  walletEntryId: row.wallet_entry_id,
  failureReason: row.failure_reason,
  createdAt: new Date(row.created_at).toISOString(),
  settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
  refundedAt: row.refunded_at === null ? null : new Date(row.refunded_at).toISOString(),
});

const COLUMNS = `owner_ref, id, workspace_id, project_id, integration_id, connector_id, plugin_id,
  operation_id, execution_id, request_id, connection_id, kind, billing_class, plan_id, policy_id,
  credits, estimated_credits, state, basis, requests, units, duration_ms, limitations,
  measurement_source, byok, idempotency_key, reservation_id, wallet_entry_id, failure_reason,
  created_at, settled_at, refunded_at`;

export class PostgresIntegrationCreditStore implements IntegrationCreditStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly database: Database) {}

  /**
   * Serialises one owner's check-then-hold across processes (Step 59).
   *
   * An advisory transaction lock, taken on the owner's key and released when the
   * transaction ends, so a second API instance blocks on the same decision
   * rather than reading an allowance the first instance is about to spend. The
   * callback's own queries run on the pool; what matters is that this
   * transaction stays open until they have finished.
   */
  withOwnerGuard<T>(ownerRef: string, fn: () => Promise<T>): Promise<T> {
    // One key per owner per lane. The namespaces keep a message limit and an
    // integration limit from blocking each other, and 5949 keeps this clear of
    // every other advisory lock in the codebase.
    return this.database.withAdvisoryLock(
      `veltravia:${SPENDING_LOCK_NAMESPACE}:${this.kind}:${ownerRef}`,
      fn,
    );
  }

  private get query() {
    return this.database;
  }

  async insertCharge(
    charge: IntegrationCharge,
  ): Promise<{ charge: IntegrationCharge; created: boolean }> {
    const owner = requireOwner();
    const inserted = await this.query.query<ChargeRow>(
      `insert into integration_charges (${COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
       on conflict (owner_ref, idempotency_key) do nothing
       returning ${COLUMNS}`,
      [
        owner,
        charge.id,
        charge.workspaceId,
        charge.projectId,
        charge.integrationId,
        charge.connectorId,
        charge.pluginId,
        charge.operationId,
        charge.executionId,
        charge.requestId,
        charge.connectionId,
        charge.kind,
        charge.billingClass,
        charge.planId,
        charge.policyId,
        charge.credits,
        charge.estimatedCredits,
        charge.state,
        charge.basis,
        charge.requests,
        JSON.stringify(charge.units),
        charge.durationMs,
        JSON.stringify(charge.limitations),
        charge.measurementSource,
        charge.byok,
        charge.idempotencyKey,
        charge.reservationId,
        charge.walletEntryId,
        charge.failureReason,
        charge.createdAt,
        charge.settledAt,
        charge.refundedAt,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { charge: toCharge(row), created: true };
    const existing = await this.findByKey(owner, charge.idempotencyKey);
    if (existing === null) throw new Error('integration charge insert vanished without a row');
    return { charge: existing, created: false };
  }

  async findByKey(ownerRef: string, idempotencyKey: string): Promise<IntegrationCharge | null> {
    requireOwner();
    const found = await this.query.query<ChargeRow>(
      `select ${COLUMNS} from integration_charges
        where owner_ref = $1 and idempotency_key = $2`,
      [ownerRef, idempotencyKey],
    );
    const row = found.rows[0];
    return row === undefined ? null : toCharge(row);
  }

  async findById(ownerRef: string, chargeId: string): Promise<IntegrationCharge | null> {
    requireOwner();
    const found = await this.query.query<ChargeRow>(
      `select ${COLUMNS} from integration_charges where owner_ref = $1 and id = $2`,
      [ownerRef, chargeId],
    );
    const row = found.rows[0];
    return row === undefined ? null : toCharge(row);
  }

  async saveCharge(
    charge: IntegrationCharge,
    expectedState: IntegrationCharge['state'],
  ): Promise<boolean> {
    const owner = requireOwner();
    const saved = await this.query.query<{ id: string }>(
      `update integration_charges
          set workspace_id = $3, project_id = $4, integration_id = $5, connector_id = $6,
              plugin_id = $7, operation_id = $8, execution_id = $9, request_id = $10,
              connection_id = $11, kind = $12, billing_class = $13, plan_id = $14,
              policy_id = $15, credits = $16, estimated_credits = $17, state = $18, basis = $19,
              requests = $20, units = $21, duration_ms = $22, limitations = $23,
              measurement_source = $24, byok = $25, reservation_id = $26, wallet_entry_id = $27,
              failure_reason = $28, settled_at = $29, refunded_at = $30
        where owner_ref = $1 and id = $2 and state = $31
        returning id`,
      [
        owner,
        charge.id,
        charge.workspaceId,
        charge.projectId,
        charge.integrationId,
        charge.connectorId,
        charge.pluginId,
        charge.operationId,
        charge.executionId,
        charge.requestId,
        charge.connectionId,
        charge.kind,
        charge.billingClass,
        charge.planId,
        charge.policyId,
        charge.credits,
        charge.estimatedCredits,
        charge.state,
        charge.basis,
        charge.requests,
        JSON.stringify(charge.units),
        charge.durationMs,
        JSON.stringify(charge.limitations),
        charge.measurementSource,
        charge.byok,
        charge.reservationId,
        charge.walletEntryId,
        charge.failureReason,
        charge.settledAt,
        charge.refundedAt,
        expectedState,
      ],
    );
    return saved.rows.length > 0;
  }

  async listCharges(ownerRef: string, filter: ChargeFilter): Promise<ChargePage> {
    requireOwner();
    // Step 58: date bounds and free text belong in the query, not in a caller's
    // memory, so a filtered page and its total describe the same rows.
    const where = `owner_ref = $1
      and ($2::text is null or workspace_id = $2)
      and ($3::text is null or project_id = $3)
      and ($4::text is null or integration_id = $4)
      and ($5::text is null or connector_id = $5)
      and ($6::text is null or operation_id = $6)
      and ($7::text is null or execution_id = $7)
      and ($8::text is null or kind = $8)
      and ($9::text is null or state = $9)
      and ($10::text is null or billing_class = $10)
      and ($13::timestamptz is null or created_at >= $13::timestamptz)
      and ($14::timestamptz is null or created_at <= $14::timestamptz)
      and (
        $11::timestamptz is null
        or created_at < $11::timestamptz
        or (created_at = $11::timestamptz and id < $12::text)
      )
      and (
        $15::text is null
        or id ilike $15
        or coalesce(operation_id, '') ilike $15
        or coalesce(integration_id, '') ilike $15
        or coalesce(connector_id, '') ilike $15
        or coalesce(project_id, '') ilike $15
        or coalesce(kind, '') ilike $15
      )`;
    const params = [
      ownerRef,
      filter.workspaceId ?? null,
      filter.projectId ?? null,
      filter.integrationId ?? null,
      filter.connectorId ?? null,
      filter.operationId ?? null,
      filter.executionId ?? null,
      filter.kind ?? null,
      filter.state ?? null,
      filter.billingClass ?? null,
      filter.beforeAt ?? null,
      filter.beforeId ?? null,
      filter.since ?? null,
      filter.until ?? null,
      filter.query === undefined || filter.query.trim() === '' ? null : `%${filter.query.trim()}%`,
    ];
    const rows = await this.query.query<ChargeRow>(
      `select ${COLUMNS} from integration_charges
        where ${where}
        order by created_at desc, id desc
        limit $16 offset $17`,
      [...params, filter.limit, filter.offset ?? 0],
    );
    const total = await this.query.query<{ total: string }>(
      `select count(*)::text as total from integration_charges where ${where}`,
      params,
    );
    return {
      charges: rows.rows.map(toCharge),
      total: Number(total.rows[0]?.total ?? '0'),
    };
  }

  /** Credit per operation kind inside one window (Step 59); holds included. */
  async limitUsage(
    ownerRef: string,
    options: LimitUsageOptions,
  ): Promise<readonly LimitUsageGroup[]> {
    requireOwner();
    const result = await this.query.query<{
      key: string;
      charges: string;
      committed: string;
      reserved: string;
      refunded: string;
    }>(
      `select kind as key,
              count(*)::text as charges,
              coalesce(sum(case when state = 'committed' then credits else 0 end), 0)::text as committed,
              coalesce(sum(case when state = 'reserved' then estimated_credits else 0 end), 0)::text as reserved,
              coalesce(sum(case when state = 'refunded' then credits else 0 end), 0)::text as refunded
         from integration_charges
        where owner_ref = $1
          and state <> 'released'
          and created_at >= $2::timestamptz
          and created_at < $3::timestamptz
          and ($4::text is null or workspace_id = $4)
          and ($5::text is null or project_id = $5)
        group by 1`,
      [
        ownerRef,
        options.since,
        options.until,
        options.workspaceId ?? null,
        options.projectId ?? null,
      ],
    );
    return result.rows.map((row) => ({
      key: row.key,
      charges: Number(row.charges),
      committed: Number(row.committed),
      reserved: Number(row.reserved),
      refunded: Number(row.refunded),
    }));
  }

  async heldCredits(ownerRef: string): Promise<number> {
    requireOwner();
    const result = await this.query.query<{ held: string }>(
      `select coalesce(sum(estimated_credits), 0)::text as held
         from integration_charges
        where owner_ref = $1 and state = 'reserved'`,
      [ownerRef],
    );
    return Number(result.rows[0]?.held ?? 0);
  }

  async aggregate(
    ownerRef: string,
    dimension: UsageDimension,
    options: { readonly since?: string; readonly workspaceId?: string | null } = {},
  ): Promise<readonly UsageGroup[]> {
    requireOwner();
    const column =
      dimension === 'integration'
        ? `coalesce(integration_id, 'unassigned')`
        : dimension === 'connector'
          ? `coalesce(connector_id, 'no-connector')`
          : dimension === 'operation'
            ? `coalesce(operation_id, 'no-operation')`
            : dimension === 'project'
              ? `coalesce(project_id, 'no-project')`
              : 'billing_class';
    const result = await this.query.query<{
      key: string;
      charges: string;
      credits: string;
      requests: string;
      units: string;
    }>(
      `select ${column} as key,
              count(*)::text as charges,
              coalesce(sum(credits), 0)::text as credits,
              coalesce(sum(requests), 0)::text as requests,
              coalesce(sum((select coalesce(sum(value::numeric), 0)
                              from jsonb_each_text(units) as entry(key, value))), 0)::text as units
         from integration_charges
        where owner_ref = $1
          and state in ('committed', 'exempt')
          and ($2::timestamptz is null or created_at >= $2)
          and ($3::text is null or workspace_id = $3)
        group by 1
        order by 3 desc`,
      [ownerRef, options.since ?? null, options.workspaceId ?? null],
    );
    return result.rows.map((row) => ({
      key: row.key,
      charges: Number(row.charges),
      credits: Number(row.credits),
      requests: Number(row.requests),
      units: Number(row.units),
    }));
  }

  async readSettings(
    ownerRef: string,
    workspaceId: string | null,
  ): Promise<IntegrationSpendingSettings | null> {
    requireOwner();
    const found = await this.query.query<{
      monthly_limit: string | null;
      per_operation_limit: string | null;
      updated_at: Date;
    }>(
      `select monthly_limit, per_operation_limit, updated_at
         from integration_credit_settings where owner_ref = $1 and workspace_id = $2`,
      [ownerRef, workspaceId ?? ''],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    return {
      ownerRef,
      workspaceId,
      monthlyLimit: num(row.monthly_limit),
      perOperationLimit: num(row.per_operation_limit),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async saveSettings(settings: IntegrationSpendingSettings): Promise<IntegrationSpendingSettings> {
    const owner = requireOwner();
    await this.query.query(
      `insert into integration_credit_settings
         (owner_ref, workspace_id, monthly_limit, per_operation_limit, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (owner_ref, workspace_id) do update
         set monthly_limit = excluded.monthly_limit,
             per_operation_limit = excluded.per_operation_limit,
             updated_at = now()`,
      [owner, settings.workspaceId ?? '', settings.monthlyLimit, settings.perOperationLimit],
    );
    return { ...settings, ownerRef: owner };
  }

  async listOpen(ownerRef: string, limit: number): Promise<readonly IntegrationCharge[]> {
    requireOwner();
    const rows = await this.query.query<ChargeRow>(
      `select ${COLUMNS} from integration_charges
        where owner_ref = $1 and state = 'reserved'
        order by created_at asc
        limit $2`,
      [ownerRef, limit],
    );
    return rows.rows.map(toCharge);
  }

  /**
   * The accounts holding credit, oldest hold first, for the scheduled sweep.
   *
   * Only owner keys cross the owner boundary here; the charges themselves are
   * still read inside each account's own scope. An unscoped query would be a
   * way around the ownership rule, so this runs under a caller-provided scope
   * like every other read.
   */
  async listOpenOwners(limit: number): Promise<readonly string[]> {
    requireOwner();
    const rows = await this.query.query<{ owner_ref: string }>(
      `select owner_ref, min(created_at) as first_at
         from integration_charges
        where state = 'reserved'
        group by owner_ref
        order by first_at asc
        limit $1`,
      [limit],
    );
    return rows.rows.map((row) => row.owner_ref);
  }
}
