/**
 * The credit wallet against a real PostgreSQL server (Step 53).
 *
 * What only a database can prove here:
 *  - ten concurrent deductions from one wallet cannot overspend it, even though
 *    every one of them starts with the same stale balance in hand;
 *  - a retried request finds its own entry instead of charging again, including
 *    when both attempts arrive at once;
 *  - the balances are still there when a second connection (a restarted process)
 *    reads them, which is the whole point of a wallet;
 *  - a hold settles once under a settle race;
 *  - another owner sees neither the wallet nor the entries, even with the exact
 *    entry id in hand.
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
import { CreditWallet, WalletError } from '@veltravia/wallet-core';

const RUN = Math.random().toString(36).slice(2, 8);
const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = baseDatabaseUrl === '' ? describe.skip : describe;

const OWNER = `wallet-owner-${RUN}`;
const OTHER = `wallet-other-${RUN}`;

describeDb('wallet store (PostgreSQL)', () => {
  let database: Database;
  let stores: PostgresStores;
  let wallet: CreditWallet;
  let testUrl = '';

  beforeAll(async () => {
    const url = await prepareIsolatedTestSchema(baseDatabaseUrl, 'wallet-store');
    testUrl = url;
    database = createDatabase(parseDatabaseUrl(url, { maxConnections: 8 }));
    await migrate(database);
    stores = createPostgresStores(database);
    wallet = new CreditWallet({ store: stores.wallet });
    await runWithOwner(OWNER, async () => {
      await wallet.ensureWallet({ ownerRef: OWNER });
      await wallet.credit({
        ownerRef: OWNER,
        amount: 100,
        kind: 'grant',
        source: 'plan',
        actor: 'test',
        reason: 'Opening balance for the store test.',
        idempotencyKey: `opening-${RUN}`,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it('refuses to overspend under ten concurrent deductions', async () => {
    await runWithOwner(OWNER, async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_unused, index) =>
          wallet.charge({
            ownerRef: OWNER,
            amount: 15,
            source: 'usage',
            actor: 'meter',
            reason: `Concurrent charge ${index}`,
            idempotencyKey: `concurrent-${RUN}-${index}`,
          }),
        ),
      );
      const fulfilled = results.filter((row) => row.status === 'fulfilled');
      const refused = results.filter(
        (row) => row.status === 'rejected' && row.reason instanceof WalletError,
      );
      expect(fulfilled).toHaveLength(6);
      expect(refused).toHaveLength(4);

      const current = await wallet.wallet({ ownerRef: OWNER });
      expect(current?.available).toBe(10);
      expect(current?.spent).toBe(90);
    });
  }, 30_000);

  it('bills a duplicate request once, even when both land together', async () => {
    await runWithOwner(OWNER, async () => {
      const [first, second] = await Promise.all([
        wallet.charge({
          ownerRef: OWNER,
          amount: 5,
          source: 'usage',
          actor: 'meter',
          reason: 'A retried request.',
          idempotencyKey: `retry-${RUN}`,
        }),
        wallet.charge({
          ownerRef: OWNER,
          amount: 5,
          source: 'usage',
          actor: 'meter',
          reason: 'A retried request.',
          idempotencyKey: `retry-${RUN}`,
        }),
      ]);
      expect(first.entry.id).toBe(second.entry.id);
      expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
      expect((await wallet.wallet({ ownerRef: OWNER }))?.available).toBe(5);
    });
  }, 20_000);

  it('settles a hold once under a settle race', async () => {
    await runWithOwner(OWNER, async () => {
      await wallet.credit({
        ownerRef: OWNER,
        amount: 20,
        kind: 'grant',
        source: 'plan',
        actor: 'test',
        reason: 'Top up before the hold test.',
        idempotencyKey: `topup-${RUN}`,
      });
      const hold = await wallet.reserve({
        ownerRef: OWNER,
        amount: 10,
        operationKey: `worker:${RUN}`,
        reason: 'Work starting.',
        actor: 'test',
      });

      const outcomes = await Promise.allSettled([
        wallet.commitReservation({
          ownerRef: OWNER,
          reservationId: hold.reservation.id,
          amount: 10,
          reason: 'Finished.',
          actor: 'test',
        }),
        wallet.releaseReservation({
          ownerRef: OWNER,
          reservationId: hold.reservation.id,
          reason: 'Cancelled.',
          actor: 'test',
        }),
      ]);
      expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      const current = await wallet.wallet({ ownerRef: OWNER });
      expect(current?.reserved).toBe(0);
    });
  }, 20_000);

  it('keeps balances, entries and holds across a restart', async () => {
    const before = await runWithOwner(OWNER, () => wallet.wallet({ ownerRef: OWNER }));
    const heldBefore = await runWithOwner(OWNER, () => wallet.reservations({ ownerRef: OWNER }));

    // A second pool over the same schema is what a restarted process looks like.
    const restarted = createDatabase(parseDatabaseUrl(testUrl, { maxConnections: 2 }));
    try {
      const second = new CreditWallet({ store: createPostgresStores(restarted).wallet });
      const after = await runWithOwner(OWNER, () => second.wallet({ ownerRef: OWNER }));
      expect(after).toMatchObject({
        available: before?.available,
        reserved: before?.reserved,
        spent: before?.spent,
      });
      const history = await runWithOwner(OWNER, () =>
        second.history({ ownerRef: OWNER, limit: 50 }),
      );
      expect(history.length).toBeGreaterThan(0);
      const holds = await runWithOwner(OWNER, () => second.reservations({ ownerRef: OWNER }));
      expect(holds.length).toBe(heldBefore.length);
      const report = await runWithOwner(OWNER, () => second.reconcile({ ownerRef: OWNER }));
      expect(report.consistent).toBe(true);
    } finally {
      await restarted.close();
    }
  }, 30_000);

  it('never lets another owner see or touch the wallet', async () => {
    const entry = await runWithOwner(OWNER, () => wallet.history({ ownerRef: OWNER, limit: 1 }));
    const entryId = entry[0]!.id;

    await runWithOwner(OTHER, async () => {
      expect(await wallet.wallet({ ownerRef: OTHER })).toBeNull();
      const mine = await wallet.ensureWallet({ ownerRef: OTHER });
      expect(mine.available).toBe(0);
      expect(await stores.wallet.findEntry(OTHER, entryId)).toBeNull();
      await expect(
        wallet.charge({
          ownerRef: OTHER,
          amount: 1,
          source: 'usage',
          actor: 'meter',
          reason: 'Not their wallet.',
          idempotencyKey: `cross-${RUN}`,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    });
  }, 20_000);
});
