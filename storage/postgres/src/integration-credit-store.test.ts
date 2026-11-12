/**
 * Integration charges against a real PostgreSQL server (Step 56).
 *
 * What only a database can prove here:
 *  - two attempts at the same operation, arriving at once, produce one charge;
 *  - a settle race has exactly one winner, because the state update is
 *    compare-and-set and not read-then-write;
 *  - the rows survive a restart: a second connection, standing in for a new
 *    process, reads what the first wrote;
 *  - another owner sees neither the charge nor its settings, even with the exact
 *    id in hand.
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
import type { IntegrationCharge } from '@veltravia/integration-credits-core';

const RUN = Math.random().toString(36).slice(2, 8);
const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = baseDatabaseUrl === '' ? describe.skip : describe;

const OWNER = `integration-owner-${RUN}`;
const OTHER = `integration-other-${RUN}`;

const charge = (over: Partial<IntegrationCharge> = {}): IntegrationCharge => ({
  id: `ich_${RUN}`,
  ownerRef: OWNER,
  workspaceId: null,
  projectId: null,
  integrationId: 'github',
  connectorId: 'github',
  pluginId: null,
  operationId: 'contents.get',
  executionId: 'run-1',
  requestId: 'inv-1',
  connectionId: 'conn-1',
  kind: 'integration.operation',
  billingClass: 'paid',
  planId: 'paid',
  policyId: 'paid.integration.github',
  credits: 0,
  estimatedCredits: 0.44,
  state: 'reserved',
  basis: 'flat',
  requests: null,
  units: {},
  durationMs: null,
  limitations: [],
  measurementSource: null,
  byok: false,
  idempotencyKey: `key-${RUN}`,
  reservationId: null,
  walletEntryId: null,
  failureReason: null,
  createdAt: '2026-11-11T10:00:00.000Z',
  settledAt: null,
  refundedAt: null,
  ...over,
});

describeDb('integration credit store (PostgreSQL)', () => {
  let database: Database;
  let stores: PostgresStores;
  let testUrl = '';

  beforeAll(async () => {
    testUrl = await prepareIsolatedTestSchema(baseDatabaseUrl, 'integration-credits');
    database = createDatabase(parseDatabaseUrl(testUrl, { maxConnections: 8 }));
    await migrate(database);
    stores = createPostgresStores(database);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it('charges one operation once however many attempts arrive', async () => {
    const results = await runWithOwner(OWNER, () =>
      Promise.all([
        stores.integrationCredits.insertCharge(charge()),
        stores.integrationCredits.insertCharge(charge({ id: `ich_dup_${RUN}` })),
        stores.integrationCredits.insertCharge(charge({ id: `ich_dup2_${RUN}` })),
      ]),
    );
    expect(results.filter((row) => row.created)).toHaveLength(1);
    expect(new Set(results.map((row) => row.charge.id)).size).toBe(1);
  });

  it('settles once under a compare-and-set race', async () => {
    const first = await runWithOwner(OWNER, () =>
      stores.integrationCredits.insertCharge(
        charge({ id: `ich_race_${RUN}`, idempotencyKey: `race-${RUN}` }),
      ),
    );
    const settled = charge({
      id: first.charge.id,
      idempotencyKey: `race-${RUN}`,
      state: 'committed',
      credits: 0.48,
      requests: 1,
      settledAt: '2026-11-11T10:00:05.000Z',
    });
    /*
     * Which of the two arrives first is up to the database, so the test must not
     * assume a winner: it asserts that exactly one settle is accepted and that the
     * stored row is the accepted one. (Asserting 0.48 specifically made this test
     * fail whenever the other statement won the race, which is legal.)
     */
    const contenders = [settled, { ...settled, credits: 9 }];
    const outcomes = await runWithOwner(OWNER, () =>
      Promise.all(contenders.map((row) => stores.integrationCredits.saveCharge(row, 'reserved'))),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = contenders[outcomes.findIndex((won) => won)];
    const stored = await runWithOwner(OWNER, () =>
      stores.integrationCredits.findById(OWNER, first.charge.id),
    );
    expect(stored?.state).toBe('committed');
    expect(stored?.credits).toBe(winner?.credits);
  });

  it('keeps every identifier the charge was taken with', async () => {
    const row = await runWithOwner(OWNER, () =>
      stores.integrationCredits.insertCharge(
        charge({
          id: `ich_full_${RUN}`,
          idempotencyKey: `full-${RUN}`,
          workspaceId: 'ws-1',
          projectId: 'prj-1',
          executionId: 'exec-9',
          requestId: 'inv-9',
          units: { record: 12, byte: 2048 },
          requests: 2,
          durationMs: 1500,
          measurementSource: 'connector',
          limitations: ['units-unavailable'],
        }),
      ),
    );
    const stored = await runWithOwner(OWNER, () =>
      stores.integrationCredits.findById(OWNER, row.charge.id),
    );
    expect(stored).toMatchObject({
      integrationId: 'github',
      connectorId: 'github',
      operationId: 'contents.get',
      executionId: 'exec-9',
      requestId: 'inv-9',
      connectionId: 'conn-1',
      workspaceId: 'ws-1',
      projectId: 'prj-1',
      requests: 2,
      durationMs: 1500,
      measurementSource: 'connector',
    });
    expect(stored?.units).toEqual({ record: 12, byte: 2048 });
    expect(stored?.limitations).toEqual(['units-unavailable']);
  });

  it('reads what the first connection wrote from a second one', async () => {
    const second = createDatabase(parseDatabaseUrl(testUrl, { maxConnections: 2 }));
    try {
      const secondStores = createPostgresStores(second);
      const found = await runWithOwner(OWNER, () =>
        secondStores.integrationCredits.findByKey(OWNER, `key-${RUN}`),
      );
      expect(found?.ownerRef).toBe(OWNER);
      expect(found?.integrationId).toBe('github');
    } finally {
      await second.close();
    }
  });

  it('aggregates settled charges per integration and skips open holds', async () => {
    await runWithOwner(OWNER, async () => {
      await stores.integrationCredits.insertCharge(
        charge({
          id: `ich_agg_${RUN}`,
          idempotencyKey: `agg-${RUN}`,
          state: 'committed',
          credits: 1.25,
          requests: 3,
          units: { record: 5 },
          createdAt: '2026-11-11T11:00:00.000Z',
        }),
      );
      await stores.integrationCredits.insertCharge(
        charge({
          id: `ich_open_${RUN}`,
          idempotencyKey: `open-${RUN}`,
          state: 'reserved',
          credits: 0,
          createdAt: '2026-11-11T11:01:00.000Z',
        }),
      );
    });
    const groups = await runWithOwner(OWNER, () =>
      stores.integrationCredits.aggregate(OWNER, 'integration'),
    );
    const github = groups.find((group) => group.key === 'github');
    expect(github?.charges).toBeGreaterThanOrEqual(2);
    expect(github?.requests).toBeGreaterThanOrEqual(3);
    expect(github?.units).toBeGreaterThanOrEqual(5);
  });

  it('never shows another owner these charges', async () => {
    const mine = await runWithOwner(OWNER, () =>
      stores.integrationCredits.listCharges(OWNER, { limit: 10 }),
    );
    expect(mine.total).toBeGreaterThan(0);
    const theirs = await runWithOwner(OTHER, () =>
      stores.integrationCredits.listCharges(OTHER, { limit: 10 }),
    );
    expect(theirs.total).toBe(0);
    const missing = await runWithOwner(OTHER, () =>
      stores.integrationCredits.findById(OTHER, mine.charges[0]?.id ?? 'none'),
    );
    expect(missing).toBeNull();
  });

  it('keeps spending settings per owner and workspace', async () => {
    await runWithOwner(OWNER, () =>
      stores.integrationCredits.saveSettings({
        ownerRef: OWNER,
        workspaceId: 'ws-settings',
        monthlyLimit: 25,
        perOperationLimit: 2,
        updatedAt: '2026-11-11T00:00:00.000Z',
      }),
    );
    const read = await runWithOwner(OWNER, () =>
      stores.integrationCredits.readSettings(OWNER, 'ws-settings'),
    );
    expect(read).toMatchObject({ monthlyLimit: 25, perOperationLimit: 2 });
    const personal = await runWithOwner(OWNER, () =>
      stores.integrationCredits.readSettings(OWNER, null),
    );
    expect(personal).toBeNull();
  });

  it('lists open holds oldest first for the sweep', async () => {
    const open = await runWithOwner(OWNER, () => stores.integrationCredits.listOpen(OWNER, 50));
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((row) => row.state === 'reserved')).toBe(true);
    const stamps = open.map((row) => row.createdAt);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('names every account holding credit, and no account that holds none', async () => {
    const holding = `${OTHER}-holding`;
    const settled = `${OTHER}-settled`;
    // A row is written under the scope it runs in, so each account inserts its own.
    await runWithOwner(holding, () =>
      stores.integrationCredits.insertCharge(
        charge({
          id: `ich_holding_${RUN}`,
          ownerRef: holding,
          idempotencyKey: `holding-${RUN}`,
          createdAt: '2026-11-11T09:30:00.000Z',
        }),
      ),
    );
    await runWithOwner(settled, () =>
      stores.integrationCredits.insertCharge(
        charge({
          id: `ich_settled_${RUN}`,
          ownerRef: settled,
          idempotencyKey: `settled-${RUN}`,
          state: 'committed',
        }),
      ),
    );
    const owners = await runWithOwner(OWNER, () => stores.integrationCredits.listOpenOwners(100));
    expect(owners).toContain(OWNER);
    expect(owners).toContain(holding);
    // A settled charge leaves nobody holding anything, so that account is absent.
    expect(owners).not.toContain(settled);
  });
});
