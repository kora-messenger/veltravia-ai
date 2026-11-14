/**
 * Plans, subscriptions, periods, events and audit in PostgreSQL (Step 60).
 *
 * Two scopes live in one store, and the split is deliberate:
 *
 *  - **The catalogue is global.** A plan is deployment configuration, not
 *    somebody's row, so plan reads and writes carry no owner. Only the operator
 *    surface calls the write path, and the operator token is checked there.
 *  - **Subscriptions are owner data.** Every read and write asserts that the
 *    owner in scope is the owner being touched, so an owner route cannot reach
 *    another account even if a parameter were spoofed. The operator surface runs
 *    its writes inside the target's scope for the same reason.
 *
 * Three guarantees are decided in SQL rather than in the caller:
 *
 *  - **Compare-and-set.** `saveSubscription` updates only where the version still
 *    matches, and reports `null` when it did not, so two simultaneous changes
 *    cannot both land.
 *  - **One record per period.** `recordPeriod` inserts `on conflict do nothing`
 *    and reports whether it created the row: that boolean is what decides
 *    whether a renewal is notified.
 *  - **One event per dedupe key.** Same shape, so a retried job notifies once.
 */

import type {
  AuditFilter,
  EventFilter,
  ListSubscriptionsOptions,
  SubscriptionPeriodRecord,
  SubscriptionStore,
} from '@veltravia/subscriptions-core';
import {
  SubscriptionConflictError,
  type SubscriptionAuditRecord,
  type SubscriptionEvent,
  type SubscriptionPlanDefinition,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from '@veltravia/subscriptions-core';

import { assertOwnerMatch } from '../owner-scope.js';
import type { Database } from '../pool.js';

interface PlanRow {
  plan_id: string;
  name: string;
  description: string;
  rank: number;
  visible: boolean;
  active: boolean;
  self_service: boolean;
  monthly_message_credits: number;
  monthly_integration_credits: number;
  entitlements: Record<string, boolean | number | null> | null;
  quotas: Record<string, number | null> | null;
  version: number;
  built_in: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string;
}

interface SubscriptionRow {
  owner_ref: string;
  id: string;
  plan_id: string;
  status: SubscriptionStatus;
  started_at: Date;
  current_period_start: Date;
  current_period_end: Date;
  renews: boolean;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  suspended_at: Date | null;
  suspension_reason: string | null;
  expired_at: Date | null;
  last_changed_at: Date;
  last_changed_by: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  owner_ref: string;
  id: string;
  kind: SubscriptionEvent['kind'];
  plan_id: string;
  previous_plan_id: string | null;
  status: SubscriptionStatus;
  message: string;
  actor: string;
  dedupe_key: string;
  occurred_at: Date;
}

interface PeriodRow {
  owner_ref: string;
  period_start: Date;
  period_end: Date;
  plan_id: string;
  message_credits: number;
  integration_credits: number;
  kind: 'assignment' | 'renewal';
  actor: string;
  processed_at: Date;
}

interface AuditRow {
  owner_ref: string;
  id: string;
  scope: 'owner' | 'platform';
  action: SubscriptionAuditRecord['action'];
  actor: string;
  reason: string;
  previous_state: unknown;
  next_state: unknown;
  occurred_at: Date;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function toPlan(row: PlanRow): SubscriptionPlanDefinition {
  return {
    id: row.plan_id,
    name: row.name,
    description: row.description,
    rank: row.rank,
    visible: row.visible,
    active: row.active,
    selfService: row.self_service,
    monthlyMessageCredits: row.monthly_message_credits,
    monthlyIntegrationCredits: row.monthly_integration_credits,
    entitlements: row.entitlements ?? {},
    quotas: (row.quotas ?? {}) as SubscriptionPlanDefinition['quotas'],
    version: row.version,
    builtIn: row.built_in,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    planId: row.plan_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    currentPeriodStart: row.current_period_start.toISOString(),
    currentPeriodEnd: row.current_period_end.toISOString(),
    renews: row.renews,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    canceledAt: iso(row.canceled_at),
    suspendedAt: iso(row.suspended_at),
    suspensionReason: row.suspension_reason,
    expiredAt: iso(row.expired_at),
    lastChangedAt: row.last_changed_at.toISOString(),
    lastChangedBy: row.last_changed_by,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEvent(row: EventRow): SubscriptionEvent {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    kind: row.kind,
    planId: row.plan_id,
    previousPlanId: row.previous_plan_id,
    status: row.status,
    message: row.message,
    actor: row.actor,
    dedupeKey: row.dedupe_key,
    occurredAt: row.occurred_at.toISOString(),
  };
}

function toPeriod(row: PeriodRow): SubscriptionPeriodRecord {
  return {
    ownerRef: row.owner_ref,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    planId: row.plan_id,
    messageCredits: row.message_credits,
    integrationCredits: row.integration_credits,
    kind: row.kind,
    processedAt: row.processed_at.toISOString(),
    actor: row.actor,
  };
}

function toAudit(row: AuditRow): SubscriptionAuditRecord {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    action: row.action,
    actor: row.actor,
    reason: row.reason,
    previousState: row.previous_state,
    nextState: row.next_state,
    occurredAt: row.occurred_at.toISOString(),
  };
}

const PLAN_COLUMNS = `plan_id, name, description, rank, visible, active, self_service,
  monthly_message_credits, monthly_integration_credits, entitlements, quotas, version,
  built_in, created_at, updated_at, updated_by`;

const SUBSCRIPTION_COLUMNS = `owner_ref, id, plan_id, status, started_at, current_period_start,
  current_period_end, renews, cancel_at_period_end, canceled_at, suspended_at,
  suspension_reason, expired_at, last_changed_at, last_changed_by, version, created_at,
  updated_at`;

export class PostgresSubscriptionStore implements SubscriptionStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: Database) {}

  async listPlans(): Promise<readonly SubscriptionPlanDefinition[]> {
    const result = await this.db.query<PlanRow>(
      `select ${PLAN_COLUMNS} from subscription_plans order by rank, plan_id`,
    );
    return result.rows.map(toPlan);
  }

  async readPlan(planId: string): Promise<SubscriptionPlanDefinition | null> {
    const result = await this.db.query<PlanRow>(
      `select ${PLAN_COLUMNS} from subscription_plans where plan_id = $1`,
      [planId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPlan(row);
  }

  /**
   * Upsert. The version is the store's to increment: a caller that read version
   * 3 writes 4, whatever it put in the object, so an edit cannot rewind.
   */
  async savePlan(plan: SubscriptionPlanDefinition): Promise<SubscriptionPlanDefinition> {
    const result = await this.db.query<PlanRow>(
      `insert into subscription_plans
         (plan_id, name, description, rank, visible, active, self_service,
          monthly_message_credits, monthly_integration_credits, entitlements, quotas,
          version, built_in, created_at, updated_at, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, 1, $12,
               $13::timestamptz, $14::timestamptz, $15)
       on conflict (plan_id) do update set
         name = excluded.name,
         description = excluded.description,
         rank = excluded.rank,
         visible = excluded.visible,
         active = excluded.active,
         self_service = excluded.self_service,
         monthly_message_credits = excluded.monthly_message_credits,
         monthly_integration_credits = excluded.monthly_integration_credits,
         entitlements = excluded.entitlements,
         quotas = excluded.quotas,
         version = subscription_plans.version + 1,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by
       returning ${PLAN_COLUMNS}`,
      [
        plan.id,
        plan.name,
        plan.description,
        plan.rank,
        plan.visible,
        plan.active,
        plan.selfService,
        plan.monthlyMessageCredits,
        plan.monthlyIntegrationCredits,
        JSON.stringify(plan.entitlements),
        JSON.stringify(plan.quotas),
        plan.builtIn,
        plan.createdAt,
        plan.updatedAt,
        plan.updatedBy,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new SubscriptionConflictError('The plan could not be saved.');
    return toPlan(row);
  }

  async readSubscription(ownerRef: string): Promise<SubscriptionRecord | null> {
    assertOwnerMatch(ownerRef);
    const result = await this.db.query<SubscriptionRow>(
      `select ${SUBSCRIPTION_COLUMNS} from subscriptions where owner_ref = $1`,
      [ownerRef],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Operator listing. Not owner data by the row, but the caller is the operator
   * surface only: no owner route is registered against this method, and the plan
   * filter is what an operator screen narrows by.
   */
  async listSubscriptions(
    options: ListSubscriptionsOptions = {},
  ): Promise<readonly SubscriptionRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const skip = Math.max(options.skip ?? 0, 0);
    const result = await this.db.query<SubscriptionRow>(
      `select ${SUBSCRIPTION_COLUMNS} from subscriptions
        where ($1::text is null or plan_id = $1)
          and ($2::text is null or status = $2)
        order by updated_at desc
        limit $3 offset $4`,
      [options.planId ?? null, options.status ?? null, limit, skip],
    );
    return result.rows.map(toRecord);
  }

  async saveSubscription(
    record: SubscriptionRecord,
    expectedVersion: number | null,
  ): Promise<SubscriptionRecord> {
    assertOwnerMatch(record.ownerRef);

    if (expectedVersion === null) {
      const inserted = await this.db.query<SubscriptionRow>(
        `insert into subscriptions
           (owner_ref, id, plan_id, status, started_at, current_period_start,
            current_period_end, renews, cancel_at_period_end, canceled_at, suspended_at,
            suspension_reason, expired_at, last_changed_at, last_changed_by, version,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8, $9,
                 $10::timestamptz, $11::timestamptz, $12, $13::timestamptz,
                 $14::timestamptz, $15, $16, $17::timestamptz, $18::timestamptz)
         on conflict (owner_ref) do nothing
         returning ${SUBSCRIPTION_COLUMNS}`,
        [
          record.ownerRef,
          record.id,
          record.planId,
          record.status,
          record.startedAt,
          record.currentPeriodStart,
          record.currentPeriodEnd,
          record.renews,
          record.cancelAtPeriodEnd,
          record.canceledAt,
          record.suspendedAt,
          record.suspensionReason,
          record.expiredAt,
          record.lastChangedAt,
          record.lastChangedBy,
          record.version,
          record.createdAt,
          record.updatedAt,
        ],
      );
      const created = inserted.rows[0];
      if (created === undefined) throw new SubscriptionConflictError();
      return toRecord(created);
    }

    const updated = await this.db.query<SubscriptionRow>(
      `update subscriptions set
         plan_id = $3,
         status = $4,
         started_at = $5::timestamptz,
         current_period_start = $6::timestamptz,
         current_period_end = $7::timestamptz,
         renews = $8,
         cancel_at_period_end = $9,
         canceled_at = $10::timestamptz,
         suspended_at = $11::timestamptz,
         suspension_reason = $12,
         expired_at = $13::timestamptz,
         last_changed_at = $14::timestamptz,
         last_changed_by = $15,
         version = $16,
         updated_at = $17::timestamptz
       where owner_ref = $1 and version = $2
       returning ${SUBSCRIPTION_COLUMNS}`,
      [
        record.ownerRef,
        expectedVersion,
        record.planId,
        record.status,
        record.startedAt,
        record.currentPeriodStart,
        record.currentPeriodEnd,
        record.renews,
        record.cancelAtPeriodEnd,
        record.canceledAt,
        record.suspendedAt,
        record.suspensionReason,
        record.expiredAt,
        record.lastChangedAt,
        record.lastChangedBy,
        record.version,
        record.updatedAt,
      ],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new SubscriptionConflictError();
    return toRecord(row);
  }

  async appendEvent(event: SubscriptionEvent): Promise<{ readonly created: boolean }> {
    assertOwnerMatch(event.ownerRef);
    const result = await this.db.query<{ id: string }>(
      `insert into subscription_events
         (owner_ref, id, kind, plan_id, previous_plan_id, status, message, actor,
          dedupe_key, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
       on conflict do nothing
       returning id`,
      [
        event.ownerRef,
        event.id,
        event.kind,
        event.planId,
        event.previousPlanId,
        event.status,
        event.message,
        event.actor,
        event.dedupeKey,
        event.occurredAt,
      ],
    );
    return { created: result.rows.length > 0 };
  }

  async listEvents(
    ownerRef: string,
    filter: EventFilter = {},
  ): Promise<readonly SubscriptionEvent[]> {
    assertOwnerMatch(ownerRef);
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    const result = await this.db.query<EventRow>(
      `select owner_ref, id, kind, plan_id, previous_plan_id, status, message, actor,
              dedupe_key, occurred_at
         from subscription_events
        where owner_ref = $1 and ($2::text is null or kind = $2)
        order by occurred_at desc
        limit $3`,
      [ownerRef, filter.kind ?? null, limit],
    );
    return result.rows.map(toEvent);
  }

  async recordPeriod(entry: SubscriptionPeriodRecord): Promise<{ readonly created: boolean }> {
    assertOwnerMatch(entry.ownerRef);
    const result = await this.db.query<{ owner_ref: string }>(
      `insert into subscription_periods
         (owner_ref, period_start, period_end, plan_id, message_credits,
          integration_credits, kind, actor, processed_at)
       values ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8, $9::timestamptz)
       on conflict (owner_ref, period_start) do nothing
       returning owner_ref`,
      [
        entry.ownerRef,
        entry.periodStart,
        entry.periodEnd,
        entry.planId,
        entry.messageCredits,
        entry.integrationCredits,
        entry.kind,
        entry.actor,
        entry.processedAt,
      ],
    );
    return { created: result.rows.length > 0 };
  }

  async listPeriods(ownerRef: string, limit = 24): Promise<readonly SubscriptionPeriodRecord[]> {
    assertOwnerMatch(ownerRef);
    const result = await this.db.query<PeriodRow>(
      `select owner_ref, period_start, period_end, plan_id, message_credits,
              integration_credits, kind, actor, processed_at
         from subscription_periods
        where owner_ref = $1
        order by period_start desc
        limit $2`,
      [ownerRef, Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows.map(toPeriod);
  }

  /**
   * Audit rows are append-only. A catalogue change is platform-scoped and is not
   * anybody's account history, so it is written without an owner match; an
   * account's own change asserts the owner like every other owner write.
   */
  async appendAudit(
    record: SubscriptionAuditRecord,
    scope: 'owner' | 'platform' = 'owner',
  ): Promise<void> {
    if (scope === 'owner') assertOwnerMatch(record.ownerRef);
    await this.db.query(
      `insert into subscription_audit
         (owner_ref, id, scope, action, actor, reason, previous_state, next_state, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz)
       on conflict (owner_ref, id) do nothing`,
      [
        record.ownerRef,
        record.id,
        scope,
        record.action,
        record.actor,
        record.reason,
        record.previousState === undefined ? null : JSON.stringify(record.previousState),
        record.nextState === undefined ? null : JSON.stringify(record.nextState),
        record.occurredAt,
      ],
    );
  }

  async listAudit(
    ownerRef: string,
    filter: AuditFilter = {},
  ): Promise<readonly SubscriptionAuditRecord[]> {
    assertOwnerMatch(ownerRef);
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    const result = await this.db.query<AuditRow>(
      `select owner_ref, id, scope, action, actor, reason, previous_state, next_state,
              occurred_at
         from subscription_audit
        where owner_ref = $1 and scope = 'owner'
          and ($2::text is null or action = $2)
        order by occurred_at desc
        limit $3`,
      [ownerRef, filter.action ?? null, limit],
    );
    return result.rows.map(toAudit);
  }

  /** Catalogue change history, for the operator screen. */
  async listPlatformAudit(limit = 50): Promise<readonly SubscriptionAuditRecord[]> {
    const result = await this.db.query<AuditRow>(
      `select owner_ref, id, scope, action, actor, reason, previous_state, next_state,
              occurred_at
         from subscription_audit
        where scope = 'platform'
        order by occurred_at desc
        limit $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map(toAudit);
  }

  /** Used by the boot seeder: is the catalogue there at all? */
  async planCount(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `select count(*)::text as count from subscription_plans`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
