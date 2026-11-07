/**
 * Superagent worker records over PostgreSQL.
 *
 * Same rules as the task repository: every statement filters on the owner the
 * request is scoped to, `save` is a compare-and-set on `version`, and history is
 * appended in the same transaction as the state it describes.
 *
 * The one rule that belongs to the database rather than to code is the partial
 * unique index `workers_one_live_per_task`: two schedulers racing for the same
 * task cannot both hold a live worker, whatever the application does.
 */

import type {
  SchedulingDecision,
  WorkerAssignment,
  WorkerEvent,
  WorkerEventType,
  WorkerRecord,
  WorkerResult,
  WorkerReview,
  WorkerStatus,
  WorkerStore,
  WorkerFilter,
  WorkerFailure,
  ResourceClaim,
} from '@veltravia/worker-core';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

interface WorkerRow {
  id: string;
  owner_ref: string;
  task_id: string;
  parent_task_id: string | null;
  primary_run_id: string | null;
  worker_type: string;
  status: string;
  assignment: unknown;
  result: unknown;
  review: unknown;
  failure: unknown;
  claims: unknown;
  attempts: number;
  retry_not_before: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  last_heartbeat_at: Date | null;
  version: number;
  event_seq: number;
  created_at: Date;
  updated_at: Date;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toWorker(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    taskId: row.task_id,
    parentTaskId: row.parent_task_id,
    primaryRunId: row.primary_run_id,
    workerType: row.worker_type as WorkerRecord['workerType'],
    status: row.status as WorkerStatus,
    // worker_type is validated on the way in, so the union is safe here.
    assignment: row.assignment as WorkerAssignment,
    result: (row.result ?? null) as WorkerResult | null,
    review: (row.review ?? null) as WorkerReview | null,
    failure: (row.failure ?? null) as WorkerFailure | null,
    resources: (row.claims ?? []) as readonly ResourceClaim[],
    attempts: row.attempts,
    retryNotBefore: iso(row.retry_not_before),
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    version: row.version,
    eventSeq: row.event_seq,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresWorkerStore implements WorkerStore {
  readonly kind = 'postgres' as const;

  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async insert(worker: WorkerRecord, events: readonly WorkerEvent[]): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into workers
         (id, owner_ref, task_id, parent_task_id, primary_run_id, worker_type, status,
          assignment, result, review, failure, claims, attempts, retry_not_before,
          started_at, ended_at, last_heartbeat_at, version, event_seq, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20, $21)`,
      [
        worker.id,
        owner,
        worker.taskId,
        worker.parentTaskId,
        worker.primaryRunId,
        worker.workerType,
        worker.status,
        JSON.stringify(worker.assignment),
        worker.result === null ? null : JSON.stringify(worker.result),
        worker.review === null ? null : JSON.stringify(worker.review),
        worker.failure === null ? null : JSON.stringify(worker.failure),
        JSON.stringify(worker.resources),
        worker.attempts,
        worker.retryNotBefore,
        worker.startedAt,
        worker.endedAt,
        worker.lastHeartbeatAt,
        worker.version,
        worker.eventSeq,
        worker.createdAt,
        worker.updatedAt,
      ],
    );
    await this.writeEvents(worker, events);
  }

  async read(ownerRef: string, workerId: string): Promise<WorkerRecord | null> {
    const owner = requireOwner();
    const rows = await this.query.query<WorkerRow>(
      `select * from workers where id = $1 and owner_ref = $2`,
      [workerId, owner],
    );
    const row = rows.rows[0];
    void ownerRef;
    return row === undefined ? null : toWorker(row);
  }

  async list(ownerRef: string, filter: WorkerFilter = {}): Promise<readonly WorkerRecord[]> {
    const owner = requireOwner();
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = await this.query.query<WorkerRow>(
      `select * from workers
        where owner_ref = $1
          and ($2::text is null or task_id = $2)
          and ($3::text[] is null or status = any($3))
          and ($4::boolean is not true or status in
               ('queued','assigned','starting','running','blocked','awaiting_review'))
        order by created_at desc
        limit $5`,
      [
        owner,
        filter.taskId ?? null,
        filter.status === undefined ? null : [...filter.status],
        filter.activeOnly === true,
        limit,
      ],
    );
    void ownerRef;
    return rows.rows.map(toWorker);
  }

  async save(
    worker: WorkerRecord,
    expectedVersion: number,
    events: readonly WorkerEvent[],
  ): Promise<boolean> {
    const owner = requireOwner();
    const rows = await this.query.query<{ id: string }>(
      `update workers
          set status = $3,
              result = $4,
              review = $5,
              failure = $6,
              claims = $7,
              attempts = $8,
              retry_not_before = $9,
              started_at = $10,
              ended_at = $11,
              last_heartbeat_at = $12,
              version = $13,
              event_seq = $14,
              updated_at = $15
        where id = $1 and owner_ref = $2 and version = $16
        returning id`,
      [
        worker.id,
        owner,
        worker.status,
        worker.result === null ? null : JSON.stringify(worker.result),
        worker.review === null ? null : JSON.stringify(worker.review),
        worker.failure === null ? null : JSON.stringify(worker.failure),
        JSON.stringify(worker.resources),
        worker.attempts,
        worker.retryNotBefore,
        worker.startedAt,
        worker.endedAt,
        worker.lastHeartbeatAt,
        worker.version,
        worker.eventSeq,
        worker.updatedAt,
        expectedVersion,
      ],
    );
    if (rows.rows[0] === undefined) return false;
    await this.writeEvents(worker, events);
    return true;
  }

  async appendEvents(
    ownerRef: string,
    workerId: string,
    events: readonly WorkerEvent[],
    updatedAt: string,
  ): Promise<void> {
    const owner = requireOwner();
    if (events.length === 0) return;
    await this.query.query(
      `update workers
          set updated_at = $3, last_heartbeat_at = $3
        where id = $1 and owner_ref = $2`,
      [workerId, owner, updatedAt],
    );
    await this.writeEvents({ id: workerId } as WorkerRecord, events);
    void ownerRef;
  }

  async events(
    ownerRef: string,
    workerId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly WorkerEvent[]> {
    const owner = requireOwner();
    const rows = await this.query.query<{
      worker_id: string;
      seq: number;
      type: string;
      actor: string;
      to_status: string | null;
      message: string | null;
      detail: unknown;
      at: Date;
    }>(
      `select * from worker_events
        where worker_id = $1 and owner_ref = $2 and seq > $3
        order by seq asc
        limit $4`,
      [workerId, owner, Math.max(0, afterSeq), Math.min(Math.max(limit, 1), 200)],
    );
    void ownerRef;
    return rows.rows.map((row) => ({
      workerId: row.worker_id,
      seq: row.seq,
      type: row.type as WorkerEventType,
      actor: row.actor as WorkerEvent['actor'],
      fromStatus: null,
      toStatus: row.to_status as WorkerStatus | null,
      message: row.message,
      detail: (row.detail ?? null) as Record<string, unknown>,
      at: row.at.toISOString(),
    }));
  }

  async recordDecision(decision: SchedulingDecision): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into scheduling_decisions
         (id, owner_ref, kind, concurrency_limit, active_count, selected, skipped, created_at)
       values ($1, $2, 'plan', $3, $4, $5, $6, $7)`,
      [
        decision.id,
        owner,
        decision.limit,
        decision.active,
        JSON.stringify(decision.selected),
        JSON.stringify(decision.skipped),
        decision.at,
      ],
    );
  }

  async decisions(ownerRef: string, limit: number): Promise<readonly SchedulingDecision[]> {
    const owner = requireOwner();
    const rows = await this.query.query<{
      id: string;
      kind: string;
      concurrency_limit: number;
      active_count: number;
      selected: unknown;
      skipped: unknown;
      created_at: Date;
    }>(
      `select * from scheduling_decisions
        where owner_ref = $1
        order by created_at desc
        limit $2`,
      [owner, Math.min(Math.max(limit, 1), 100)],
    );
    void ownerRef;
    return rows.rows.map((row) => ({
      id: row.id,
      ownerRef: owner,
      at: row.created_at.toISOString(),
      limit: row.concurrency_limit,
      active: row.active_count,
      selected: (row.selected ?? []) as SchedulingDecision['selected'],
      skipped: (row.skipped ?? []) as SchedulingDecision['skipped'],
    }));
  }

  private async writeEvents(
    worker: Pick<WorkerRecord, 'id'>,
    events: readonly WorkerEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const owner = requireOwner();
    for (const event of events) {
      await this.query.query(
        `insert into worker_events
           (worker_id, owner_ref, seq, type, actor, from_status, to_status, message, detail, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          worker.id,
          owner,
          event.seq,
          event.type,
          event.actor,
          event.fromStatus,
          event.toStatus,
          event.message,
          event.detail === undefined ? null : JSON.stringify(event.detail),
          event.at,
        ],
      );
    }
  }
}
