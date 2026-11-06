/**
 * GitHub synchronisation state.
 *
 * What is persisted: the connection (repository, branch, token *reference* -
 * never the token), approved plans, and the history of applied commits with
 * their SHA and conflict report. Plans keep their expiry so a plan approved an
 * hour ago cannot be replayed against a repository that has since moved.
 */

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

export interface SyncConnectionRecord {
  readonly projectId: string;
  readonly payload: Record<string, unknown>;
  readonly updatedAt: string;
}

export interface SyncPlanRecord {
  readonly id: string;
  readonly projectId: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SyncHistoryRecord {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export class PostgresSyncStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async saveConnection(
    projectId: string,
    payload: Record<string, unknown>,
    updatedAt: string = new Date().toISOString(),
  ): Promise<SyncConnectionRecord> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown; updated_at: Date }>(
      `insert into sync_connections (project_id, owner_ref, payload, updated_at)
       values ($1, $2, $3, $4)
       on conflict (project_id) do update
         set payload = excluded.payload, updated_at = excluded.updated_at
         where sync_connections.owner_ref = $2
       returning payload, updated_at`,
      [projectId, owner, JSON.stringify(payload), updatedAt],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw Object.assign(new Error('The project is not available.'), {
        name: 'SYNC_PROJECT_UNAVAILABLE',
      });
    }
    return {
      projectId,
      payload: row.payload as Record<string, unknown>,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async getConnection(projectId: string): Promise<SyncConnectionRecord | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown; updated_at: Date }>(
      'select payload, updated_at from sync_connections where project_id = $1 and owner_ref = $2',
      [projectId, owner],
    );
    const row = rows.rows[0];
    return row === undefined
      ? null
      : {
          projectId,
          payload: row.payload as Record<string, unknown>,
          updatedAt: row.updated_at.toISOString(),
        };
  }

  async deleteConnection(projectId: string): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      'delete from sync_connections where project_id = $1 and owner_ref = $2',
      [projectId, owner],
    );
  }

  async savePlan(plan: SyncPlanRecord): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into sync_plans (id, project_id, owner_ref, payload, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update
         set payload = excluded.payload, expires_at = excluded.expires_at
         where sync_plans.owner_ref = $3`,
      [
        plan.id,
        plan.projectId,
        owner,
        JSON.stringify(plan.payload),
        plan.createdAt,
        plan.expiresAt,
      ],
    );
  }

  async getPlan(planId: string): Promise<SyncPlanRecord | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{
      id: string;
      project_id: string;
      payload: unknown;
      created_at: Date;
      expires_at: Date;
    }>(
      `select id, project_id, payload, created_at, expires_at from sync_plans
        where id = $1 and owner_ref = $2`,
      [planId, owner],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async listPlans(projectId: string, limit = 20): Promise<SyncPlanRecord[]> {
    const owner = requireOwner();
    const rows = await this.query.query<{
      id: string;
      project_id: string;
      payload: unknown;
      created_at: Date;
      expires_at: Date;
    }>(
      `select id, project_id, payload, created_at, expires_at from sync_plans
        where project_id = $1 and owner_ref = $2 and expires_at > now()
        order by created_at desc limit $3`,
      [projectId, owner, Math.min(limit, 100)],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    }));
  }

  async deleteExpiredPlans(now: Date = new Date()): Promise<number> {
    const owner = requireOwner();
    const rows = await this.query.query(
      'delete from sync_plans where owner_ref = $1 and expires_at < $2',
      [owner, now],
    );
    return rows.rowCount;
  }

  async appendHistory(record: SyncHistoryRecord): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into sync_history (id, project_id, owner_ref, status, payload, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        record.id,
        record.projectId,
        owner,
        record.status,
        JSON.stringify(record.payload),
        record.createdAt,
      ],
    );
  }

  /** Newest-first, bounded. `limit` is the caller's page size. */
  async listHistory(projectId: string, limit = 20): Promise<SyncHistoryRecord[]> {
    const owner = requireOwner();
    const rows = await this.query.query<{
      id: string;
      project_id: string;
      status: string;
      payload: unknown;
      created_at: Date;
    }>(
      `select id, project_id, status, payload, created_at from sync_history
        where project_id = $1 and owner_ref = $2
        order by created_at desc, id desc limit $3`,
      [projectId, owner, Math.min(limit, 200)],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.created_at.toISOString(),
    }));
  }

  /** Keeps the newest `keep` history rows per project. Returns rows removed. */
  async trimHistory(projectId: string, keep = 200): Promise<number> {
    const owner = requireOwner();
    const rows = await this.query.query(
      `delete from sync_history
        where project_id = $1 and owner_ref = $2
          and id not in (
            select id from sync_history
             where project_id = $1 and owner_ref = $2
             order by created_at desc, id desc limit $3
          )`,
      [projectId, owner, keep],
    );
    return rows.rowCount;
  }
}
