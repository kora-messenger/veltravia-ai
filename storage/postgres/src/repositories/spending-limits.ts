/**
 * Spending limit policies, platform policy, events and audit in PostgreSQL
 * (Step 59).
 *
 * Three guarantees are decided here rather than in the caller:
 *
 *  - **Compare-and-set.** A policy write names the version it saw. The update
 *    only lands when that version is still the row's version, and the version
 *    is incremented in the same statement. Two people saving at once cannot
 *    both win, so a limit is never silently a blend of two edits.
 *  - **One warning per window.** `(owner_ref, dedupe_key)` is unique and the
 *    insert does nothing on conflict, so a threshold crossed by fifty concurrent
 *    requests is recorded once. The caller learns whether it created the row,
 *    which is what decides whether to notify.
 *  - **Widening only.** Nothing here writes a charge, a ledger entry or a
 *    balance. Limits read spending; they never invent it.
 */

import type {
  AuditFilter,
  EventFilter,
  LimitAuditRecord,
  LimitEvent,
  LimitEventKind,
  LimitScope,
  PlatformLimitPolicy,
  PolicyKey,
  SpendingLimitPolicy,
  SpendingLimitRule,
  SpendingLimitStore,
} from '@veltravia/spending-limits-core';

import { requireOwner } from '../owner-scope.js';
import type { Database } from '../pool.js';

const num = (value: number | string | null): number => {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
};

const numOrNull = (value: number | string | null): number | null =>
  value === null ? null : num(value);

interface PolicyRow {
  owner_ref: string;
  scope: LimitScope;
  workspace_id: string;
  project_id: string;
  rules: SpendingLimitRule[] | null;
  per_operation_limit: string | null;
  max_reserved_credits: string | null;
  version: number;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  owner_ref: string;
  id: string;
  kind: LimitEventKind;
  scope: LimitScope;
  workspace_id: string | null;
  project_id: string | null;
  rule_id: string | null;
  window_key: string | null;
  threshold: string | null;
  credit_limit: string | null;
  consumed: string | null;
  requested: string | null;
  message: string;
  dedupe_key: string;
  actor: string;
  occurred_at: Date;
}

interface AuditRow {
  owner_ref: string;
  id: string;
  scope: LimitScope;
  workspace_id: string | null;
  project_id: string | null;
  action: LimitAuditRecord['action'];
  actor: string;
  reason: string;
  previous_state: unknown;
  next_state: unknown;
  occurred_at: Date;
}

const policyId = (key: PolicyKey): string =>
  `${key.ownerRef}:${key.scope}:${key.workspaceId ?? '-'}:${key.projectId ?? '-'}`;

function toPolicy(row: PolicyRow): SpendingLimitPolicy {
  return {
    id: policyId({
      ownerRef: row.owner_ref,
      scope: row.scope,
      workspaceId: row.workspace_id === '' ? null : row.workspace_id,
      projectId: row.project_id === '' ? null : row.project_id,
    }),
    ownerRef: row.owner_ref,
    scope: row.scope,
    workspaceId: row.workspace_id === '' ? null : row.workspace_id,
    projectId: row.project_id === '' ? null : row.project_id,
    rules: Array.isArray(row.rules) ? row.rules : [],
    perOperationLimit: numOrNull(row.per_operation_limit),
    maxReservedCredits: numOrNull(row.max_reserved_credits),
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function toEvent(row: EventRow): LimitEvent {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    kind: row.kind,
    scope: row.scope,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    ruleId: row.rule_id,
    windowKey: row.window_key,
    threshold: numOrNull(row.threshold),
    limit: numOrNull(row.credit_limit),
    consumed: numOrNull(row.consumed),
    requested: numOrNull(row.requested),
    message: row.message,
    dedupeKey: row.dedupe_key,
    actor: row.actor,
    occurredAt: row.occurred_at.toISOString(),
  };
}

function toAudit(row: AuditRow): LimitAuditRecord {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    scope: row.scope,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    action: row.action,
    actor: row.actor,
    reason: row.reason,
    previous: row.previous_state,
    next: row.next_state,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export class PostgresSpendingLimitStore implements SpendingLimitStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: Database) {}

  async readPolicy(key: PolicyKey): Promise<SpendingLimitPolicy | null> {
    requireOwner();
    const result = await this.db.query<PolicyRow>(
      `select owner_ref, scope, workspace_id, project_id, rules,
              per_operation_limit, max_reserved_credits, version,
              updated_by, created_at, updated_at
         from spending_limit_policies
        where owner_ref = $1 and scope = $2 and workspace_id = $3 and project_id = $4`,
      [key.ownerRef, key.scope, key.workspaceId ?? '', key.projectId ?? ''],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPolicy(row);
  }

  async listPolicies(ownerRef: string): Promise<readonly SpendingLimitPolicy[]> {
    requireOwner();
    const result = await this.db.query<PolicyRow>(
      `select owner_ref, scope, workspace_id, project_id, rules,
              per_operation_limit, max_reserved_credits, version,
              updated_by, created_at, updated_at
         from spending_limit_policies
        where owner_ref = $1
        order by updated_at desc`,
      [ownerRef],
    );
    return result.rows.map(toPolicy);
  }

  /**
   * Compare-and-set. `expectedVersion === null` means create, and an existing
   * row makes the insert do nothing, so the caller sees `null` and re-reads
   * instead of overwriting somebody's policy with a fresh one.
   */
  async savePolicy(
    policy: SpendingLimitPolicy,
    expectedVersion: number | null,
  ): Promise<SpendingLimitPolicy | null> {
    requireOwner();
    if (expectedVersion === null) {
      const inserted = await this.db.query<PolicyRow>(
        `insert into spending_limit_policies
           (owner_ref, scope, workspace_id, project_id, rules,
            per_operation_limit, max_reserved_credits, version, updated_by,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz)
         on conflict (owner_ref, scope, workspace_id, project_id) do nothing
         returning owner_ref, scope, workspace_id, project_id, rules,
                   per_operation_limit, max_reserved_credits, version,
                   updated_by, created_at, updated_at`,
        [
          policy.ownerRef,
          policy.scope,
          policy.workspaceId ?? '',
          policy.projectId ?? '',
          JSON.stringify(policy.rules),
          policy.perOperationLimit,
          policy.maxReservedCredits,
          policy.version,
          policy.updatedBy,
          policy.updatedAt,
        ],
      );
      const row = inserted.rows[0];
      return row === undefined ? null : toPolicy(row);
    }

    const updated = await this.db.query<PolicyRow>(
      `update spending_limit_policies
          set rules = $5::jsonb,
              per_operation_limit = $6,
              max_reserved_credits = $7,
              version = version + 1,
              updated_by = $8,
              updated_at = $9::timestamptz
        where owner_ref = $1 and scope = $2 and workspace_id = $3 and project_id = $4
          and version = $10
        returning owner_ref, scope, workspace_id, project_id, rules,
                  per_operation_limit, max_reserved_credits, version,
                  updated_by, created_at, updated_at`,
      [
        policy.ownerRef,
        policy.scope,
        policy.workspaceId ?? '',
        policy.projectId ?? '',
        JSON.stringify(policy.rules),
        policy.perOperationLimit,
        policy.maxReservedCredits,
        policy.updatedBy,
        policy.updatedAt,
        expectedVersion,
      ],
    );
    const row = updated.rows[0];
    return row === undefined ? null : toPolicy(row);
  }

  async deletePolicy(key: PolicyKey, expectedVersion: number): Promise<boolean> {
    requireOwner();
    const result = await this.db.query(
      `delete from spending_limit_policies
        where owner_ref = $1 and scope = $2 and workspace_id = $3 and project_id = $4
          and version = $5`,
      [key.ownerRef, key.scope, key.workspaceId ?? '', key.projectId ?? '', expectedVersion],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async readPlatform(): Promise<PlatformLimitPolicy | null> {
    const result = await this.db.query<{ policy: PlatformLimitPolicy }>(
      `select policy from spending_limit_platform where id = 'platform'`,
    );
    const row = result.rows[0];
    return row === undefined ? null : row.policy;
  }

  async savePlatform(policy: PlatformLimitPolicy): Promise<PlatformLimitPolicy> {
    await this.db.query(
      `insert into spending_limit_platform (id, policy, updated_at)
       values ('platform', $1::jsonb, $2::timestamptz)
       on conflict (id) do update
          set policy = excluded.policy, updated_at = excluded.updated_at`,
      [JSON.stringify(policy), policy.updatedAt],
    );
    return policy;
  }

  async appendEvent(event: LimitEvent): Promise<{ event: LimitEvent; created: boolean }> {
    requireOwner();
    const inserted = await this.db.query<EventRow>(
      `insert into spending_limit_events
         (owner_ref, id, kind, scope, workspace_id, project_id, rule_id, window_key,
          threshold, credit_limit, consumed, requested, message, dedupe_key, actor, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz)
       on conflict (owner_ref, dedupe_key) do nothing
       returning owner_ref, id, kind, scope, workspace_id, project_id, rule_id, window_key,
                 threshold, credit_limit, consumed, requested, message, dedupe_key, actor,
                 occurred_at`,
      [
        event.ownerRef,
        event.id,
        event.kind,
        event.scope,
        event.workspaceId,
        event.projectId,
        event.ruleId,
        event.windowKey,
        event.threshold,
        event.limit,
        event.consumed,
        event.requested,
        event.message,
        event.dedupeKey,
        event.actor,
        event.occurredAt,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { event: toEvent(row), created: true };

    const existing = await this.db.query<EventRow>(
      `select owner_ref, id, kind, scope, workspace_id, project_id, rule_id, window_key,
              threshold, credit_limit, consumed, requested, message, dedupe_key, actor,
              occurred_at
         from spending_limit_events
        where owner_ref = $1 and dedupe_key = $2`,
      [event.ownerRef, event.dedupeKey],
    );
    const found = existing.rows[0];
    return { event: found === undefined ? event : toEvent(found), created: false };
  }

  async listEvents(ownerRef: string, filter: EventFilter): Promise<readonly LimitEvent[]> {
    requireOwner();
    const result = await this.db.query<EventRow>(
      `select owner_ref, id, kind, scope, workspace_id, project_id, rule_id, window_key,
              threshold, credit_limit, consumed, requested, message, dedupe_key, actor,
              occurred_at
         from spending_limit_events
        where owner_ref = $1
          and ($2::text is null or kind = $2)
          and ($3::timestamptz is null or occurred_at >= $3::timestamptz)
        order by occurred_at desc
        limit $4`,
      [ownerRef, filter.kind ?? null, filter.since ?? null, filter.limit],
    );
    return result.rows.map(toEvent);
  }

  async appendAudit(record: LimitAuditRecord): Promise<LimitAuditRecord> {
    requireOwner();
    await this.db.query(
      `insert into spending_limit_audit
         (owner_ref, id, scope, workspace_id, project_id, action, actor, reason,
          previous_state, next_state, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz)
       on conflict (owner_ref, id) do nothing`,
      [
        record.ownerRef,
        record.id,
        record.scope,
        record.workspaceId,
        record.projectId,
        record.action,
        record.actor,
        record.reason,
        record.previous === undefined ? null : JSON.stringify(record.previous),
        record.next === undefined ? null : JSON.stringify(record.next),
        record.occurredAt,
      ],
    );
    return record;
  }

  async listAudit(ownerRef: string, filter: AuditFilter): Promise<readonly LimitAuditRecord[]> {
    requireOwner();
    const result = await this.db.query<AuditRow>(
      `select owner_ref, id, scope, workspace_id, project_id, action, actor, reason,
              previous_state, next_state, occurred_at
         from spending_limit_audit
        where owner_ref = $1
          and ($2::timestamptz is null or occurred_at >= $2::timestamptz)
        order by occurred_at desc
        limit $3`,
      [ownerRef, filter.since ?? null, filter.limit],
    );
    return result.rows.map(toAudit);
  }
}
