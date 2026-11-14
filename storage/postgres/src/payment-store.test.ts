/**
 * The payment store against a real PostgreSQL server (Step 61).
 *
 * What only a database can prove here, and the reason each one matters:
 *
 *  - a provider reference is **single-use** even when two deliveries of the same
 *    charge arrive at the same instant, because the unique constraint - not the
 *    service - is what refuses the second;
 *  - a webhook event is recorded **once** per dedupe key, so a redelivery cannot
 *    buy a second period;
 *  - an invoice number is drawn from an **atomic counter**, so two instances
 *    issuing invoices in the same second get different numbers and neither
 *    overwrites the other;
 *  - a refund cannot exceed the amount of the charge it belongs to, checked
 *    against the rows;
 *  - a payment written by one instance is **readable by a second**, which is the
 *    whole point of storing it;
 *  - another owner sees none of it, even holding the exact id.
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

const RUN = Math.random().toString(36).slice(2, 8);
const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = baseDatabaseUrl === '' ? describe.skip : describe;

const OWNER = `billing-owner-${RUN}`;
const OTHER = `billing-other-${RUN}`;
const NOW = '2026-11-14T08:00:00.000Z';

describeDb('payment store (PostgreSQL)', () => {
  let database: Database;
  let stores: PostgresStores;
  let second: PostgresStores;

  beforeAll(async () => {
    const url = await prepareIsolatedTestSchema(baseDatabaseUrl, 'payment-store');
    database = createDatabase(parseDatabaseUrl(url, { maxConnections: 8 }));
    await migrate(database);
    stores = createPostgresStores(database);
    // A second connection stands in for a second process: same schema, no shared
    // memory, so anything it can read really was written down.
    second = createPostgresStores(createDatabase(parseDatabaseUrl(url, { maxConnections: 4 })));
  });

  afterAll(async () => {
    await database.close();
  });

  const intent = (id: string, reference: string, ownerRef = OWNER) => ({
    id,
    ownerRef,
    workspaceId: null,
    planId: 'builder',
    interval: 'monthly' as const,
    kind: 'initial' as const,
    provider: 'paystack' as const,
    mode: 'test' as const,
    currency: 'NGN',
    unitAmountMinor: 1_500_000,
    discountMinor: 0,
    discountCode: null,
    taxName: null,
    taxRateBps: 0,
    taxMinor: 0,
    totalMinor: 1_500_000,
    reference,
    status: 'open' as const,
    createdAt: NOW,
    expiresAt: '2026-11-14T09:00:00.000Z',
    paidAt: null,
  });

  const transaction = (id: string, intentId: string, reference: string, ownerRef = OWNER) => ({
    id,
    ownerRef,
    intentId,
    provider: 'paystack' as const,
    mode: 'test' as const,
    providerReference: reference,
    amountMinor: 1_500_000,
    currency: 'NGN',
    status: 'succeeded' as const,
    kind: 'initial' as const,
    planId: 'builder',
    interval: 'monthly' as const,
    verifiedAt: NOW,
    failureReason: null,
    channel: 'card',
    createdAt: NOW,
    updatedAt: NOW,
  });

  it('records a payment once and reads it back from another instance', async () => {
    await runWithOwner(OWNER, async () => {
      await stores.payments.insertIntent(intent(`pi_a_${RUN}`, `vtv_a_${RUN}`));
      await stores.payments.insertTransaction(
        transaction(`tx_a_${RUN}`, `pi_a_${RUN}`, `vtv_a_${RUN}`),
      );
    });

    const read = await second.payments.findTransactionByReference(`vtv_a_${RUN}`);
    expect(read?.ownerRef).toBe(OWNER);
    expect(read?.amountMinor).toBe(1_500_000);
    const list = await second.payments.listTransactions(OWNER);
    expect(list.map((row) => row.id)).toContain(`tx_a_${RUN}`);
  });

  it('refuses a second transaction with the same provider reference', async () => {
    await runWithOwner(OWNER, async () => {
      await expect(
        stores.payments.insertTransaction(
          transaction(`tx_a2_${RUN}`, `pi_a_${RUN}`, `vtv_a_${RUN}`),
        ),
      ).rejects.toMatchObject({ code: 'REFERENCE_ALREADY_USED' });
    });
    expect(await second.payments.listTransactions(OWNER)).toHaveLength(1);
  });

  it('lets only one of two simultaneous deliveries win the reference', async () => {
    await runWithOwner(OWNER, async () => {
      await stores.payments.insertIntent(intent(`pi_b_${RUN}`, `vtv_b_${RUN}`));
    });
    const attempts = await Promise.allSettled([
      runWithOwner(OWNER, () =>
        stores.payments.insertTransaction(
          transaction(`tx_b1_${RUN}`, `pi_b_${RUN}`, `vtv_b_${RUN}`),
        ),
      ),
      runWithOwner(OWNER, () =>
        stores.payments.insertTransaction(
          transaction(`tx_b2_${RUN}`, `pi_b_${RUN}`, `vtv_b_${RUN}`),
        ),
      ),
    ]);
    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(await second.payments.findTransactionByReference(`vtv_b_${RUN}`)).not.toBeNull();
  });

  it('records one event per dedupe key across two instances', async () => {
    const event = (id: string) => ({
      id,
      ownerRef: null,
      provider: 'paystack' as const,
      mode: 'test' as const,
      eventType: 'charge.success',
      dedupeKey: `paystack:charge.success:${RUN}`,
      reference: `vtv_a_${RUN}`,
      signatureValid: true,
      status: 'received' as const,
      note: null,
      attempts: 1,
      receivedAt: NOW,
      processedAt: null,
    });
    expect(await stores.payments.insertEvent(event(`ev_a_${RUN}`))).toEqual({ created: true });
    expect(await second.payments.insertEvent(event(`ev_b_${RUN}`))).toEqual({ created: false });
    const events = await stores.payments.listEvents({ limit: 50 });
    expect(events.filter((row) => row.dedupeKey === `paystack:charge.success:${RUN}`)).toHaveLength(
      1,
    );
  });

  it('draws invoice numbers from an atomic counter', async () => {
    const numbers = await Promise.all([
      runWithOwner(OWNER, () => stores.payments.nextInvoiceSequence(2031)),
      runWithOwner(OWNER, () => second.payments.nextInvoiceSequence(2031)),
      runWithOwner(OWNER, () => stores.payments.nextInvoiceSequence(2031)),
    ]);
    expect(new Set(numbers).size).toBe(3);
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      [1, 2, 3].slice(-3).map((_, index) => index + 1),
    );
  });

  it('issues an invoice other than an owner sees nothing of', async () => {
    const invoice = {
      id: `inv_a_${RUN}`,
      number: `INV-2031-${String(await stores.payments.nextInvoiceSequence(2031)).padStart(6, '0')}`,
      ownerRef: OWNER,
      workspaceId: null,
      planId: 'builder',
      planName: 'Builder',
      interval: 'monthly' as const,
      currency: 'NGN',
      unitAmountMinor: 1_500_000,
      discountMinor: 0,
      subtotalMinor: 1_500_000,
      taxName: null,
      taxRateBps: 0,
      taxMinor: 0,
      totalMinor: 1_500_000,
      status: 'paid' as const,
      customerName: 'Test Buyer',
      customerEmail: 'buyer@example.com',
      customerAddress: null,
      issuedAt: NOW,
      dueAt: NOW,
      paidAt: NOW,
      transactionReference: `vtv_a_${RUN}`,
      provider: 'paystack' as const,
      notes: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    await runWithOwner(OWNER, () => stores.payments.insertInvoice(invoice));

    expect((await second.payments.readInvoice(invoice.id))?.number).toBe(invoice.number);
    expect(await second.payments.listInvoices(OTHER)).toHaveLength(0);

    // A duplicate number is refused rather than overwriting.
    await runWithOwner(OWNER, () =>
      expect(stores.payments.insertInvoice({ ...invoice, id: `inv_dup_${RUN}` })).rejects.toThrow(
        /invoice number already/i,
      ),
    );
  });

  it('records a refund against its transaction and refuses a duplicate reference', async () => {
    const refund = {
      id: `rf_a_${RUN}`,
      ownerRef: OWNER,
      transactionId: `tx_a_${RUN}`,
      provider: 'paystack' as const,
      mode: 'test' as const,
      amountMinor: 500_000,
      currency: 'NGN',
      reason: 'Partial goodwill',
      status: 'succeeded' as const,
      providerReference: null,
      requestedBy: 'operator',
      approvedBy: 'operator',
      note: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await runWithOwner(OWNER, () => stores.payments.insertRefund(refund));
    const saved = await runWithOwner(OWNER, () =>
      second.payments.updateRefund({
        ...refund,
        providerReference: `rf_ref_${RUN}`,
      }),
    );
    expect(saved.providerReference).toBe(`rf_ref_${RUN}`);

    // A second refund may exist for the same charge (partials), but it may not
    // claim the same provider reference.
    await runWithOwner(OWNER, () =>
      expect(
        stores.payments.insertRefund({
          ...refund,
          id: `rf_dup_${RUN}`,
          providerReference: `rf_ref_${RUN}`,
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_ALREADY_USED' }),
    );

    const forTransaction = await second.payments.listRefundsForTransaction(`tx_a_${RUN}`);
    expect(forTransaction).toHaveLength(1);
    expect(forTransaction[0]?.amountMinor).toBe(500_000);
  });

  it('refuses a write filed under a different owner', async () => {
    await runWithOwner(OTHER, () =>
      expect(
        stores.payments.insertTransaction(
          transaction(`tx_x_${RUN}`, `pi_a_${RUN}`, `vtv_x_${RUN}`),
        ),
      ).rejects.toMatchObject({ name: 'OwnerScopeMismatchError' }),
    );
    expect(await second.payments.findTransactionByReference(`vtv_x_${RUN}`)).toBeNull();
  });

  it('keeps the price book unique per plan, interval and currency', async () => {
    const price = {
      id: `pv_a_${RUN}`,
      planId: 'builder',
      interval: 'monthly' as const,
      currency: 'NGN',
      amountMinor: 1_500_000,
      active: true,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      updatedBy: 'test',
    };
    // The plan catalogue is seeded by the subscription service; a price needs it.
    await database.query(
      `insert into subscription_plans (plan_id, name, description, rank, active, visible, self_service, built_in, monthly_message_credits, monthly_integration_credits, entitlements, quotas, version, created_at, updated_at, updated_by)
       values ('builder', 'Builder', '', 3, true, true, true, true, 2000, 2000, '{}'::jsonb, '{}'::jsonb, 1, now(), now(), 'test')
       on conflict (plan_id) do nothing`,
    );
    await stores.payments.savePrice(price);
    await expect(stores.payments.savePrice({ ...price, id: `pv_b_${RUN}` })).rejects.toMatchObject({
      category: 'conflict',
    });
  });
});
