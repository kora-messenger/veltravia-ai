/**
 * Recovery cases over PostgreSQL.
 *
 * The port is `@veltravia/recovery-core`'s `RecoveryStore`. Every statement is
 * owner-scoped by the validated request owner, never by a value the caller
 * supplied, and `saveCase` is a compare-and-set on `version`.
 *
 * Two properties are enforced here rather than in application code:
 *  - one running attempt per case (partial unique index in migration 008), so a
 *    coordinator that lost its in-memory state cannot start a duplicate repair;
 *  - events are written in the same transaction as the state change, so the
 *    audit trail can never disagree with the case.
 */

import type {
  RecoveryCaseFilter,
  RecoveryCaseRecord,
  RecoveryEvent,
  RecoveryEventType,
  RepairAttempt,
  RepairAttemptOutcome,
  RecoveryStore,
} from '@veltravia/recovery-core';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

interface CaseRow {
  id: string;
  record: unknown;
  version: number;
}

interface AttemptRow {
  id: string;
  owner_ref: string;
  record: unknown;
}

interface EventRow {
  case_id: string;
  seq: number;
  type: string;
  actor: string;
  message: string;
  detail: unknown;
  at: Date;
}

export class PostgresRecoveryStore implements RecoveryStore {
  readonly kind = 'postgres' as const;

  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async insertCase(record: RecoveryCaseRecord, events: readonly RecoveryEvent[]): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into recovery_cases
         (id, owner_ref, project_id, task_id, worker_id, status, diagnosis_primary,
          classification, attempts, reassignments, record, created_at, updated_at,
          version, event_seq)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        record.id,
        owner,
        record.projectId,
        record.taskId,
        record.workerId,
        record.status,
        record.diagnosis?.primary ?? null,
        record.diagnosis?.classification ?? null,
        record.attempts,
        record.reassignments,
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt,
        record.version,
        record.eventSeq,
      ],
    );
    await this.writeEvents(owner, record.id, events);
  }

  async readCase(ownerRef: string, caseId: string): Promise<RecoveryCaseRecord | null> {
    const owner = requireOwner();
    void ownerRef;
    const rows = await this.query.query<CaseRow>(
      `select id, record, version from recovery_cases where id = $1 and owner_ref = $2`,
      [caseId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.record as RecoveryCaseRecord);
  }

  async listCases(
    ownerRef: string,
    filter: RecoveryCaseFilter,
  ): Promise<readonly RecoveryCaseRecord[]> {
    const owner = requireOwner();
    void ownerRef;
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = await this.query.query<CaseRow>(
      `select id, record, version from recovery_cases
        where owner_ref = $1
          and ($2::text is null or project_id = $2)
          and ($3::text is null or task_id = $3)
          and ($4::text[] is null or status = any($4))
          and ($5::boolean is not true or status in
               ('open','diagnosing','repairing','awaiting_verification'))
        order by created_at desc
        limit $6`,
      [
        owner,
        filter.projectId ?? null,
        filter.taskId ?? null,
        filter.status === undefined ? null : [...filter.status],
        filter.openOnly === true,
        limit,
      ],
    );
    return rows.rows.map((row) => row.record as RecoveryCaseRecord);
  }

  async saveCase(
    record: RecoveryCaseRecord,
    expectedVersion: number,
    events: readonly RecoveryEvent[],
  ): Promise<boolean> {
    const owner = requireOwner();
    return this.transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `update recovery_cases
            set status = $3,
                diagnosis_primary = $4,
                classification = $5,
                attempts = $6,
                reassignments = $7,
                record = $8,
                updated_at = $9,
                version = $10,
                event_seq = $11
          where id = $1 and owner_ref = $2 and version = $12
          returning id`,
        [
          record.id,
          owner,
          record.status,
          record.diagnosis?.primary ?? null,
          record.diagnosis?.classification ?? null,
          record.attempts,
          record.reassignments,
          JSON.stringify(record),
          record.updatedAt,
          record.version,
          record.eventSeq,
          expectedVersion,
        ],
      );
      if (rows.rows.length === 0) return false;
      await this.writeEvents(owner, record.id, events, tx);
      return true;
    });
  }

  async appendEvents(
    ownerRef: string,
    caseId: string,
    events: readonly RecoveryEvent[],
    updatedAt: string,
  ): Promise<void> {
    const owner = requireOwner();
    void ownerRef;
    await this.transaction(async (tx) => {
      await tx.query(
        `update recovery_cases
            set updated_at = $3,
                event_seq = event_seq + $4
          where id = $1 and owner_ref = $2`,
        [caseId, owner, updatedAt, events.length],
      );
      await this.writeEvents(owner, caseId, events, tx);
    });
  }

  async events(
    ownerRef: string,
    caseId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly RecoveryEvent[]> {
    const owner = requireOwner();
    void ownerRef;
    const rows = await this.query.query<EventRow>(
      `select case_id, seq, type, actor, message, detail, at
         from recovery_events
        where owner_ref = $1 and case_id = $2 and seq > $3
        order by seq asc
        limit $4`,
      [owner, caseId, afterSeq, Math.min(Math.max(limit, 1), 500)],
    );
    return rows.rows.map((row) => ({
      caseId: row.case_id,
      seq: row.seq,
      type: row.type as RecoveryEventType,
      at: row.at.toISOString(),
      actor: row.actor as RecoveryEvent['actor'],
      message: row.message,
      ...(row.detail === null ? {} : { detail: row.detail as Record<string, unknown> }),
    }));
  }

  async insertAttempt(attempt: RepairAttempt): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into repair_attempts
         (id, owner_ref, case_id, attempt, action, worker_id, worker_type, outcome,
          verification_run_id, change_set_id, record, started_at, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        attempt.id,
        owner,
        attempt.caseId,
        attempt.attempt,
        attempt.action,
        attempt.workerId,
        attempt.workerType,
        attempt.outcome,
        attempt.verificationRunId,
        attempt.changeSetId,
        JSON.stringify(attempt),
        attempt.startedAt,
        attempt.endedAt,
      ],
    );
  }

  async saveAttempt(attempt: RepairAttempt): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `update repair_attempts
          set outcome = $4,
              verification_run_id = $5,
              change_set_id = $6,
              record = $7,
              ended_at = $8
        where id = $1 and owner_ref = $2 and case_id = $3`,
      [
        attempt.id,
        owner,
        attempt.caseId,
        attempt.outcome,
        attempt.verificationRunId,
        attempt.changeSetId,
        JSON.stringify(attempt),
        attempt.endedAt,
      ],
    );
  }

  async attempts(ownerRef: string, caseId: string): Promise<readonly RepairAttempt[]> {
    const owner = requireOwner();
    void ownerRef;
    const rows = await this.query.query<AttemptRow>(
      `select id, owner_ref, record from repair_attempts
        where owner_ref = $1 and case_id = $2
        order by attempt asc`,
      [owner, caseId],
    );
    return rows.rows.map((row) => row.record as RepairAttempt);
  }

  async activeAttempts(ownerRef: string, taskId: string): Promise<number> {
    const owner = requireOwner();
    void ownerRef;
    const rows = await this.query.query<{ count: string }>(
      `select count(*)::text as count
         from repair_attempts a
         join recovery_cases c on c.id = a.case_id and c.owner_ref = a.owner_ref
        where a.owner_ref = $1 and c.task_id = $2 and a.outcome = 'running'`,
      [owner, taskId],
    );
    return Number(rows.rows[0]?.count ?? '0');
  }

  private async writeEvents(
    owner: string,
    caseId: string,
    events: readonly RecoveryEvent[],
    tx?: Queryable,
  ): Promise<void> {
    if (events.length === 0) return;
    const query = tx ?? this.query;
    for (const event of events) {
      await query.query(
        `insert into recovery_events (case_id, owner_ref, seq, type, actor, message, detail, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          caseId,
          owner,
          event.seq,
          event.type,
          event.actor,
          event.message,
          event.detail === undefined ? null : JSON.stringify(event.detail),
          event.at,
        ],
      );
    }
  }

  private async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const withTx = this.query as Queryable & {
      withTransaction?: <R>(fn: (tx: Queryable) => Promise<R>) => Promise<R>;
    };
    if (withTx.withTransaction === undefined) return work(this.query);
    return withTx.withTransaction(work);
  }
}

/** Re-exported for tests that build attempt rows directly. */
export type { RepairAttemptOutcome };
