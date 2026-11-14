/**
 * Workspace allocations in PostgreSQL (Step 62).
 *
 * One property matters more than the rest: `apply` reads the pool and the
 * allocations, checks the rules and writes the result **inside one transaction
 * that first takes an advisory lock on the pool**. Two reservations for the same
 * workspace therefore run one after the other, and the second computes against
 * the first's committed numbers. The lock is transaction-scoped, so it is
 * released on commit, on rollback, and by the server if this process dies.
 *
 * The movement idempotency row is inserted before anything else. A retried
 * request finds its own row, stops, and returns the current state marked as a
 * replay, so no credit moves twice.
 *
 * Reading a pool for a write and writing it in a later statement is precisely the
 * mistake Step 53 found in the wallet; there is no moment between the two here.
 */

import {
  AllocationError,
  applyMovement,
  type Allocation,
  type AllocationEvent,
  type AllocationPolicyConfig,
  type AllocationPolicyName,
  type AllocationQuery,
  type AllocationHistoryQuery,
  type AllocationStore,
  type AllocationTargetKind,
  type AllocationState,
  type CreditCategory,
  type MovementApplied,
  type MovementRequest,
  type WorkspacePool,
} from '@veltravia/allocation-core';

import { assertOwnerMatch } from '../owner-scope.js';
import type { Database, Queryable } from '../pool.js';

const num = (value: number | string | null): number => {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
};

interface PoolRow {
  owner_ref: string;
  workspace_id: string;
  category: CreditCategory;
  total: string;
  note: string;
  version: number;
  updated_at: Date;
}

interface AllocationRow {
  id: string;
  owner_ref: string;
  workspace_id: string;
  category: CreditCategory;
  target_kind: AllocationTargetKind;
  target_ref: string;
  allocation_limit: string | null;
  allocated: string;
  reserved: string;
  consumed: string;
  priority: number;
  policy: AllocationPolicyName;
  allowed_operations: string[];
  state: Allocation['state'];
  expires_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  seq: string | number;
  id: string;
  owner_ref: string;
  workspace_id: string;
  category: CreditCategory;
  allocation_id: string | null;
  target_kind: AllocationTargetKind | null;
  target_ref: string | null;
  kind: AllocationEvent['kind'];
  amount: string;
  allocated_after: string;
  consumed_after: string;
  reserved_after: string;
  operation_key: string | null;
  operation_kind: string | null;
  actor: string;
  reason: string;
  occurred_at: Date;
}

const POOL_COLUMNS = 'owner_ref, workspace_id, category, total, note, version, updated_at';
const ALLOCATION_COLUMNS = `id, owner_ref, workspace_id, category, target_kind, target_ref,
  allocation_limit, allocated, reserved, consumed, priority, policy, allowed_operations, state,
  expires_at, version, created_at, updated_at`;

const toPool = (row: PoolRow): WorkspacePool => ({
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  category: row.category,
  total: num(row.total),
  note: row.note,
  version: Number(row.version),
  updatedAt: new Date(row.updated_at).toISOString(),
});

const toAllocation = (row: AllocationRow): Allocation => ({
  id: row.id,
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  category: row.category,
  targetKind: row.target_kind,
  targetRef: row.target_ref,
  limit: row.allocation_limit === null ? null : num(row.allocation_limit),
  allocated: num(row.allocated),
  reserved: num(row.reserved),
  consumed: num(row.consumed),
  priority: Number(row.priority),
  policy: row.policy,
  allowedOperations: Array.isArray(row.allowed_operations) ? row.allowed_operations : [],
  state: row.state,
  expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
  version: Number(row.version),
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

const toEvent = (row: EventRow): AllocationEvent => ({
  seq: Number(row.seq),
  id: row.id,
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  category: row.category,
  allocationId: row.allocation_id,
  targetKind: row.target_kind,
  targetRef: row.target_ref,
  kind: row.kind,
  amount: num(row.amount),
  allocatedAfter: num(row.allocated_after),
  consumedAfter: num(row.consumed_after),
  reservedAfter: num(row.reserved_after),
  operationKey: row.operation_key,
  operationKind: row.operation_kind,
  actor: row.actor,
  reason: row.reason,
  occurredAt: new Date(row.occurred_at).toISOString(),
});

export class PostgresAllocationStore implements AllocationStore {
  constructor(private readonly database: Database) {}

  private async loadIn(
    tx: Queryable,
    ownerRef: string,
    workspaceId: string,
    category: CreditCategory,
    lock: boolean,
  ): Promise<AllocationState> {
    const pool = await tx.query<PoolRow>(
      `select ${POOL_COLUMNS} from workspace_credit_pools
        where owner_ref = $1 and workspace_id = $2 and category = $3${lock ? ' for update' : ''}`,
      [ownerRef, workspaceId, category],
    );
    const allocations = await tx.query<AllocationRow>(
      `select ${ALLOCATION_COLUMNS} from credit_allocations
        where owner_ref = $1 and workspace_id = $2 and category = $3
        order by created_at asc${lock ? ' for update' : ''}`,
      [ownerRef, workspaceId, category],
    );
    return {
      pool: pool.rows[0] === undefined ? null : toPool(pool.rows[0]),
      allocations: allocations.rows.map(toAllocation),
    };
  }

  async load(
    ownerRef: string,
    workspaceId: string,
    category: CreditCategory,
  ): Promise<AllocationState> {
    assertOwnerMatch(ownerRef);
    return this.database.withTransaction((tx) =>
      this.loadIn(tx, ownerRef, workspaceId, category, false),
    );
  }

  async apply(request: MovementRequest): Promise<MovementApplied> {
    assertOwnerMatch(request.ownerRef);
    return this.database.withTransaction(async (tx) => {
      // The pool is the unit of concurrency. One lock per workspace and category
      // means two movements serialise, and a movement against a workspace with
      // no pool row yet cannot race the one creating it.
      await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `allocation:${request.ownerRef}:${request.workspaceId}:${request.category}`,
      ]);

      const claim = await tx.query(
        `insert into credit_allocation_movements
           (owner_ref, idempotency_key, workspace_id, category, occurred_at)
         values ($1, $2, $3, $4, $5)
         on conflict (owner_ref, idempotency_key) do nothing
         returning owner_ref`,
        [
          request.ownerRef,
          request.idempotencyKey,
          request.workspaceId,
          request.category,
          request.occurredAt,
        ],
      );
      if (claim.rowCount === 0) {
        // This exact movement already ran. Report the current state as a replay
        // rather than applying it twice.
        const state = await this.loadIn(
          tx,
          request.ownerRef,
          request.workspaceId,
          request.category,
          false,
        );
        return {
          replayed: true,
          pool: state.pool,
          allocations: state.allocations,
          events: [],
        };
      }

      const state = await this.loadIn(
        tx,
        request.ownerRef,
        request.workspaceId,
        request.category,
        true,
      );

      const result = applyMovement(state, request.ops, {
        ownerRef: request.ownerRef,
        workspaceId: request.workspaceId,
        category: request.category,
        actor: request.actor,
        reason: request.reason,
        operationKey: request.operationKey,
        operationKind: request.operationKind,
        occurredAt: request.occurredAt,
        nextId: () => `ale_${claimId()}`,
      });

      if (result.pool !== null) {
        await tx.query(
          `insert into workspace_credit_pools (${POOL_COLUMNS})
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (owner_ref, workspace_id, category) do update
             set total = excluded.total,
                 note = excluded.note,
                 version = excluded.version,
                 updated_at = excluded.updated_at`,
          [
            result.pool.ownerRef,
            result.pool.workspaceId,
            result.pool.category,
            result.pool.total,
            result.pool.note,
            result.pool.version,
            result.pool.updatedAt,
          ],
        );
      }

      const before = new Map<string, Allocation>(
        state.allocations.map((allocation): [string, Allocation] => [allocation.id, allocation]),
      );
      for (const allocation of result.allocations) {
        const previous = before.get(allocation.id);
        if (previous === undefined) {
          await tx.query(
            `insert into credit_allocations (${ALLOCATION_COLUMNS})
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18)`,
            [
              allocation.id,
              allocation.ownerRef,
              allocation.workspaceId,
              allocation.category,
              allocation.targetKind,
              allocation.targetRef,
              allocation.limit,
              allocation.allocated,
              allocation.reserved,
              allocation.consumed,
              allocation.priority,
              allocation.policy,
              JSON.stringify(allocation.allowedOperations),
              allocation.state,
              allocation.expiresAt,
              allocation.version,
              allocation.createdAt,
              allocation.updatedAt,
            ],
          );
          continue;
        }
        if (previous.version === allocation.version) continue;
        const updated = await tx.query(
          `update credit_allocations
              set allocation_limit = $1, allocated = $2, reserved = $3, consumed = $4,
                  priority = $5, policy = $6, allowed_operations = $7::jsonb, state = $8,
                  expires_at = $9, version = $10, updated_at = $11
            where id = $12 and owner_ref = $13 and version = $14`,
          [
            allocation.limit,
            allocation.allocated,
            allocation.reserved,
            allocation.consumed,
            allocation.priority,
            allocation.policy,
            JSON.stringify(allocation.allowedOperations),
            allocation.state,
            allocation.expiresAt,
            allocation.version,
            allocation.updatedAt,
            allocation.id,
            request.ownerRef,
            previous.version,
          ],
        );
        if (updated.rowCount === 0) {
          throw new AllocationError(
            'VERSION_CONFLICT',
            'That allocation changed while this request was running. Try again.',
            409,
            { allocationId: allocation.id },
          );
        }
      }

      const events: AllocationEvent[] = [];
      for (const event of result.events) {
        const inserted = await tx.query<EventRow>(
          `insert into credit_allocation_events
             (id, owner_ref, workspace_id, category, allocation_id, target_kind, target_ref, kind,
              amount, allocated_after, consumed_after, reserved_after, operation_key,
              operation_kind, actor, reason, occurred_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           returning seq, id, owner_ref, workspace_id, category, allocation_id, target_kind,
                     target_ref, kind, amount, allocated_after, consumed_after, reserved_after,
                     operation_key, operation_kind, actor, reason, occurred_at`,
          [
            event.id,
            event.ownerRef,
            event.workspaceId,
            event.category,
            event.allocationId,
            event.targetKind,
            event.targetRef,
            event.kind,
            event.amount,
            event.allocatedAfter,
            event.consumedAfter,
            event.reservedAfter,
            event.operationKey,
            event.operationKind,
            event.actor,
            event.reason,
            event.occurredAt,
          ],
        );
        const row = inserted.rows[0];
        if (row !== undefined) events.push(toEvent(row));
      }

      return {
        replayed: false,
        pool: result.pool,
        allocations: result.allocations,
        events,
      };
    });
  }

  async get(allocationId: string): Promise<Allocation | null> {
    const rows = await this.database.query<AllocationRow>(
      `select ${ALLOCATION_COLUMNS} from credit_allocations where id = $1`,
      [allocationId],
    );
    return rows.rows[0] === undefined ? null : toAllocation(rows.rows[0]);
  }

  async list(query: AllocationQuery): Promise<readonly Allocation[]> {
    assertOwnerMatch(query.ownerRef);
    const values: unknown[] = [query.ownerRef];
    const where = ['owner_ref = $1'];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (query.workspaceId != null) add('workspace_id = ?', query.workspaceId);
    if (query.category != null) add('category = ?', query.category);
    if (query.targetKind != null) add('target_kind = ?', query.targetKind);
    if (query.targetRef != null) add('target_ref = ?', query.targetRef);
    if (query.state != null) add('state = ?', query.state);
    if (query.limit != null) {
      values.push(Math.max(1, Math.min(500, Math.trunc(query.limit))));
    }
    const limitSql = query.limit != null ? ` limit $${values.length}` : '';
    const rows = await this.database.query<AllocationRow>(
      `select ${ALLOCATION_COLUMNS} from credit_allocations
        where ${where.join(' and ')}
        order by priority desc, created_at asc${limitSql}`,
      values,
    );
    return rows.rows.map(toAllocation);
  }

  async history(query: AllocationHistoryQuery): Promise<readonly AllocationEvent[]> {
    assertOwnerMatch(query.ownerRef);
    const values: unknown[] = [query.ownerRef];
    const where = ['owner_ref = $1'];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (query.workspaceId != null) add('workspace_id = ?', query.workspaceId);
    if (query.category != null) add('category = ?', query.category);
    if (query.allocationId != null) add('allocation_id = ?', query.allocationId);
    values.push(Math.max(1, Math.min(500, Math.trunc(query.limit ?? 50))));
    const rows = await this.database.query<EventRow>(
      `select seq, id, owner_ref, workspace_id, category, allocation_id, target_kind, target_ref,
              kind, amount, allocated_after, consumed_after, reserved_after, operation_key,
              operation_kind, actor, reason, occurred_at
         from credit_allocation_events
        where ${where.join(' and ')}
        order by seq desc
        limit $${values.length}`,
      values,
    );
    return rows.rows.map(toEvent);
  }

  async policy(
    ownerRef: string,
    workspaceId: string,
    category: CreditCategory,
  ): Promise<AllocationPolicyConfig | null> {
    assertOwnerMatch(ownerRef);
    const rows = await this.database.query<{
      owner_ref: string;
      workspace_id: string;
      category: CreditCategory;
      default_policy: AllocationPolicyName;
      auto_limit: string;
      max_target_share_pct: number;
      updated_at: Date;
    }>(
      `select owner_ref, workspace_id, category, default_policy, auto_limit, max_target_share_pct, updated_at
         from allocation_policies
        where owner_ref = $1 and workspace_id = $2 and category = $3`,
      [ownerRef, workspaceId, category],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return {
      ownerRef: row.owner_ref,
      workspaceId: row.workspace_id,
      category: row.category,
      defaultPolicy: row.default_policy,
      autoLimit: num(row.auto_limit),
      maxTargetSharePct: Number(row.max_target_share_pct),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async savePolicy(config: AllocationPolicyConfig): Promise<AllocationPolicyConfig> {
    assertOwnerMatch(config.ownerRef);
    await this.database.query(
      `insert into allocation_policies
         (owner_ref, workspace_id, category, default_policy, auto_limit, max_target_share_pct, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (owner_ref, workspace_id, category) do update
         set default_policy = excluded.default_policy,
             auto_limit = excluded.auto_limit,
             max_target_share_pct = excluded.max_target_share_pct,
             updated_at = excluded.updated_at`,
      [
        config.ownerRef,
        config.workspaceId,
        config.category,
        config.defaultPolicy,
        config.autoLimit,
        config.maxTargetSharePct,
        config.updatedAt,
      ],
    );
    return config;
  }
}

/** A collision-resistant suffix for an event id, without pulling in uuid here. */
function claimId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
