/**
 * Reliability records against a real PostgreSQL server (Step 51).
 *
 * What only a database proves here:
 *  - two racing key inserts produce one record, not two operations;
 *  - a lease claim is one atomic statement, so a second holder gets null even
 *    when both ask at the same moment;
 *  - a redelivered event key is refused by the schema, not by application
 *    bookkeeping;
 *  - another owner sees none of it.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  createPostgresStores,
  migrate,
  parseDatabaseUrl,
  runWithOwner,
  type Database,
  type PostgresStores,
} from './index.js';
import { prepareIsolatedTestSchema } from './test-schema.js';
import type { IdempotencyRecord, InboxEvent, LeaseRecord } from '@veltravia/reliability-core';

const RUN = Math.random().toString(36).slice(2, 8);
const id = (base: string): string => `${base}_${RUN}`;

const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
let databaseUrl = baseDatabaseUrl;
const describeDb = databaseUrl === '' ? describe.skip : describe;

const owner = 'reliability-db-owner';
const other = 'reliability-db-other';

describeDb('reliability stores (PostgreSQL)', () => {
  let database: Database;
  let stores: PostgresStores;

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'reliability-store')) ?? '';
    database = createDatabase(parseDatabaseUrl(databaseUrl, { maxConnections: 8 }));
    await migrate(database);
    stores = createPostgresStores(database);
  });

  afterAll(async () => {
    await database?.close();
  });

  const at = new Date().toISOString();
  const later = new Date(Date.parse(at) + 60_000).toISOString();

  let keys = 0;
  function keyRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
    keys += 1;
    return {
      ownerRef: owner,
      scope: 'POST /api/executions',
      key: id(`key${keys}`),
      fingerprint: 'fp_1',
      status: 'in_progress',
      operationId: id('op'),
      response: null,
      failure: null,
      createdAt: at,
      updatedAt: at,
      expiresAt: later,
      ...overrides,
    };
  }

  it('accepts one insert for a key and refuses the duplicate', async () => {
    const record = keyRecord();
    const first = await runWithOwner(owner, () => stores.idempotency.insert(record));
    const second = await runWithOwner(owner, () => stores.idempotency.insert(record));
    expect(first).toBe(true);
    expect(second).toBe(false);

    const stored = await runWithOwner(owner, () =>
      stores.idempotency.get(owner, record.scope, record.key),
    );
    expect(stored?.operationId).toBe(record.operationId);
  });

  it('survives two racing claims: exactly one wins', async () => {
    const a = keyRecord();
    const b = keyRecord({ key: a.key });
    const results = await runWithOwner(owner, () =>
      Promise.all([stores.idempotency.insert(a), stores.idempotency.insert(b)]),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('only lets the operation that owns the key record the outcome', async () => {
    const record = keyRecord();
    await runWithOwner(owner, () => stores.idempotency.insert(record));

    const wrong = await runWithOwner(owner, () =>
      stores.idempotency.complete(
        owner,
        record.scope,
        record.key,
        'op_someone_else',
        { status: 200, body: { wrong: true } },
        at,
      ),
    );
    expect(wrong).toBe(false);

    const right = await runWithOwner(owner, () =>
      stores.idempotency.complete(
        owner,
        record.scope,
        record.key,
        record.operationId,
        {
          status: 201,
          body: { executionId: 'exe_1' },
        },
        at,
      ),
    );
    expect(right).toBe(true);
    const stored = await runWithOwner(owner, () =>
      stores.idempotency.get(owner, record.scope, record.key),
    );
    expect(stored?.status).toBe('completed');
    expect(stored?.response).toEqual({ status: 201, body: { executionId: 'exe_1' } });
  });

  it('reclaims an abandoned attempt but not a live one', async () => {
    const record = keyRecord();
    await runWithOwner(owner, () => stores.idempotency.insert(record));
    const replacement = keyRecord({
      key: record.key,
      operationId: id('op_new'),
    });

    const live = await runWithOwner(owner, () =>
      stores.idempotency.reclaim(replacement, { now: at, staleMs: 60_000 }),
    );
    expect(live).toBe(false);

    const stale = await runWithOwner(owner, () =>
      stores.idempotency.reclaim(replacement, {
        now: new Date(Date.parse(at) + 120_000).toISOString(),
        staleMs: 60_000,
      }),
    );
    expect(stale).toBe(true);
    const stored = await runWithOwner(owner, () =>
      stores.idempotency.get(owner, record.scope, record.key),
    );
    expect(stored?.operationId).toBe(replacement.operationId);
  });

  it('does not let one owner read or list another owner\u2019s key', async () => {
    const record = keyRecord();
    await runWithOwner(owner, () => stores.idempotency.insert(record));
    const foreign = await runWithOwner(other, () =>
      stores.idempotency.get(other, record.scope, record.key),
    );
    expect(foreign).toBeNull();
    const foreignList = await runWithOwner(other, () => stores.idempotency.list(other, {}));
    expect(foreignList).toHaveLength(0);
  });

  it('gives a lease to one holder and refuses the other, atomically', async () => {
    const resource = id('execution:exe');
    const claim = (holder: string): Promise<LeaseRecord | null> =>
      runWithOwner(owner, () =>
        stores.leases.claim({
          ownerRef: owner,
          resource,
          holder,
          ttlMs: 30_000,
          note: null,
          now: at,
        }),
      );
    const results = await Promise.all([claim('api-a'), claim('api-b')]);
    expect(results.filter((entry) => entry !== null)).toHaveLength(1);

    const winner = results.find((entry) => entry !== null)?.holder as string;
    const loser = winner === 'api-a' ? 'api-b' : 'api-a';
    expect(await claim(loser)).toBeNull();

    // Renewal and release belong to the holder.
    const renewed = await runWithOwner(owner, () =>
      stores.leases.renew(owner, resource, winner, 60_000, at),
    );
    expect(renewed?.holder).toBe(winner);
    expect(
      await runWithOwner(owner, () => stores.leases.renew(owner, resource, loser, 60_000, at)),
    ).toBeNull();
    expect(await runWithOwner(owner, () => stores.leases.release(owner, resource, loser, at))).toBe(
      false,
    );
    expect(
      await runWithOwner(owner, () => stores.leases.release(owner, resource, winner, at)),
    ).toBe(true);

    // A released lease can be taken again.
    const taken = await claim(loser);
    expect(taken?.holder).toBe(loser);
  });

  it('lets a second holder take over a lease that expired', async () => {
    const resource = id('execution:exe_expired');
    await runWithOwner(owner, () =>
      stores.leases.claim({
        ownerRef: owner,
        resource,
        holder: 'api-a',
        ttlMs: 1_000,
        note: null,
        now: at,
      }),
    );
    const expiredAt = new Date(Date.parse(at) + 5_000).toISOString();
    const taken = await runWithOwner(owner, () =>
      stores.leases.claim({
        ownerRef: owner,
        resource,
        holder: 'api-b',
        ttlMs: 30_000,
        note: null,
        now: expiredAt,
      }),
    );
    expect(taken?.holder).toBe('api-b');
    const listed = await runWithOwner(owner, () => stores.leases.list(owner, { activeOnly: true }));
    expect(listed.map((lease) => lease.resource)).toContain(resource);
  });

  it('records an event key once and tracks its failure and retry time', async () => {
    const eventKey = id('recovery_case:w1');
    const event: InboxEvent = {
      ownerRef: owner,
      eventKey,
      topic: 'recovery_case',
      payload: { workerId: 'w1' },
      status: 'pending',
      attempts: 0,
      lastError: null,
      receivedAt: at,
      processedAt: null,
      availableAt: at,
    };
    expect(await runWithOwner(owner, () => stores.inbox.receive(event))).toBe(true);
    expect(await runWithOwner(owner, () => stores.inbox.receive(event))).toBe(false);

    await runWithOwner(owner, () =>
      stores.inbox.markFailed(owner, eventKey, 'project locked', later, at),
    );
    const failed = await runWithOwner(owner, () => stores.inbox.get(owner, eventKey));
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(1);

    const notYetDue = await runWithOwner(owner, () => stores.inbox.due(owner, { at, limit: 10 }));
    expect(notYetDue.map((entry) => entry.eventKey)).not.toContain(eventKey);
    const due = await runWithOwner(owner, () => stores.inbox.due(owner, { at: later, limit: 10 }));
    expect(due.map((entry) => entry.eventKey)).toContain(eventKey);

    await runWithOwner(owner, () => stores.inbox.markProcessed(owner, eventKey, later));
    const processed = await runWithOwner(owner, () => stores.inbox.get(owner, eventKey));
    expect(processed?.status).toBe('processed');
    expect(processed?.attempts).toBe(2);
  });

  it('keeps a sweep decision with the evidence it was made on', async () => {
    const executionId = id('exe_decided');
    const decided = await runWithOwner(owner, () =>
      stores.orchestratorRecoveries.record({
        id: id('orc'),
        executionId,
        action: 'recover',
        reason: 'A worker stopped reporting.',
        evidence: ['w1 is running and last reported 120s ago'],
        holder: 'api-a',
        leaseExpired: true,
        decidedAt: at,
      }),
    );
    expect(decided.ownerRef).toBe(owner);
    const listed = await runWithOwner(owner, () =>
      stores.orchestratorRecoveries.list(owner, { executionId }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.evidence[0]).toContain('w1');
    const foreign = await runWithOwner(other, () =>
      stores.orchestratorRecoveries.list(other, { executionId }),
    );
    expect(foreign).toHaveLength(0);
  });
});
