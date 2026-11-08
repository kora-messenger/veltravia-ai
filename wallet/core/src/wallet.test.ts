/**
 * The wallet's promises, tested where they are made (Step 53).
 *
 * These are the claims that matter: a balance cannot go below zero no matter how
 * many deductions arrive at once, the same request cannot be billed twice, a
 * refund cannot exceed the charge it compensates, a hold can only settle once,
 * and reconciliation is arithmetic over the ledger rather than an assertion of
 * trust.
 */

import { describe, expect, it } from 'vitest';

import { CreditWallet } from './ledger.js';
import { InMemoryWalletStore } from './memory.js';
import { DEFAULT_CREDIT_RATES, chargeForUsage, isCharge, parseCreditRates } from './pricing.js';
import { WalletError } from './types.js';

const owner = 'owner-wallet-tests';
const key = (suffix: string) => `idem-${suffix}-0001`;

function build(overrides: { readonly now?: () => Date } = {}) {
  const store = new InMemoryWalletStore();
  const wallet = new CreditWallet({ store, ...overrides });
  return { store, wallet };
}

async function funded(amount = 100) {
  const built = build();
  await built.wallet.ensureWallet({ ownerRef: owner });
  await built.wallet.credit({
    ownerRef: owner,
    amount,
    kind: 'grant',
    source: 'plan',
    actor: 'test',
    reason: 'Opening the wallet.',
    idempotencyKey: key('opening'),
  });
  return built;
}

describe('wallet balances', () => {
  it('opens one wallet per owner and scope, and never a second', async () => {
    const { wallet } = build();
    const first = await wallet.ensureWallet({ ownerRef: owner });
    const again = await wallet.ensureWallet({ ownerRef: owner });
    const workspace = await wallet.ensureWallet({ ownerRef: owner, workspaceId: 'ws_1' });

    expect(again.id).toBe(first.id);
    expect(workspace.id).not.toBe(first.id);
    expect(workspace.scope).toBe('workspace');
    expect(first.available).toBe(0);
  });

  it('keeps available, reserved and spent apart through a hold and a commit', async () => {
    const { wallet } = await funded(50);

    const hold = await wallet.reserve({
      ownerRef: owner,
      amount: 20,
      operationKey: key('reserve'),
      reason: 'Worker about to start.',
      actor: 'test',
    });
    let current = (await wallet.wallet({ ownerRef: owner }))!;
    expect({ ...pick(current) }).toEqual({ available: 30, reserved: 20, spent: 0 });

    await wallet.commitReservation({
      ownerRef: owner,
      reservationId: hold.reservation.id,
      amount: 12,
      reason: 'Worker finished early.',
      actor: 'test',
    });
    current = (await wallet.wallet({ ownerRef: owner }))!;
    // 20 was held, 12 was spent, 8 came back.
    expect({ ...pick(current) }).toEqual({ available: 38, reserved: 0, spent: 12 });
  });

  it('gives a released hold back and charges nothing', async () => {
    const { wallet } = await funded(10);
    const hold = await wallet.reserve({
      ownerRef: owner,
      amount: 10,
      operationKey: key('release'),
      reason: 'Starting something that may not run.',
      actor: 'test',
    });
    await wallet.releaseReservation({
      ownerRef: owner,
      reservationId: hold.reservation.id,
      reason: 'The work was never dispatched.',
      actor: 'test',
    });
    const current = (await wallet.wallet({ ownerRef: owner }))!;
    expect({ ...pick(current) }).toEqual({ available: 10, reserved: 0, spent: 0 });
  });
});

describe('deductions', () => {
  it('refuses a charge past the balance and says how short it is', async () => {
    const { wallet } = await funded(5);
    await expect(
      wallet.charge({
        ownerRef: owner,
        amount: 12,
        source: 'usage',
        actor: 'meter',
        reason: 'A job that costs more than the wallet holds.',
        idempotencyKey: key('over'),
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      status: 402,
      details: { required: 12, available: 5, shortfall: 7 },
    });
  });

  it('cannot be overdrawn by concurrent deductions', async () => {
    const { wallet } = await funded(100);
    // Ten deductions of 15 from a balance of 100: six can succeed, four cannot,
    // whichever order they land in.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_unused, index) =>
        wallet.charge({
          ownerRef: owner,
          amount: 15,
          source: 'usage',
          actor: 'meter',
          reason: `Concurrent charge ${index}`,
          idempotencyKey: key(`concurrent-${index}`),
        }),
      ),
    );
    const settled = results.filter((row) => row.status === 'fulfilled');
    const refused = results.filter(
      (row) => row.status === 'rejected' && row.reason instanceof WalletError,
    );
    expect(settled).toHaveLength(6);
    expect(refused).toHaveLength(4);

    const current = (await wallet.wallet({ ownerRef: owner }))!;
    expect(current.available).toBe(10);
    expect(current.spent).toBe(90);
    expect(current.available).toBeGreaterThanOrEqual(0);
  });

  it('charges one request once when it is retried', async () => {
    const { wallet, store } = await funded(30);
    const first = await wallet.charge({
      ownerRef: owner,
      amount: 10,
      source: 'usage',
      actor: 'meter',
      reason: 'A job.',
      idempotencyKey: key('retry'),
    });
    const second = await wallet.charge({
      ownerRef: owner,
      amount: 10,
      source: 'usage',
      actor: 'meter',
      reason: 'A job.',
      idempotencyKey: key('retry'),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await store.countEntries(owner)).toBe(2); // opening grant + one charge
    expect((await wallet.wallet({ ownerRef: owner }))!.available).toBe(20);
  });

  it('allows a negative balance only where the policy says so', async () => {
    const { wallet } = build();
    await wallet.ensureWallet({
      ownerRef: owner,
      policy: { allowNegative: true, negativeFloor: 20 },
    });
    await wallet.credit({
      ownerRef: owner,
      amount: 5,
      kind: 'grant',
      source: 'plan',
      actor: 'test',
      reason: 'Small grant.',
      idempotencyKey: key('small'),
    });
    // 5 available, floor of 20 means 25 may be spent.
    await wallet.charge({
      ownerRef: owner,
      amount: 20,
      source: 'usage',
      actor: 'meter',
      reason: 'Into the credit line.',
      idempotencyKey: key('creditline'),
    });
    expect((await wallet.wallet({ ownerRef: owner }))!.available).toBe(-15);
    await expect(
      wallet.charge({
        ownerRef: owner,
        amount: 10,
        source: 'usage',
        actor: 'meter',
        reason: 'Past the floor.',
        idempotencyKey: key('past-floor'),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
  });
});

describe('refunds and reversals', () => {
  it('refunds a charge once, and never more than it charged', async () => {
    const { wallet } = await funded(40);
    const charge = await wallet.charge({
      ownerRef: owner,
      amount: 30,
      source: 'usage',
      actor: 'meter',
      reason: 'A job that later failed.',
      idempotencyKey: key('charged'),
    });

    await wallet.refund({
      ownerRef: owner,
      entryId: charge.entry.id,
      reason: 'The job failed after billing.',
      actor: 'operator:on-call',
      idempotencyKey: key('refund-one'),
    });
    let current = (await wallet.wallet({ ownerRef: owner }))!;
    expect({ ...pick(current) }).toEqual({ available: 40, reserved: 0, spent: 0 });

    // The same refund, retried: recognised, not repeated.
    const retried = await wallet.refund({
      ownerRef: owner,
      entryId: charge.entry.id,
      reason: 'The job failed after billing.',
      actor: 'operator:on-call',
      idempotencyKey: key('refund-one'),
    });
    expect(retried.created).toBe(false);

    // A second, distinct refund of the same charge has nothing left to give.
    await expect(
      wallet.refund({
        ownerRef: owner,
        entryId: charge.entry.id,
        reason: 'Trying to be paid twice.',
        actor: 'operator:on-call',
        idempotencyKey: key('refund-two'),
      }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_ORIGINAL' });

    current = (await wallet.wallet({ ownerRef: owner }))!;
    expect(current.available).toBe(40);
    expect(current.spent).toBe(0);
  });

  it('refuses a partial refund beyond what is left of the charge', async () => {
    const { wallet } = await funded(60);
    const charge = await wallet.charge({
      ownerRef: owner,
      amount: 50,
      source: 'usage',
      actor: 'meter',
      reason: 'A large job.',
      idempotencyKey: key('large'),
    });
    await wallet.refund({
      ownerRef: owner,
      entryId: charge.entry.id,
      amount: 40,
      reason: 'Most of it was not delivered.',
      actor: 'operator',
      idempotencyKey: key('partial'),
    });
    await expect(
      wallet.refund({
        ownerRef: owner,
        entryId: charge.entry.id,
        amount: 20,
        reason: 'More than remains.',
        actor: 'operator',
        idempotencyKey: key('partial-two'),
      }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_ORIGINAL' });
  });

  it('reverses a mistake exactly once', async () => {
    const { wallet } = await funded(20);
    const wrong = await wallet.charge({
      ownerRef: owner,
      amount: 15,
      source: 'usage',
      actor: 'meter',
      reason: 'Billed to the wrong wallet.',
      idempotencyKey: key('wrong'),
    });
    expect((await wallet.wallet({ ownerRef: owner }))!.available).toBe(5);

    await wallet.reverse({
      ownerRef: owner,
      entryId: wrong.entry.id,
      reason: 'Billed in error.',
      actor: 'operator',
    });
    expect((await wallet.wallet({ ownerRef: owner }))!.available).toBe(20);

    await expect(
      wallet.reverse({
        ownerRef: owner,
        entryId: wrong.entry.id,
        reason: 'Again.',
        actor: 'operator',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('refuses to refund credit that never left the wallet', async () => {
    const { wallet } = await funded(20);
    const grant = (await wallet.history({ ownerRef: owner }))[0]!;
    await expect(
      wallet.refund({
        ownerRef: owner,
        entryId: grant.id,
        reason: 'A grant is not a charge.',
        actor: 'operator',
        idempotencyKey: key('bad-refund'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('reservations', () => {
  it('settles a hold exactly once, however many requests try', async () => {
    const { wallet } = await funded(30);
    const hold = await wallet.reserve({
      ownerRef: owner,
      amount: 10,
      operationKey: key('once'),
      reason: 'Work starting.',
      actor: 'test',
    });

    const results = await Promise.allSettled([
      wallet.commitReservation({
        ownerRef: owner,
        reservationId: hold.reservation.id,
        amount: 10,
        reason: 'Finished.',
        actor: 'test',
      }),
      wallet.releaseReservation({
        ownerRef: owner,
        reservationId: hold.reservation.id,
        reason: 'Also finished.',
        actor: 'test',
      }),
    ]);
    const settled = results.filter((row) => row.status === 'fulfilled');
    expect(settled).toHaveLength(1);
    expect((await wallet.wallet({ ownerRef: owner }))!.reserved).toBe(0);
  });

  it('replays a hold instead of funding the same operation twice', async () => {
    const { wallet } = await funded(30);
    const first = await wallet.reserve({
      ownerRef: owner,
      amount: 10,
      operationKey: key('replay'),
      reason: 'First attempt.',
      actor: 'test',
    });
    const second = await wallet.reserve({
      ownerRef: owner,
      amount: 10,
      operationKey: key('replay'),
      reason: 'Retried request.',
      actor: 'test',
    });
    expect(second.reservation.id).toBe(first.reservation.id);
    expect((await wallet.wallet({ ownerRef: owner }))!.reserved).toBe(10);
  });

  it('releases an expired hold back to available', async () => {
    const { wallet } = await funded(15);
    const hold = await wallet.reserve({
      ownerRef: owner,
      amount: 15,
      operationKey: key('expire'),
      reason: 'Work that never reported back.',
      actor: 'test',
    });
    await wallet.expireReservation({ ownerRef: owner, reservationId: hold.reservation.id });
    const current = (await wallet.wallet({ ownerRef: owner }))!;
    expect({ ...pick(current) }).toEqual({ available: 15, reserved: 0, spent: 0 });
  });
});

describe('reconciliation and isolation', () => {
  it('reconciles stored balances against the ledger', async () => {
    const { wallet } = await funded(80);
    await wallet.charge({
      ownerRef: owner,
      amount: 25,
      source: 'usage',
      actor: 'meter',
      reason: 'A job.',
      idempotencyKey: key('recon-charge'),
    });
    const hold = await wallet.reserve({
      ownerRef: owner,
      amount: 5,
      operationKey: key('recon-hold'),
      reason: 'A worker.',
      actor: 'test',
    });
    await wallet.releaseReservation({
      ownerRef: owner,
      reservationId: hold.reservation.id,
      reason: 'Cancelled.',
      actor: 'test',
    });

    const report = await wallet.reconcile({ ownerRef: owner });
    expect(report.consistent).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.ledger).toEqual(report.stored);
    expect(report.ledger.available).toBe(55);
  });

  it('never shows one owner the other owner’s wallet or entries', async () => {
    const { wallet } = await funded(40);
    const other = 'owner-somebody-else';
    await expect(wallet.wallet({ ownerRef: other })).resolves.toBeNull();
    await expect(wallet.history({ ownerRef: other })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      wallet.charge({
        ownerRef: other,
        amount: 1,
        source: 'usage',
        actor: 'meter',
        reason: 'Not their wallet.',
        idempotencyKey: key('cross'),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await wallet.wallet({ ownerRef: owner }))!.available).toBe(40);
  });
});

describe('usage metering integration', () => {
  const record = {
    operationKey: 'job:abc:run',
    category: 'background_jobs' as const,
    quantity: 3,
    unit: 'calls',
    costBearer: 'veltravia' as const,
    status: 'recorded' as const,
    occurredAt: '2026-11-08T12:00:00.000Z',
    projectId: 'prj_1',
  };

  it('charges a billable metered event once, at the configured rate', async () => {
    const { wallet } = await funded(50);
    const first = await wallet.chargeUsage({ ownerRef: owner, record });
    expect(first.charged?.entry.amount).toBe(15); // 3 jobs x 5 credits
    expect(first.charged?.entry.referenceId).toBe('job:abc:run');

    const second = await wallet.chargeUsage({ ownerRef: owner, record });
    expect(second.charged?.created).toBe(false);
    expect((await wallet.wallet({ ownerRef: owner }))!.available).toBe(35);
  });

  it('never turns a user’s own provider spend into Veltravia credits', async () => {
    const { wallet } = await funded(50);
    const result = await wallet.chargeUsage({
      ownerRef: owner,
      record: {
        ...record,
        category: 'ai_provider',
        unit: 'tokens',
        quantity: 90_000,
        costBearer: 'user_provider',
      },
    });
    expect(result.skip).toMatchObject({ reason: 'user_pays_provider' });
    expect((await wallet.wallet({ ownerRef: owner }))!.available).toBe(50);
  });

  it('charges a managed provider call, which this platform does pay for', () => {
    const charge = chargeForUsage({
      ...record,
      category: 'ai_provider',
      unit: 'tokens',
      quantity: 5_000,
      costBearer: 'veltravia',
    });
    expect(isCharge(charge)).toBe(true);
    if (isCharge(charge)) expect(charge.credits).toBe(5); // 5k tokens at 1 per 1k
  });

  it('charges nothing for a record that is not billable, and says why', () => {
    expect(chargeForUsage({ ...record, status: 'excluded' })).toMatchObject({
      reason: 'not_recorded',
    });
    expect(chargeForUsage({ ...record, category: 'file_storage', unit: 'bytes' })).toMatchObject({
      reason: 'no_rate',
    });
  });

  it('reads rates from configuration and falls back rather than billing zero', () => {
    const custom = parseCreditRates(JSON.stringify({ background_jobs: { credits: 9, per: 1 } }));
    expect(custom.background_jobs).toEqual({ credits: 9, per: 1 });
    expect(parseCreditRates('not json')).toBe(DEFAULT_CREDIT_RATES);
    const charge = chargeForUsage(record, custom);
    expect(isCharge(charge) && charge.credits).toBe(27);
  });
});

function pick(wallet: { available: number; reserved: number; spent: number }) {
  return { available: wallet.available, reserved: wallet.reserved, spent: wallet.spent };
}
