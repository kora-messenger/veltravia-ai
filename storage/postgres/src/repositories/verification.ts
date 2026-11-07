/**
 * Verification runs over PostgreSQL (Step 45).
 *
 * Every statement is owner-scoped: `get` and `list` filter on the owner the
 * request runs under, and `save` is a compare-and-set on `version` so two
 * writers cannot silently overwrite one another. The evidence a Primary Agent
 * reviews therefore survives an API restart unchanged.
 */

import type {
  VerificationRunFilter,
  VerificationRunRecord,
  VerificationStore,
} from '@veltravia/verification-core';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

interface VerificationRow {
  id: string;
  owner_ref: string;
  record: unknown;
  version: number;
}

function toRecord(row: VerificationRow): VerificationRunRecord {
  const record = (row.record ?? {}) as VerificationRunRecord;
  return { ...record, version: row.version };
}

export class PostgresVerificationStore implements VerificationStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async save(record: VerificationRunRecord): Promise<void> {
    const owner = requireOwner();
    if (record.ownerRef !== owner) {
      throw Object.assign(new Error('The record belongs to another owner.'), {
        name: 'OWNER_SCOPE_MISMATCH',
        code: 'OWNER_SCOPE_MISMATCH',
      });
    }
    await this.query.query(
      `insert into verification_runs
         (id, owner_ref, project_id, task_id, worker_id, revision, status,
          attempt, repairs_run_id, record, started_at, finished_at, version, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       on conflict (id, owner_ref) do update
         set status = excluded.status,
             record = excluded.record,
             finished_at = excluded.finished_at,
             version = excluded.version,
             updated_at = now()
         where verification_runs.owner_ref = $2
           and verification_runs.version < excluded.version`,
      [
        record.id,
        owner,
        record.projectId,
        record.taskId,
        record.workerId,
        record.revision,
        record.status,
        record.attempt,
        record.repairsRunId,
        JSON.stringify({ ...record, version: record.version }),
        record.startedAt,
        record.finishedAt,
        record.version,
      ],
    );
  }

  async get(ownerRef: string, runId: string): Promise<VerificationRunRecord | null> {
    const owner = requireOwner();
    if (owner !== ownerRef) return null;
    const rows = await this.query.query<VerificationRow>(
      'select id, owner_ref, record, version from verification_runs where id = $1 and owner_ref = $2',
      [runId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    ownerRef: string,
    filter: VerificationRunFilter = {},
  ): Promise<readonly VerificationRunRecord[]> {
    const owner = requireOwner();
    if (owner !== ownerRef) return [];
    const clauses = ['owner_ref = $1'];
    const values: unknown[] = [owner];
    if (filter.projectId !== undefined) {
      values.push(filter.projectId);
      clauses.push(`project_id = $${values.length}`);
    }
    if (filter.taskId !== undefined) {
      values.push(filter.taskId);
      clauses.push(`task_id = $${values.length}`);
    }
    if (filter.workerId !== undefined) {
      values.push(filter.workerId);
      clauses.push(`worker_id = $${values.length}`);
    }
    if (filter.status !== undefined) {
      values.push(filter.status);
      clauses.push(`status = $${values.length}`);
    }
    values.push(Math.max(1, Math.min(filter.limit ?? 50, 200)));
    const rows = await this.query.query<VerificationRow>(
      `select id, owner_ref, record, version from verification_runs
        where ${clauses.join(' and ')}
        order by started_at desc
        limit $${values.length}`,
      values,
    );
    return rows.rows.map(toRecord);
  }
}
