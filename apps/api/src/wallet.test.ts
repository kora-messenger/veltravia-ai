/**
 * The wallet as the platform exposes it (Step 53).
 *
 * These tests are about the boundary, not the arithmetic (the core package
 * proves that): an owner can read their own wallet and move their own holds and
 * nothing else, an operator token is required for anything that creates credit,
 * a duplicate request is billed once, a refund cannot exceed the charge it
 * compensates, and metered usage is charged exactly once even when the meter
 * writes the same operation twice.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './server.js';
import { createUsageService } from './usage-service.js';
import { createWalletService } from './wallet-service.js';

const ADMIN = 'wallet-admin-token-for-tests';
let app: FastifyInstance | null = null;

beforeEach(() => {
  process.env['VELTRAVIA_WALLET_ADMIN_TOKEN'] = ADMIN;
});

afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env['VELTRAVIA_WALLET_ADMIN_TOKEN'];
});

async function start(): Promise<FastifyInstance> {
  const api = await buildApp({ logger: false });
  await api.ready();
  app = api;
  return api;
}

const asOwner = (ownerRef: string) => ({ 'x-veltravia-owner': ownerRef });
const asAdmin = (actor = 'operator:test') => ({
  authorization: `Bearer ${ADMIN}`,
  'x-veltravia-actor': actor,
});
/** An operator acting on a named owner says so in the header as well as the body. */
const asAdminFor = (ownerRef: string, actor = 'operator:test') => ({
  ...asAdmin(actor),
  'x-veltravia-owner': ownerRef,
});

async function credit(
  api: FastifyInstance,
  ownerRef: string,
  amount: number,
  idempotencyKey: string,
): Promise<{ id: string; amount: number }> {
  const response = await api.inject({
    method: 'POST',
    url: '/api/wallet/credits',
    headers: asAdminFor(ownerRef),
    payload: { ownerRef, amount, kind: 'grant', reason: 'test grant', idempotencyKey },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { entry: { id: string; amount: number } };
  return body.entry;
}

describe('wallet balances and history', () => {
  it('opens an empty wallet on the first read instead of 404', async () => {
    const api = await start();
    const response = await api.inject({
      method: 'GET',
      url: '/api/wallet',
      headers: asOwner('w-1'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      wallet: { available: number; spendable: number };
      durable: boolean;
    };
    expect(body.wallet.available).toBe(0);
    expect(body.wallet.spendable).toBe(0);
    // No database in tests: the wallet says so rather than pretending to persist.
    expect(body.durable).toBe(false);
  });

  it('shows added credit and the transaction that explains it', async () => {
    const api = await start();
    await credit(api, 'w-2', 40, 'grant-w2-0001');

    const overview = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-2') })
    ).json() as { wallet: { available: number }; recent: { kind: string; amount: number }[] };
    expect(overview.wallet.available).toBe(40);
    expect(overview.recent[0]).toMatchObject({ kind: 'grant', amount: 40 });

    const ledger = (
      await api.inject({
        method: 'GET',
        url: '/api/wallet/transactions?limit=5',
        headers: asOwner('w-2'),
      })
    ).json() as { transactions: { idempotencyKey: string }[] };
    expect(ledger.transactions).toHaveLength(1);
    expect(ledger.transactions[0]!.idempotencyKey).toBe('grant-w2-0001');
  });

  it('never shows another owner’s balance even when asked for their wallet', async () => {
    const api = await start();
    await credit(api, 'w-3', 10, 'grant-w3-0001');
    await credit(api, 'w-4', 90, 'grant-w4-0001');

    const mine = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-3') })
    ).json() as { wallet: { available: number } };
    expect(mine.wallet.available).toBe(10);

    // A workspace id the caller does not own is a separate, empty wallet, not a
    // view of somebody else's balance.
    const other = (
      await api.inject({
        method: 'GET',
        url: '/api/wallet?workspaceId=ws_someone_else',
        headers: asOwner('w-3'),
      })
    ).json() as { wallet: { available: number } };
    expect(other.wallet.available).toBe(0);
  });

  it('keeps the personal wallet and a workspace wallet apart', async () => {
    const api = await start();
    await credit(api, 'w-5', 25, 'grant-w5-0001');
    await api.inject({
      method: 'POST',
      url: '/api/wallet/credits',
      headers: asAdminFor('w-5'),
      payload: {
        ownerRef: 'w-5',
        workspaceId: 'ws_team',
        amount: 60,
        kind: 'grant',
        reason: 'Team pool.',
        idempotencyKey: 'grant-w5-ws-0001',
      },
    });

    const personal = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-5') })
    ).json() as { wallet: { available: number } };
    const team = (
      await api.inject({
        method: 'GET',
        url: '/api/wallet?workspaceId=ws_team',
        headers: asOwner('w-5'),
      })
    ).json() as { wallet: { available: number; scope: string } };

    expect(personal.wallet.available).toBe(25);
    expect(team.wallet).toMatchObject({ available: 60, scope: 'workspace' });
  });
});

describe('operator authorisation', () => {
  it('refuses to create credit without the operator token', async () => {
    const api = await start();
    const anonymous = await api.inject({
      method: 'POST',
      url: '/api/wallet/credits',
      headers: asOwner('w-6'),
      payload: { ownerRef: 'w-6', amount: 500, kind: 'grant', reason: 'self service' },
    });
    expect(anonymous.statusCode).toBe(403);
    expect((anonymous.json() as { code: string }).code).toBe('WALLET_ADMIN_REQUIRED');

    const wrong = await api.inject({
      method: 'POST',
      url: '/api/wallet/credits',
      headers: { authorization: 'Bearer not-the-token' },
      payload: { ownerRef: 'w-6', amount: 500, kind: 'grant', reason: 'guess' },
    });
    expect(wrong.statusCode).toBe(403);

    const balance = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-6') })
    ).json() as { wallet: { available: number } };
    expect(balance.wallet.available).toBe(0);
  });

  it('fails closed when the deployment has no operator token at all', async () => {
    delete process.env['VELTRAVIA_WALLET_ADMIN_TOKEN'];
    delete process.env['VELTRAVIA_USAGE_ADMIN_TOKEN'];
    const api = await start();
    const response = await api.inject({
      method: 'POST',
      url: '/api/wallet/adjustments',
      headers: { authorization: 'Bearer anything' },
      payload: { ownerRef: 'w-7', amount: 5, direction: 'credit', reason: 'no token configured' },
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { code: string }).code).toBe('WALLET_ADMIN_UNAVAILABLE');
  });

  it('refuses an invalid amount before touching the ledger', async () => {
    const api = await start();
    for (const amount of [-5, 0, 1.23456]) {
      const response = await api.inject({
        method: 'POST',
        url: '/api/wallet/credits',
        headers: asAdminFor('w-8'),
        payload: { ownerRef: 'w-8', amount, kind: 'grant', reason: 'bad amount' },
      });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { code: string }).code).toBe('INVALID_AMOUNT');
    }
    const balance = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-8') })
    ).json() as { wallet: { available: number } };
    expect(balance.wallet.available).toBe(0);
  });
});

describe('holds, refunds and duplicates over HTTP', () => {
  it('holds credit, releases it, and never spends it', async () => {
    const api = await start();
    await credit(api, 'w-9', 30, 'grant-w9-0001');

    const hold = await api.inject({
      method: 'POST',
      url: '/api/wallet/reservations',
      headers: asOwner('w-9'),
      payload: { amount: 10, operationKey: 'worker:w-9:run-1', reason: 'Worker starting.' },
    });
    expect(hold.statusCode).toBe(201);
    const reservationId = (hold.json() as { reservation: { id: string } }).reservation.id;

    const held = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-9') })
    ).json() as { wallet: { available: number; reserved: number; spendable: number } };
    expect(held.wallet).toMatchObject({ available: 20, reserved: 10, spendable: 10 });

    const release = await api.inject({
      method: 'POST',
      url: `/api/wallet/reservations/${reservationId}/release`,
      headers: asOwner('w-9'),
      payload: {},
    });
    expect(release.statusCode).toBe(200);
    const after = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-9') })
    ).json() as { wallet: { available: number; reserved: number; spent: number } };
    expect(after.wallet).toMatchObject({ available: 30, reserved: 0, spent: 0 });
  });

  it('settles a hold once and refuses the second settlement', async () => {
    const api = await start();
    await credit(api, 'w-10', 20, 'grant-w10-0001');
    const reservationId = (
      (
        await api.inject({
          method: 'POST',
          url: '/api/wallet/reservations',
          headers: asOwner('w-10'),
          payload: { amount: 8, operationKey: 'worker:w-10:run-1' },
        })
      ).json() as { reservation: { id: string } }
    ).reservation.id;

    const first = await api.inject({
      method: 'POST',
      url: `/api/wallet/reservations/${reservationId}/commit`,
      headers: asOwner('w-10'),
      payload: { amount: 5 },
    });
    expect(first.statusCode).toBe(200);

    const second = await api.inject({
      method: 'POST',
      url: `/api/wallet/reservations/${reservationId}/commit`,
      headers: asOwner('w-10'),
      payload: { amount: 5 },
    });
    expect(second.statusCode).toBe(409);

    const balance = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-10') })
    ).json() as { wallet: { available: number; reserved: number; spent: number } };
    // 20 granted, 8 held, 5 spent: the 3 that was not used came back.
    expect(balance.wallet).toMatchObject({ available: 15, reserved: 0, spent: 5 });
  });

  it('refuses a hold larger than the balance and says what is missing', async () => {
    const api = await start();
    await credit(api, 'w-11', 4, 'grant-w11-0001');
    const response = await api.inject({
      method: 'POST',
      url: '/api/wallet/reservations',
      headers: asOwner('w-11'),
      payload: { amount: 10, operationKey: 'worker:w-11:run-1' },
    });
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      shortfall: 6,
    });
  });

  it('refunds a charge once and never beyond it', async () => {
    const api = await start();
    await credit(api, 'w-12', 50, 'grant-w12-0001');
    const charge = await api.inject({
      method: 'POST',
      url: '/api/wallet/reservations',
      headers: asOwner('w-12'),
      payload: { amount: 20, operationKey: 'job:w-12:1' },
    });
    const reservationId = (charge.json() as { reservation: { id: string } }).reservation.id;
    const settled = await api.inject({
      method: 'POST',
      url: `/api/wallet/reservations/${reservationId}/commit`,
      headers: asOwner('w-12'),
      payload: { amount: 20 },
    });
    const entryId = (settled.json() as { entry: { id: string } }).entry.id;

    const refunded = await api.inject({
      method: 'POST',
      url: '/api/wallet/refunds',
      headers: asAdminFor('w-12'),
      payload: {
        ownerRef: 'w-12',
        entryId,
        reason: 'The job failed.',
        idempotencyKey: 'refund-w12-01',
      },
    });
    expect(refunded.statusCode).toBe(201);

    const again = await api.inject({
      method: 'POST',
      url: '/api/wallet/refunds',
      headers: asAdminFor('w-12'),
      payload: {
        ownerRef: 'w-12',
        entryId,
        reason: 'The job failed.',
        idempotencyKey: 'refund-w12-02',
      },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe('REFUND_EXCEEDS_ORIGINAL');

    const balance = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-12') })
    ).json() as { wallet: { available: number; spent: number } };
    expect(balance.wallet).toMatchObject({ available: 50, spent: 0 });
  });

  it('treats a repeated operator credit as the same credit', async () => {
    const api = await start();
    const first = await credit(api, 'w-13', 15, 'grant-w13-0001');
    const again = await api.inject({
      method: 'POST',
      url: '/api/wallet/credits',
      headers: asAdminFor('w-13'),
      payload: {
        ownerRef: 'w-13',
        amount: 15,
        kind: 'grant',
        reason: 'test grant',
        idempotencyKey: 'grant-w13-0001',
      },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { entry: { id: string } }).entry.id).toBe(first.id);

    const balance = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-13') })
    ).json() as { wallet: { available: number } };
    expect(balance.wallet.available).toBe(15);
  });

  it('reverses a mistaken adjustment once', async () => {
    const api = await start();
    await credit(api, 'w-14', 20, 'grant-w14-0001');
    const adjustment = await api.inject({
      method: 'POST',
      url: '/api/wallet/adjustments',
      headers: asAdminFor('w-14'),
      payload: {
        ownerRef: 'w-14',
        amount: 5,
        direction: 'debit',
        reason: 'Charged by mistake.',
        idempotencyKey: 'adjust-w14-01',
      },
    });
    const entryId = (adjustment.json() as { entry: { id: string } }).entry.id;

    const reversed = await api.inject({
      method: 'POST',
      url: '/api/wallet/reversals',
      headers: asAdminFor('w-14'),
      payload: { ownerRef: 'w-14', entryId, reason: 'It was a mistake.' },
    });
    expect(reversed.statusCode).toBe(201);

    const twice = await api.inject({
      method: 'POST',
      url: '/api/wallet/reversals',
      headers: asAdminFor('w-14'),
      payload: { ownerRef: 'w-14', entryId, reason: 'Again.' },
    });
    expect(twice.statusCode).toBe(409);

    const balance = (
      await api.inject({ method: 'GET', url: '/api/wallet', headers: asOwner('w-14') })
    ).json() as { wallet: { available: number } };
    expect(balance.wallet.available).toBe(20);
  });
});

describe('metered usage is billed into the wallet', () => {
  it('deducts credits for billable platform usage, once per metered event', async () => {
    // The real wiring, without HTTP: the usage service writes a record and calls
    // the wallet, exactly as the server composes them.
    const wallet = createWalletService({});
    await wallet.credit({
      ownerRef: 'w-meter',
      amount: 100,
      kind: 'grant',
      reason: 'Opening balance.',
      actor: 'test',
      idempotencyKey: 'meter-grant-0001',
    });
    const usage = createUsageService({
      onRecorded: async (record) => {
        await wallet.billUsage({ ownerRef: record.ownerRef, record });
      },
    });

    const record = await usage.recordWorkerExecution({
      ownerRef: 'w-meter',
      workerId: 'wkr_meter_1',
      startedAt: '2026-11-08T10:00:00.000Z',
      finishedAt: '2026-11-08T10:02:00.000Z',
    });
    expect(record).not.toBeNull();
    // 120 seconds of worker wall clock at 1 credit per 60 seconds.
    expect((await wallet.overview({ ownerRef: 'w-meter' })).wallet).toMatchObject({
      available: 98,
      spent: 2,
    });

    // The same worker reviewed again writes no new record and charges nothing.
    await usage.recordWorkerExecution({
      ownerRef: 'w-meter',
      workerId: 'wkr_meter_1',
      startedAt: '2026-11-08T10:00:00.000Z',
      finishedAt: '2026-11-08T10:02:00.000Z',
    });
    expect((await wallet.overview({ ownerRef: 'w-meter' })).wallet.available).toBe(98);

    const entries = await wallet.history({ ownerRef: 'w-meter', limit: 10 });
    const charges = entries.filter((entry) => entry.kind === 'usage_deduction');
    expect(charges).toHaveLength(1);
    expect(charges[0]!.referenceType).toBe('usage_record');
  });

  it('leaves a wallet that cannot pay unchanged and does not throw', async () => {
    const wallet = createWalletService({});
    await wallet.credit({
      ownerRef: 'w-broke',
      amount: 1,
      kind: 'grant',
      reason: 'Almost nothing.',
      actor: 'test',
      idempotencyKey: 'broke-grant-0001',
    });
    const usage = createUsageService({
      onRecorded: async (record) => {
        await wallet.billUsage({ ownerRef: record.ownerRef, record });
      },
    });

    const record = await usage.recordWorkerExecution({
      ownerRef: 'w-broke',
      workerId: 'wkr_broke_1',
      startedAt: '2026-11-08T10:00:00.000Z',
      finishedAt: '2026-11-08T11:00:00.000Z',
    });
    // The metered record still exists: the work happened and is not hidden just
    // because the wallet could not cover it.
    expect(record).not.toBeNull();
    expect((await wallet.overview({ ownerRef: 'w-broke' })).wallet.available).toBe(1);
  });
});

describe('reconciliation and metered billing', () => {
  it('reconciles a wallet through the API and reports it consistent', async () => {
    const api = await start();
    await credit(api, 'w-15', 40, 'grant-w15-0001');
    const hold = await api.inject({
      method: 'POST',
      url: '/api/wallet/reservations',
      headers: asOwner('w-15'),
      payload: { amount: 10, operationKey: 'worker:w-15:1' },
    });
    const reservationId = (hold.json() as { reservation: { id: string } }).reservation.id;
    await api.inject({
      method: 'POST',
      url: `/api/wallet/reservations/${reservationId}/commit`,
      headers: asOwner('w-15'),
      payload: { amount: 10 },
    });

    const report = (
      await api.inject({ method: 'GET', url: '/api/wallet/reconcile', headers: asOwner('w-15') })
    ).json() as {
      consistent: boolean;
      ledger: Record<string, number>;
      stored: Record<string, number>;
    };
    expect(report.consistent).toBe(true);
    expect(report.ledger).toEqual(report.stored);
    expect(report.ledger['available']).toBe(30);
  });

  it('publishes the billing rules and rates rather than hiding them', async () => {
    const api = await start();
    const body = (await api.inject({ method: 'GET', url: '/api/wallet/capabilities' })).json() as {
      rates: string[];
      rules: string[];
      currency: string;
    };
    expect(body.currency).toBe('VELTRAVIA_CREDITS');
    expect(body.rates.join(' ')).toContain('background_jobs');
    expect(body.rates.join(' ')).toContain('file_storage: not billed');
    expect(body.rules.join(' ')).toContain('own provider key');
  });
});
