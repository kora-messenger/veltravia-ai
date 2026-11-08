/**
 * Executions in PostgreSQL.
 *
 * The row is the coordinator's own record: the request text, its status, the
 * plan and approval trail as JSON, and a version for compare-and-set. Ownership
 * comes from the async scope, never from the caller's arguments, so a query
 * here cannot address another owner's execution.
 */

import type { ExecutionFilter, ExecutionRecord, ExecutionStore } from '@veltravia/execution-core';

import { requireOwner } from '../owner-scope.js';
import type { Queryable } from '../pool.js';

interface ExecutionRow {
  id: string;
  record: unknown;
  version: number;
}

export class PostgresExecutionStore implements ExecutionStore {
  readonly kind = 'postgres' as const;

  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async insertExecution(record: ExecutionRecord): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into executions
         (id, owner_ref, project_id, status, request_text, record, created_at, updated_at, version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        owner,
        record.projectId,
        record.status,
        record.request.text,
        JSON.stringify(record),
        record.startedAt,
        record.updatedAt,
        record.version,
      ],
    );
  }

  async saveExecution(record: ExecutionRecord, expectedVersion: number): Promise<boolean> {
    const owner = requireOwner();
    const rows = await this.query.query<{ id: string }>(
      `update executions
          set status = $3,
              record = $4,
              updated_at = $5,
              version = $6
        where id = $1 and owner_ref = $2 and version = $7
        returning id`,
      [
        record.id,
        owner,
        record.status,
        JSON.stringify(record),
        record.updatedAt,
        record.version,
        expectedVersion,
      ],
    );
    return rows.rows.length > 0;
  }

  async getExecution(ownerRef: string, executionId: string): Promise<ExecutionRecord | null> {
    const owner = requireOwner();
    void ownerRef;
    const rows = await this.query.query<ExecutionRow>(
      `select id, record, version from executions where id = $1 and owner_ref = $2`,
      [executionId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.record as ExecutionRecord);
  }

  async listExecutions(
    ownerRef: string,
    filter: ExecutionFilter,
  ): Promise<readonly ExecutionRecord[]> {
    const owner = requireOwner();
    void ownerRef;
    const statuses = filter.status === undefined ? null : [...filter.status];
    const rows = await this.query.query<ExecutionRow>(
      `select id, record, version
         from executions
        where owner_ref = $1
          and ($2::text is null or project_id = $2)
          and ($3::text[] is null or status = any($3))
          and ($4::boolean is not true or status not in ('completed', 'cancelled', 'failed'))
        order by created_at desc
        limit $5`,
      [
        owner,
        filter.projectId ?? null,
        statuses,
        filter.openOnly === true,
        Math.min(Math.max(filter.limit ?? 50, 1), 200),
      ],
    );
    return rows.rows.map((row) => row.record as ExecutionRecord);
  }
}
