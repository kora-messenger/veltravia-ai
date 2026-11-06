/**
 * Run and audit records.
 *
 * Agent runs, coding-agent runs, application-testing runs and reasoning runs all
 * produce the same thing from a storage point of view: an owner-scoped record
 * with a status, timestamps and a body whose fields are still evolving. They
 * share one table and one repository, keyed by `kind`, instead of four
 * near-identical stores. Bodies are validated and scrubbed by the services that
 * own them; nothing here stores chain-of-thought or provider credentials.
 */

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

export type RunRecordBody = Record<string, unknown>;

export interface RunRecord {
  readonly kind: string;
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: RunRecordBody;
}

export interface SaveRunRecordInput {
  readonly kind: string;
  readonly id: string;
  readonly projectId?: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: RunRecordBody;
}

export interface ListRunRecordsQuery {
  readonly projectId?: string;
  readonly status?: string;
  readonly limit?: number;
}

interface RunRow {
  kind: string;
  id: string;
  owner_ref: string;
  project_id: string | null;
  status: string;
  payload: unknown;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: RunRow): RunRecord {
  return {
    kind: row.kind,
    id: row.id,
    ownerRef: row.owner_ref,
    projectId: row.project_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    body: (row.payload ?? {}) as RunRecordBody,
  };
}

export class PostgresRunRecordStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  /** Inserts or replaces one record for the calling owner. */
  async save(input: SaveRunRecordInput): Promise<RunRecord> {
    const owner = requireOwner();
    const rows = await this.query.query<RunRow>(
      `insert into run_records
         (kind, id, owner_ref, project_id, status, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (kind, id) do update
         set status = excluded.status,
             project_id = excluded.project_id,
             payload = excluded.payload,
             updated_at = excluded.updated_at
         where run_records.owner_ref = $3
       returning *`,
      [
        input.kind,
        input.id,
        owner,
        input.projectId ?? null,
        input.status,
        JSON.stringify(input.body),
        input.createdAt,
        input.updatedAt,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      // The record exists under a different owner; it is not readable or
      // writable from here, and the caller learns nothing about it.
      throw Object.assign(new Error('No run record found for the calling owner.'), {
        name: 'RUN_NOT_FOUND',
        code: 'RUN_NOT_FOUND',
      });
    }
    return toRecord(row);
  }

  async get(kind: string, id: string): Promise<RunRecord | null> {
    const owner = requireOwner();
    const rows = await this.query.query<RunRow>(
      'select * from run_records where kind = $1 and id = $2 and owner_ref = $3',
      [kind, id, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(kind: string, options: ListRunRecordsQuery = {}): Promise<RunRecord[]> {
    const owner = requireOwner();
    const values: unknown[] = [kind, owner];
    const conditions = ['kind = $1', 'owner_ref = $2'];
    if (options.projectId !== undefined) {
      values.push(options.projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (options.status !== undefined) {
      values.push(options.status);
      conditions.push(`status = $${values.length}`);
    }
    values.push(Math.min(options.limit ?? 50, 200));
    const rows = await this.query.query<RunRow>(
      `select * from run_records where ${conditions.join(' and ')}
        order by created_at desc, id desc limit $${values.length}`,
      values,
    );
    return rows.rows.map(toRecord);
  }
}
