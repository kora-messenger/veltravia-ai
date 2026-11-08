/**
 * Reliability records in PostgreSQL (Step 51).
 *
 * Each store owns exactly one atomic statement where the guarantee lives:
 *
 *  - idempotency `insert ... on conflict do nothing`, and a conditional
 *    `update ... where expired or failed or abandoned` for reclaiming a key;
 *  - leases `insert ... on conflict do update ... where expired or released`,
 *    which is a single statement, so two instances racing for the same execution
 *    produce one winner and one null;
 *  - the inbox `insert ... on conflict do nothing`, so a redelivered event is
 *    recognised without a read-then-write window;
 *  - orchestrator recoveries a plain append.
 *
 * Ownership always comes from the async owner scope, never from the arguments.
 */

import type {
  EventInboxStore,
  IdempotencyRecord,
  IdempotencyStore,
  InboxEvent,
  LeaseRecord,
  LeaseStore,
  OrchestrationRecovery,
} from '@veltravia/reliability-core';

import { requireOwner } from '../owner-scope.js';
import type { Queryable } from '../pool.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

interface IdempotencyRow {
  owner_ref: string;
  scope: string;
  key: string;
  fingerprint: string;
  status: IdempotencyRecord['status'];
  operation_id: string;
  response: { status: number; body: unknown } | null;
  failure: { code: string; message: string } | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

const toIdempotencyRecord = (row: IdempotencyRow): IdempotencyRecord => ({
  ownerRef: row.owner_ref,
  scope: row.scope,
  key: row.key,
  fingerprint: row.fingerprint,
  status: row.status,
  operationId: row.operation_id,
  response: row.response,
  failure: row.failure,
  createdAt: (iso(row.created_at) as string),
  updatedAt: (iso(row.updated_at) as string),
  expiresAt: (iso(row.expires_at) as string),
});

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async insert(record: IdempotencyRecord): Promise<boolean> {
    const owner = requireOwner();
    const result = await this.query.query<{ key: string }>(
      `insert into idempotency_records
         (owner_ref, scope, key, fingerprint, status, operation_id, response, failure,
          created_at, updated_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (owner_ref, scope, key) do nothing
       returning key`,
      [
        owner,
        record.scope,
        record.key,
        record.fingerprint,
        record.status,
        record.operationId,
        record.response === null ? null : JSON.stringify(record.response),
        record.failure === null ? null : JSON.stringify(record.failure),
        record.createdAt,
        record.updatedAt,
        record.expiresAt,
      ],
    );
    return result.rows.length > 0;
  }

  async reclaim(
    record: IdempotencyRecord,
    options: { readonly now: string; readonly staleMs: number },
  ): Promise<boolean> {
    const owner = requireOwner();
    const staleBefore = new Date(
      Date.parse(options.now) - options.staleMs,
    ).toISOString();
    const result = await this.query.query<{ key: string }>(
      `update idempotency_records
          set fingerprint = $4,
              status = 'in_progress',
              operation_id = $5,
              response = null,
              failure = null,
              created_at = $6,
              updated_at = $6,
              expires_at = $7
        where owner_ref = $1
          and scope = $2
          and key = $3
          and (
            expires_at <= $6
            or status = 'failed'
            or (status = 'in_progress' and updated_at <= $8)
          )
        returning key`,
      [
        owner,
        record.scope,
        record.key,
        record.fingerprint,
        record.operationId,
        record.createdAt,
        record.expiresAt,
        staleBefore,
      ],
    );
    return result.rows.length > 0;
  }

  async get(ownerRef: string, scope: string, key: string): Promise<IdempotencyRecord | null> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<IdempotencyRow>(
      `select owner_ref, scope, key, fingerprint, status, operation_id, response, failure,
              created_at, updated_at, expires_at
         from idempotency_records
        where owner_ref = $1 and scope = $2 and key = $3`,
      [owner, scope, key],
    );
    const row = result.rows[0];
    return row === undefined ? null : toIdempotencyRecord(row);
  }

  async complete(
    ownerRef: string,
    scope: string,
    key: string,
    operationId: string,
    response: { readonly status: number; readonly body: unknown },
    at: string,
  ): Promise<boolean> {
    const owner = requireOwner();
    void ownerRef;
    // Only the attempt that still owns the key writes its outcome: a reclaimed
    // key belongs to a newer operation and must not be overwritten by a late one.
    const result = await this.query.query<{ key: string }>(
      `update idempotency_records
          set status = 'completed', response = $5, failure = null, updated_at = $6
        where owner_ref = $1 and scope = $2 and key = $3 and operation_id = $4
        returning key`,
      [owner, scope, key, operationId, JSON.stringify(response), at],
    );
    return result.rows.length > 0;
  }

  async fail(
    ownerRef: string,
    scope: string,
    key: string,
    operationId: string,
    failure: { readonly code: string; readonly message: string },
    at: string,
  ): Promise<boolean> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<{ key: string }>(
      `update idempotency_records
          set status = 'failed', failure = $5, updated_at = $6
        where owner_ref = $1 and scope = $2 and key = $3 and operation_id = $4
        returning key`,
      [owner, scope, key, operationId, JSON.stringify(failure), at],
    );
    return result.rows.length > 0;
  }

  async list(
    ownerRef: string,
    filter: {
      readonly scope?: string;
      readonly status?: readonly IdempotencyRecord['status'][];
      readonly limit?: number;
    },
  ): Promise<readonly IdempotencyRecord[]> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<IdempotencyRow>(
      `select owner_ref, scope, key, fingerprint, status, operation_id, response, failure,
              created_at, updated_at, expires_at
         from idempotency_records
        where owner_ref = $1
          and ($2::text is null or scope = $2)
          and ($3::text[] is null or status = any($3))
        order by updated_at desc
        limit $4`,
      [
        owner,
        filter.scope ?? null,
        filter.status === undefined ? null : [...filter.status],
        Math.min(Math.max(filter.limit ?? 100, 1), 500),
      ],
    );
    return result.rows.map(toIdempotencyRecord);
  }
}

interface LeaseRow {
  owner_ref: string;
  resource: string;
  holder: string;
  acquired_at: Date;
  renewed_at: Date;
  expires_at: Date;
  released_at: Date | null;
  note: string | null;
}

const toLease = (row: LeaseRow): LeaseRecord => ({
  ownerRef: row.owner_ref,
  resource: row.resource,
  holder: row.holder,
  acquiredAt: iso(row.acquired_at) as string,
  renewedAt: iso(row.renewed_at) as string,
  expiresAt: iso(row.expires_at) as string,
  releasedAt: iso(row.released_at),
  note: row.note,
});

export class PostgresLeaseStore implements LeaseStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async claim(input: {
    readonly ownerRef: string;
    readonly resource: string;
    readonly holder: string;
    readonly ttlMs: number;
    readonly note: string | null;
    readonly now: string;
  }): Promise<LeaseRecord | null> {
    const owner = requireOwner();
    const expiresAt = new Date(Date.parse(input.now) + input.ttlMs).toISOString();
    // One statement: insert the claim, or take it over when the previous holder
    // let it expire or released it. The `where` is what serialises the race.
    const result = await this.query.query<LeaseRow>(
      `insert into execution_leases
         (owner_ref, resource, holder, acquired_at, renewed_at, expires_at, released_at, note)
       values ($1, $2, $3, $4, $4, $5, null, $6)
       on conflict (owner_ref, resource) do update
          set holder = excluded.holder,
              acquired_at = excluded.acquired_at,
              renewed_at = excluded.renewed_at,
              expires_at = excluded.expires_at,
              released_at = null,
              note = excluded.note
        where execution_leases.expires_at <= $4
           or execution_leases.released_at is not null
       returning owner_ref, resource, holder, acquired_at, renewed_at, expires_at, released_at, note`,
      [owner, input.resource, input.holder, input.now, expiresAt, input.note],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLease(row);
  }

  async renew(
    ownerRef: string,
    resource: string,
    holder: string,
    ttlMs: number,
    now: string,
  ): Promise<LeaseRecord | null> {
    const owner = requireOwner();
    void ownerRef;
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const result = await this.query.query<LeaseRow>(
      `update execution_leases
          set renewed_at = $4, expires_at = $5
        where owner_ref = $1 and resource = $2 and holder = $3 and released_at is null
        returning owner_ref, resource, holder, acquired_at, renewed_at, expires_at, released_at, note`,
      [owner, resource, holder, now, expiresAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLease(row);
  }

  async release(ownerRef: string, resource: string, holder: string, now: string): Promise<boolean> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<{ resource: string }>(
      `update execution_leases
          set released_at = $4
        where owner_ref = $1 and resource = $2 and holder = $3 and released_at is null
        returning resource`,
      [owner, resource, holder, now],
    );
    return result.rows.length > 0;
  }

  async get(ownerRef: string, resource: string): Promise<LeaseRecord | null> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<LeaseRow>(
      `select owner_ref, resource, holder, acquired_at, renewed_at, expires_at, released_at, note
         from execution_leases
        where owner_ref = $1 and resource = $2`,
      [owner, resource],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLease(row);
  }

  async list(
    ownerRef: string,
    filter: { readonly activeOnly?: boolean; readonly limit?: number },
  ): Promise<readonly LeaseRecord[]> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<LeaseRow>(
      `select owner_ref, resource, holder, acquired_at, renewed_at, expires_at, released_at, note
         from execution_leases
        where owner_ref = $1
          and ($2::boolean is not true or released_at is null)
        order by renewed_at desc
        limit $3`,
      [owner, filter.activeOnly === true, Math.min(Math.max(filter.limit ?? 100, 1), 500)],
    );
    return result.rows.map(toLease);
  }
}

interface InboxRow {
  owner_ref: string;
  event_key: string;
  topic: string;
  payload: unknown;
  status: InboxEvent['status'];
  attempts: number;
  last_error: string | null;
  received_at: Date;
  processed_at: Date | null;
  available_at: Date;
}

const toInboxEvent = (row: InboxRow): InboxEvent => ({
  ownerRef: row.owner_ref,
  eventKey: row.event_key,
  topic: row.topic,
  payload: row.payload,
  status: row.status,
  attempts: row.attempts,
  lastError: row.last_error,
  receivedAt: iso(row.received_at) as string,
  processedAt: iso(row.processed_at),
  availableAt: iso(row.available_at) as string,
});

export class PostgresEventInbox implements EventInboxStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async receive(event: InboxEvent): Promise<boolean> {
    const owner = requireOwner();
    const result = await this.query.query<{ event_key: string }>(
      `insert into event_inbox
         (owner_ref, event_key, topic, payload, status, attempts, last_error,
          received_at, processed_at, available_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (owner_ref, event_key) do nothing
       returning event_key`,
      [
        owner,
        event.eventKey,
        event.topic,
        JSON.stringify(event.payload ?? null),
        event.status,
        event.attempts,
        event.lastError,
        event.receivedAt,
        event.processedAt,
        event.availableAt,
      ],
    );
    return result.rows.length > 0;
  }

  async markProcessed(ownerRef: string, eventKey: string, at: string): Promise<void> {
    const owner = requireOwner();
    void ownerRef;
    await this.query.query(
      `update event_inbox
          set status = 'processed', processed_at = $3, attempts = attempts + 1, available_at = $3
        where owner_ref = $1 and event_key = $2`,
      [owner, eventKey, at],
    );
  }

  async markFailed(
    ownerRef: string,
    eventKey: string,
    error: string,
    availableAt: string,
    _at: string,
  ): Promise<void> {
    const owner = requireOwner();
    void ownerRef;
    await this.query.query(
      `update event_inbox
          set status = 'failed',
              last_error = $3,
              attempts = attempts + 1,
              available_at = $4,
              processed_at = null
        where owner_ref = $1 and event_key = $2`,
      [owner, eventKey, error, availableAt],
    );
  }

  async get(ownerRef: string, eventKey: string): Promise<InboxEvent | null> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<InboxRow>(
      `select owner_ref, event_key, topic, payload, status, attempts, last_error,
              received_at, processed_at, available_at
         from event_inbox
        where owner_ref = $1 and event_key = $2`,
      [owner, eventKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInboxEvent(row);
  }

  async due(
    ownerRef: string,
    options: { readonly at: string; readonly limit?: number },
  ): Promise<readonly InboxEvent[]> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<InboxRow>(
      `select owner_ref, event_key, topic, payload, status, attempts, last_error,
              received_at, processed_at, available_at
         from event_inbox
        where owner_ref = $1 and status = 'failed' and available_at <= $2
        order by available_at asc
        limit $3`,
      [owner, options.at, Math.min(Math.max(options.limit ?? 20, 1), 100)],
    );
    return result.rows.map(toInboxEvent);
  }

  async list(
    ownerRef: string,
    filter: {
      readonly status?: readonly InboxEvent['status'][];
      readonly topic?: string;
      readonly limit?: number;
    },
  ): Promise<readonly InboxEvent[]> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<InboxRow>(
      `select owner_ref, event_key, topic, payload, status, attempts, last_error,
              received_at, processed_at, available_at
         from event_inbox
        where owner_ref = $1
          and ($2::text[] is null or status = any($2))
          and ($3::text is null or topic = $3)
        order by received_at desc
        limit $4`,
      [
        owner,
        filter.status === undefined ? null : [...filter.status],
        filter.topic ?? null,
        Math.min(Math.max(filter.limit ?? 100, 1), 500),
      ],
    );
    return result.rows.map(toInboxEvent);
  }
}

interface RecoveryRow {
  id: string;
  owner_ref: string;
  execution_id: string;
  action: OrchestrationRecovery['action'];
  reason: string;
  evidence: readonly string[];
  holder: string;
  lease_expired: boolean;
  decided_at: Date;
}

/** What a sweep decided, kept so the decision survives the process that made it. */
export class PostgresOrchestrationRecoveryStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async record(decision: Omit<OrchestrationRecovery, 'ownerRef'>): Promise<OrchestrationRecovery> {
    const owner = requireOwner();
    await this.query.query(
      `insert into orchestration_recoveries
         (id, owner_ref, execution_id, action, reason, evidence, holder, lease_expired, decided_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id, owner_ref) do nothing`,
      [
        decision.id,
        owner,
        decision.executionId,
        decision.action,
        decision.reason,
        JSON.stringify(decision.evidence),
        decision.holder,
        decision.leaseExpired,
        decision.decidedAt,
      ],
    );
    return { ...decision, ownerRef: owner };
  }

  async list(
    ownerRef: string,
    filter: { readonly executionId?: string; readonly limit?: number } = {},
  ): Promise<readonly OrchestrationRecovery[]> {
    const owner = requireOwner();
    void ownerRef;
    const result = await this.query.query<RecoveryRow>(
      `select id, owner_ref, execution_id, action, reason, evidence, holder, lease_expired, decided_at
         from orchestration_recoveries
        where owner_ref = $1
          and ($2::text is null or execution_id = $2)
        order by decided_at desc
        limit $3`,
      [owner, filter.executionId ?? null, Math.min(Math.max(filter.limit ?? 50, 1), 200)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      ownerRef: row.owner_ref,
      executionId: row.execution_id,
      action: row.action,
      reason: row.reason,
      evidence: row.evidence,
      holder: row.holder,
      decidedAt: iso(row.decided_at) as string,
      leaseExpired: row.lease_expired,
    }));
  }
}
