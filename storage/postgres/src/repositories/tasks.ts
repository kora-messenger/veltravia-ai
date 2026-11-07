/**
 * Task orchestration records over PostgreSQL.
 *
 * Every write runs inside `runWithOwner`, and every statement filters on the
 * owner the request is scoped to: a query written without an owner predicate
 * cannot run. A status change, its events and (when applicable) its attempt row
 * are written in ONE transaction, so a task is never left in a state its
 * history disagrees with.
 *
 * `save` is a compare-and-set on `version`. Two callers editing one task both
 * think they hold the truth; the database decides which one is right.
 */

import type { TaskStore } from '@veltravia/orchestration-core';
import type {
  StoredTask,
  TaskAttempt,
  TaskEvent,
  TaskEventType,
  TaskFilter,
  TaskRecord,
  TaskStatus,
  TaskEventType as EventType,
} from '@veltravia/orchestration-core';

import { requireOwner } from '../owner-scope.js';
import type { Database, Queryable } from '../pool.js';

interface TaskRow {
  id: string;
  owner_ref: string;
  project_id: string | null;
  workspace_id: string | null;
  chat_id: string | null;
  parent_task_id: string | null;
  title: string;
  objective: string;
  status: TaskStatus;
  review_status: 'pending' | 'accepted' | 'rejected' | null;
  assignment: unknown;
  result: unknown;
  failure: unknown;
  retry: unknown;
  checkpoint: unknown;
  created_by: 'primary_agent' | 'owner';
  version: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

interface EventRow {
  task_id: string;
  seq: number;
  type: EventType;
  actor: TaskEvent['actor'];
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  message: string | null;
  detail: unknown;
  at: Date;
}

interface AttemptRow {
  task_id: string;
  attempt: number;
  run_id: string | null;
  worker: string;
  status: TaskAttempt['status'];
  started_at: Date;
  ended_at: Date | null;
  summary: string | null;
  failure: unknown;
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    chatId: row.chat_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    reviewStatus: row.review_status,
    assignment: (row.assignment ?? null) as TaskRecord['assignment'],
    result: (row.result ?? null) as TaskRecord['result'],
    failure: (row.failure ?? null) as TaskRecord['failure'],
    retry: (row.retry ?? {
      attempts: 0,
      maxAttempts: 3,
      lastFailure: null,
      lastRetriedAt: null,
    }) as TaskRecord['retry'],
    checkpoint: (row.checkpoint ?? null) as TaskRecord['checkpoint'],
    createdBy: row.created_by,
    version: row.version,
    eventSeq: 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
  };
}

function toEvent(row: EventRow): TaskEvent {
  return {
    taskId: row.task_id,
    seq: row.seq,
    type: row.type,
    actor: row.actor,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    message: row.message,
    detail: (row.detail ?? null) as Record<string, unknown> | null,
    at: row.at.toISOString(),
  };
}

function toAttempt(row: AttemptRow): TaskAttempt {
  return {
    taskId: row.task_id,
    attempt: row.attempt,
    runId: row.run_id,
    worker: row.worker,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at === null ? null : row.ended_at.toISOString(),
    summary: row.summary,
    failure: (row.failure ?? null) as TaskAttempt['failure'],
  };
}

export class PostgresTaskStore implements TaskStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly database: Database) {}

  private async writeEvents(
    tx: Queryable,
    owner: string,
    taskId: string,
    events: readonly TaskEvent[],
  ): Promise<void> {
    for (const event of events) {
      await tx.query(
        `insert into task_events
           (task_id, owner_ref, seq, type, actor, from_status, to_status, message, detail, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          taskId,
          owner,
          event.seq,
          event.type satisfies TaskEventType,
          event.actor,
          event.fromStatus,
          event.toStatus,
          event.message,
          event.detail === null ? null : JSON.stringify(event.detail),
          event.at,
        ],
      );
    }
  }

  async insert(input: {
    readonly task: TaskRecord;
    readonly dependencies: readonly string[];
    readonly events: readonly TaskEvent[];
  }): Promise<void> {
    const owner = requireOwner();
    if (input.task.ownerRef !== owner) {
      throw new Error('A task cannot be written for another owner.');
    }
    await this.database.withTransaction(async (tx) => {
      await tx.query(
        `insert into tasks
           (id, owner_ref, project_id, workspace_id, chat_id, parent_task_id, title, objective,
            status, review_status, assignment, result, failure, retry, checkpoint, created_by,
            version, created_at, updated_at, completed_at, cancelled_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          input.task.id,
          owner,
          input.task.projectId,
          input.task.workspaceId,
          input.task.chatId,
          input.task.parentTaskId,
          input.task.title,
          input.task.objective,
          input.task.status,
          input.task.reviewStatus,
          input.task.assignment === null ? null : JSON.stringify(input.task.assignment),
          input.task.result === null ? null : JSON.stringify(input.task.result),
          input.task.failure === null ? null : JSON.stringify(input.task.failure),
          JSON.stringify(input.task.retry),
          input.task.checkpoint === null ? null : JSON.stringify(input.task.checkpoint),
          input.task.createdBy,
          input.task.version,
          input.task.createdAt,
          input.task.updatedAt,
          input.task.completedAt,
          input.task.cancelledAt,
        ],
      );
      for (const dependsOnTaskId of input.dependencies) {
        await tx.query(
          `insert into task_dependencies (task_id, owner_ref, depends_on_task_id, required, created_at)
           values ($1, $2, $3, true, $4)`,
          [input.task.id, owner, dependsOnTaskId, input.task.createdAt],
        );
      }
      await this.writeEvents(tx, owner, input.task.id, input.events);
    });
  }

  async read(ownerRef: string, taskId: string): Promise<StoredTask | null> {
    const owner = requireOwner();
    if (owner !== ownerRef) return null;
    const rows = await this.database.query<TaskRow>(
      'select * from tasks where id = $1 and owner_ref = $2',
      [taskId, owner],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    const dependencies = await this.database.query<{ depends_on_task_id: string }>(
      `select depends_on_task_id from task_dependencies
        where task_id = $1 and owner_ref = $2 order by created_at asc`,
      [taskId, owner],
    );
    const seq = await this.database.query<{ max: number | null }>(
      'select max(seq) as max from task_events where task_id = $1 and owner_ref = $2',
      [taskId, owner],
    );
    const record = toRecord(row);
    return {
      task: { ...record, eventSeq: seq.rows[0]?.max ?? 0 },
      dependencies: dependencies.rows.map((entry) => entry.depends_on_task_id),
    };
  }

  async list(ownerRef: string, filter: TaskFilter): Promise<StoredTask[]> {
    const owner = requireOwner();
    if (owner !== ownerRef) return [];
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = await this.database.query<TaskRow>(
      `select * from tasks
        where owner_ref = $1
          and ($2::text is null or project_id = $2)
          and ($3::text is null or chat_id = $3)
          and ($4::text is null or status = $4)
          and ($5::text is null or parent_task_id = $5)
        order by created_at desc
        limit $6`,
      [
        owner,
        filter.projectId ?? null,
        filter.chatId ?? null,
        filter.status ?? null,
        filter.parentTaskId ?? null,
        limit,
      ],
    );
    if (rows.rows.length === 0) return [];
    const ids = rows.rows.map((row) => row.id);
    const dependencies = await this.database.query<{
      task_id: string;
      depends_on_task_id: string;
    }>(
      `select task_id, depends_on_task_id from task_dependencies
        where owner_ref = $1 and task_id = any($2::text[])`,
      [owner, ids],
    );
    const dependencyMap = new Map<string, string[]>();
    for (const entry of dependencies.rows) {
      dependencyMap.set(entry.task_id, [
        ...(dependencyMap.get(entry.task_id) ?? []),
        entry.depends_on_task_id,
      ]);
    }
    const seqs = await this.database.query<{ task_id: string; max: number | null }>(
      `select task_id, max(seq) as max from task_events
        where owner_ref = $1 and task_id = any($2::text[]) group by task_id`,
      [owner, ids],
    );
    const seqMap = new Map<string, number>();
    for (const entry of seqs.rows) seqMap.set(entry.task_id, entry.max ?? 0);

    return rows.rows.map((row) => {
      const record = toRecord(row);
      return {
        task: { ...record, eventSeq: seqMap.get(row.id) ?? 0 },
        dependencies: dependencyMap.get(row.id) ?? [],
      };
    });
  }

  async save(input: {
    readonly task: TaskRecord;
    readonly expectedVersion: number;
    readonly events: readonly TaskEvent[];
  }): Promise<boolean> {
    const owner = requireOwner();
    if (input.task.ownerRef !== owner) return false;
    return this.database.withTransaction(async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `update tasks set
           project_id = $3,
           workspace_id = $4,
           chat_id = $5,
           parent_task_id = $6,
           title = $7,
           objective = $8,
           status = $9,
           review_status = $10,
           assignment = $11,
           result = $12,
           failure = $13,
           retry = $14,
           checkpoint = $15,
           version = $16,
           updated_at = $17,
           completed_at = $18,
           cancelled_at = $19
         where id = $1 and owner_ref = $2 and version = $20
         returning id`,
        [
          input.task.id,
          owner,
          input.task.projectId,
          input.task.workspaceId,
          input.task.chatId,
          input.task.parentTaskId,
          input.task.title,
          input.task.objective,
          input.task.status,
          input.task.reviewStatus,
          input.task.assignment === null ? null : JSON.stringify(input.task.assignment),
          input.task.result === null ? null : JSON.stringify(input.task.result),
          input.task.failure === null ? null : JSON.stringify(input.task.failure),
          JSON.stringify(input.task.retry),
          input.task.checkpoint === null ? null : JSON.stringify(input.task.checkpoint),
          input.task.version,
          input.task.updatedAt,
          input.task.completedAt,
          input.task.cancelledAt,
          input.expectedVersion,
        ],
      );
      if (updated.rows.length === 0) return false;
      await this.writeEvents(tx, owner, input.task.id, input.events);
      return true;
    });
  }

  async appendEvents(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void> {
    const owner = requireOwner();
    if (input.ownerRef !== owner) throw new Error('A task cannot be written for another owner.');
    await this.database.withTransaction(async (tx) => {
      await this.writeEvents(tx, owner, input.taskId, input.events);
      await tx.query('update tasks set updated_at = $3 where id = $1 and owner_ref = $2', [
        input.taskId,
        owner,
        input.updatedAt,
      ]);
    });
  }

  async addDependency(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly dependsOnTaskId: string;
    readonly required: boolean;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void> {
    const owner = requireOwner();
    if (input.ownerRef !== owner) throw new Error('A task cannot be written for another owner.');
    await this.database.withTransaction(async (tx) => {
      await tx.query(
        `insert into task_dependencies (task_id, owner_ref, depends_on_task_id, required, created_at)
         values ($1, $2, $3, $4, $5)
         on conflict (task_id, owner_ref, depends_on_task_id) do nothing`,
        [input.taskId, owner, input.dependsOnTaskId, input.required, input.updatedAt],
      );
      await this.writeEvents(tx, owner, input.taskId, input.events);
      await tx.query('update tasks set updated_at = $3 where id = $1 and owner_ref = $2', [
        input.taskId,
        owner,
        input.updatedAt,
      ]);
    });
  }

  async removeDependency(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly dependsOnTaskId: string;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void> {
    const owner = requireOwner();
    if (input.ownerRef !== owner) throw new Error('A task cannot be written for another owner.');
    await this.database.withTransaction(async (tx) => {
      await tx.query(
        `delete from task_dependencies
          where task_id = $1 and owner_ref = $2 and depends_on_task_id = $3`,
        [input.taskId, owner, input.dependsOnTaskId],
      );
      await this.writeEvents(tx, owner, input.taskId, input.events);
      await tx.query('update tasks set updated_at = $3 where id = $1 and owner_ref = $2', [
        input.taskId,
        owner,
        input.updatedAt,
      ]);
    });
  }

  async events(
    ownerRef: string,
    taskId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly TaskEvent[]> {
    const owner = requireOwner();
    if (owner !== ownerRef) return [];
    const rows = await this.database.query<EventRow>(
      `select task_id, seq, type, actor, from_status, to_status, message, detail, at
         from task_events
        where task_id = $1 and owner_ref = $2 and seq > $3
        order by seq asc limit $4`,
      [taskId, owner, afterSeq, limit],
    );
    return rows.rows.map(toEvent);
  }

  async attempts(ownerRef: string, taskId: string): Promise<readonly TaskAttempt[]> {
    const owner = requireOwner();
    if (owner !== ownerRef) return [];
    const rows = await this.database.query<AttemptRow>(
      `select task_id, attempt, run_id, worker, status, started_at, ended_at, summary, failure
         from task_attempts where task_id = $1 and owner_ref = $2 order by attempt asc`,
      [taskId, owner],
    );
    return rows.rows.map(toAttempt);
  }

  async saveAttempt(input: {
    readonly ownerRef: string;
    readonly attempt: TaskAttempt;
  }): Promise<void> {
    const owner = requireOwner();
    if (input.ownerRef !== owner) throw new Error('A task cannot be written for another owner.');
    await this.database.query(
      `insert into task_attempts
         (task_id, owner_ref, attempt, run_id, worker, status, started_at, ended_at, summary, failure)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (task_id, owner_ref, attempt) do update
         set run_id = excluded.run_id,
             worker = excluded.worker,
             status = excluded.status,
             ended_at = excluded.ended_at,
             summary = excluded.summary,
             failure = excluded.failure`,
      [
        input.attempt.taskId,
        owner,
        input.attempt.attempt,
        input.attempt.runId,
        input.attempt.worker,
        input.attempt.status,
        input.attempt.startedAt,
        input.attempt.endedAt,
        input.attempt.summary,
        input.attempt.failure === null ? null : JSON.stringify(input.attempt.failure),
      ],
    );
  }

  async count(ownerRef: string): Promise<number> {
    const owner = requireOwner();
    if (owner !== ownerRef) return 0;
    const rows = await this.database.query<{ count: string }>(
      'select count(*)::text as count from tasks where owner_ref = $1',
      [owner],
    );
    return Number(rows.rows[0]?.count ?? '0');
  }
}
