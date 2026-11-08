/**
 * Usage metering against a real PostgreSQL server (Step 52).
 *
 * What only a database can prove here:
 *  - eight workers claim the last two slots at the same instant, and exactly two
 *    succeed. An in-memory check would pass this test while the production
 *    system oversubscribed, because the check and the insert would be two steps;
 *  - a record survives a second connection (a restarted process reads it);
 *  - an operation key cannot be counted twice, whatever else races;
 *  - another owner sees neither records, holds, adjustments nor configuration.
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
import type { UsageRecord, UsageReservation } from '@veltravia/usage-core';

const RUN = Math.random().toString(36).slice(2, 8);
const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
let databaseUrl = baseDatabaseUrl;
const describeDb = databaseUrl === '' ? describe.skip : describe;

const OWNER = `usage-owner-${RUN}`;
const OTHER = `usage-other-${RUN}`;

describeDb('usage store (PostgreSQL)', () => {
  let database: Database;
  let stores: PostgresStores;
  // Real time on purpose: a hold's liveness is compared against the database's
  // own clock, so a fixture timestamp in the past would look expired to it.
  const now = new Date();

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'usage-store')) ?? '';
    database = createDatabase(parseDatabaseUrl(databaseUrl, { maxConnections: 8 }));
    await migrate(database);
    stores = createPostgresStores(database);
  });

  afterAll(async () => {
    await database?.close();
  });

  let seq = 0;
  const key = (base: string): string => `${base}_${RUN}_${++seq}`;

  function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
    return {
      id: `usg_${RUN}_${++seq}`,
      ownerRef: OWNER,
      projectId: 'prj_usage',
      category: 'backend_execution',
      operation: 'worker.run',
      resource: 'wkr_1',
      quantity: 1250,
      unit: 'milliseconds',
      operationKey: key('op'),
      occurredAt: now.toISOString(),
      environment: 'development',
      costClass: 'infrastructure',
      costBearer: 'veltravia',
      providerId: null,
      modelId: null,
      allowance: 'development',
      costUsd: null,
      costSource: 'unknown',
      source: 'measured',
      status: 'recorded',
      executionId: null,
      taskId: null,
      workerId: 'wkr_1',
      detail: { attempt: 1 },
      ...overrides,
    };
  }

  function reservation(overrides: Partial<UsageReservation> = {}): UsageReservation {
    const created = new Date(now.getTime());
    return {
      id: `rsv_${RUN}_${++seq}`,
      ownerRef: OWNER,
      projectId: 'prj_usage',
      category: 'background_jobs',
      quantity: 1,
      unit: 'calls',
      operationKey: key('hold'),
      operationId: null,
      status: 'held',
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + 600_000).toISOString(),
      settledAt: null,
      note: null,
      ...overrides,
    };
  }

  it('stores a record and reads it back through a second connection', async () => {
    const entry = record();
    const store = stores.usage;

    const inserted = await runWithOwner(OWNER, () => store.insertRecord(entry));
    expect(inserted).toBe(true);

    // A restarted process is a second pool over the same database.
    const second = createDatabase(parseDatabaseUrl(databaseUrl, { maxConnections: 2 }));
    try {
      const reader = createPostgresStores(second).usage;
      const found = await runWithOwner(OWNER, () => reader.findRecord(entry.operationKey));
      expect(found?.id).toBe(entry.id);
      expect(found?.quantity).toBe(1250);
      expect(found?.source).toBe('measured');
      expect(found?.detail).toEqual({ attempt: 1 });
    } finally {
      await second.close();
    }
  });

  it('counts one operation once even when two inserts race', async () => {
    const entry = record();
    const store = stores.usage;

    const results = await Promise.all([
      runWithOwner(OWNER, () => store.insertRecord(entry)),
      runWithOwner(OWNER, () => store.insertRecord({ ...entry, id: `usg_dup_${RUN}` })),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const rows = await runWithOwner(OWNER, () =>
      store.listRecords({ limit: 100, projectId: entry.projectId }),
    );
    expect(rows.filter((row) => row.operationKey === entry.operationKey)).toHaveLength(1);
  });

  it('refuses the third concurrent claim when only two slots exist', async () => {
    const store = stores.usage;
    await runWithOwner(OWNER, () => store.expireReservations('2100-01-01T00:00:00.000Z'));
    const attempts = Array.from({ length: 8 }, () => reservation());

    const outcomes = await Promise.all(
      attempts.map((entry) =>
        runWithOwner(OWNER, () =>
          store.claimReservation({
            reservation: entry,
            limitKey: 'concurrentJobs',
            limit: 2,
            now: now.toISOString(),
          }),
        ),
      ),
    );

    expect(outcomes.filter((value) => value !== null)).toHaveLength(2);
    const live = await runWithOwner(OWNER, () => store.countLiveReservations('background_jobs'));
    expect(live).toBe(2);
  });

  it('frees a released hold and an expired one, and keeps a committed one as history', async () => {
    const store = stores.usage;
    await runWithOwner(OWNER, () => store.expireReservations('2100-01-01T00:00:00.000Z'));
    const first = reservation();
    const second = reservation();
    const third = reservation();

    await runWithOwner(OWNER, () =>
      store.claimReservation({
        reservation: first,
        limitKey: 'concurrentJobs',
        limit: 2,
        now: now.toISOString(),
      }),
    );
    await runWithOwner(OWNER, () =>
      store.claimReservation({
        reservation: second,
        limitKey: 'concurrentJobs',
        limit: 2,
        now: now.toISOString(),
      }),
    );

    const released = await runWithOwner(OWNER, () =>
      store.settleReservation({
        operationKey: first.operationKey,
        status: 'released',
        now: now.toISOString(),
      }),
    );
    expect(released?.status).toBe('released');

    const thirdClaim = await runWithOwner(OWNER, () =>
      store.claimReservation({
        reservation: third,
        limitKey: 'concurrentJobs',
        limit: 2,
        now: now.toISOString(),
      }),
    );
    expect(thirdClaim?.status).toBe('held');

    await runWithOwner(OWNER, () =>
      store.settleReservation({
        operationKey: second.operationKey,
        status: 'committed',
        now: now.toISOString(),
      }),
    );

    // Expiry: a hold whose window closed is not capacity, and the sweep records
    // that it was expired rather than deleting it.
    const expired = await runWithOwner(OWNER, () =>
      store.expireReservations('2100-01-01T00:00:00.000Z'),
    );
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await runWithOwner(OWNER, () => store.countLiveReservations('background_jobs'))).toBe(0);

    const history = await runWithOwner(OWNER, () => store.listReservations({ limit: 50 }));
    expect(history.some((row) => row.status === 'committed')).toBe(true);
  });

  it('records an audited adjustment once per audit id', async () => {
    const store = stores.usage;
    const target = record();
    await runWithOwner(OWNER, () => store.insertRecord(target));

    const adjustment = {
      id: `adj_${RUN}_1`,
      ownerRef: OWNER,
      projectId: 'prj_usage',
      category: 'backend_execution' as const,
      quantity: -250,
      unit: 'milliseconds' as const,
      reason: 'Clock over-counted while the database was restarting.',
      actor: 'operator:ijezie',
      recordedAt: now.toISOString(),
      targetRecordId: target.id,
      auditId: `audit_${RUN}_1`,
    };

    expect(await runWithOwner(OWNER, () => store.insertAdjustment(adjustment))).toBe(true);
    expect(await runWithOwner(OWNER, () => store.insertAdjustment(adjustment))).toBe(false);

    // The record it corrects is untouched.
    const rows = await runWithOwner(OWNER, () =>
      store.listRecords({ limit: 10, projectId: 'prj_usage' }),
    );
    expect(rows.find((row) => row.id === target.id)?.quantity).toBe(1250);

    const adjustments = await runWithOwner(OWNER, () => store.listAdjustments({ limit: 10 }));
    expect(adjustments[0]?.targetRecordId).toBe(target.id);
  });

  it('keeps quota configuration owner-scoped, including an explicit unlimited', async () => {
    const store = stores.usage;
    await runWithOwner(OWNER, () =>
      store.writeOverride({
        scope: 'project',
        scopeId: 'prj_usage',
        key: 'fileStorageBytes',
        value: null,
        actor: 'operator:ijezie',
        now: now.toISOString(),
      }),
    );
    await runWithOwner(OWNER, () =>
      store.writeOverride({
        scope: 'owner',
        scopeId: OWNER,
        key: 'concurrentJobs',
        value: 4,
        actor: 'operator:ijezie',
        now: now.toISOString(),
      }),
    );

    const read = await runWithOwner(OWNER, () => store.readOverrides());
    expect(read.project['prj_usage']?.fileStorageBytes).toBeNull();
    expect(read.owner.concurrentJobs).toBe(4);

    const otherRead = await runWithOwner(OTHER, () => store.readOverrides());
    expect(otherRead.owner.concurrentJobs).toBeUndefined();
    expect(otherRead.project['prj_usage']).toBeUndefined();
  });

  it('refuses to read another owner’s records, and reports empty rather than theirs', async () => {
    const store = stores.usage;
    const entry = record({ projectId: 'prj_usage' });
    await runWithOwner(OWNER, () => store.insertRecord(entry));

    const otherRows = await runWithOwner(OTHER, () => store.listRecords({ limit: 100 }));
    expect(otherRows).toHaveLength(0);

    const lookedUp = await runWithOwner(OTHER, () => store.findRecord(entry.operationKey));
    expect(lookedUp).toBeNull();

    const otherHold = reservation();
    const claimed = await runWithOwner(OTHER, () =>
      store.claimReservation({
        reservation: otherHold,
        limitKey: 'concurrentJobs',
        limit: 1,
        now: now.toISOString(),
      }),
    );
    expect(claimed?.ownerRef).toBe(OTHER);
    // The other owner's hold does not consume this owner's slot.
    expect(await runWithOwner(OWNER, () => store.countLiveReservations('background_jobs'))).toBe(0);
  });

  it('stores the entitlement separate from the limits it implies', async () => {
    const store = stores.usage;
    await runWithOwner(OWNER, () =>
      store.writePlan({
        planId: 'paid',
        source: 'operator',
        actor: 'operator:ijezie',
        now: now.toISOString(),
      }),
    );
    const plan = await runWithOwner(OWNER, () => store.readPlan());
    expect(plan?.planId).toBe('paid');
    expect(await runWithOwner(OTHER, () => store.readPlan())).toBeNull();
  });
});
