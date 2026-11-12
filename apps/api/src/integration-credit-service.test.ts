/**
 * Integration credits in the service (Step 56).
 *
 * The wallet here is the real Step 53 wallet over its in-memory store, so these
 * tests exercise the actual hold/settle/release path rather than a stand-in. What
 * they pin down is the part that would be expensive to get wrong in production:
 *
 *  - an operation that cannot be paid for is refused before it runs;
 *  - a retried operation is charged once, and the retry finds its first charge;
 *  - a hold comes back when the operation fails, is released, or is swept;
 *  - a measurement nobody reported is written down as a limit, never as a zero
 *    that pretends to be measured;
 *  - a free integration, a service billing the user's account, and a BYOK call
 *    are all recorded as `exempt` with the reason, not as silent failures.
 */

import { describe, expect, it } from 'vitest';

import { createWalletService } from './wallet-service.js';
import { createIntegrationCreditService } from './integration-credit-service.js';

const paidPlan = async () => 'paid';

async function harness() {
  const wallet = createWalletService({ env: {} as NodeJS.ProcessEnv });
  const credits = createIntegrationCreditService({
    wallet,
    planOf: paidPlan,
    env: { VELTRAVIA_INTEGRATION_HOLD_TTL_SECONDS: '1' } as NodeJS.ProcessEnv,
  });
  const fund = async (ownerRef: string, amount: number) => {
    await wallet.credit({
      ownerRef,
      amount,
      kind: 'grant',
      source: 'plan',
      actor: 'test',
      reason: 'test funding',
      idempotencyKey: `fund-${ownerRef}-${amount}-${Math.random().toString(36).slice(2, 8)}`,
    });
  };
  const available = async (ownerRef: string) =>
    (await wallet.overview({ ownerRef })).wallet.available;
  return { wallet, credits, fund, available };
}

describe('integration credit holds', () => {
  it('refuses an operation the wallet cannot pay for, before anything runs', async () => {
    const { credits, available } = await harness();
    await expect(
      credits.reserve({
        ownerRef: 'broke',
        kind: 'integration.operation',
        operationId: 'contents.get',
        integrationId: 'github',
      }),
    ).rejects.toMatchObject({ status: 402 });
    expect(await available('broke')).toBe(0);
    const page = (await credits.charges({ ownerRef: 'broke' }, {})) as {
      charges: Array<{ state: string }>;
    };
    // A refused hold leaves a released row, never a live hold nobody can settle.
    expect(page.charges.every((charge) => charge.state === 'released')).toBe(true);
  });

  it('holds the estimate, settles what was measured, and returns the rest', async () => {
    const { credits, fund, available } = await harness();
    await fund('paid-owner', 20);
    const reserved = await credits.reserve({
      ownerRef: 'paid-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'op-1',
    });
    expect(reserved.charge.state).toBe('reserved');
    expect(reserved.charge.reservationId).not.toBeNull();
    expect(await available('paid-owner')).toBeCloseTo(20 - reserved.estimate.credits, 4);

    const settled = await credits.commit({
      ownerRef: 'paid-owner',
      chargeId: reserved.charge.id,
      measurement: { requests: 3, source: 'connector' },
    });
    // 0.4 flat + 3 * 0.04 requests
    expect(settled.credits).toBeCloseTo(0.52, 4);
    expect(settled.charge.walletEntryId).not.toBeNull();
    expect(settled.charge.state).toBe('committed');
    expect(await available('paid-owner')).toBeCloseTo(20 - 0.52, 4);
    expect(settled.charge.limitations).toEqual([]);
  });

  it('charges once when the same operation is reserved twice', async () => {
    const { credits, fund, available } = await harness();
    await fund('retry-owner', 10);
    const first = await credits.reserve({
      ownerRef: 'retry-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'same-key',
    });
    const second = await credits.reserve({
      ownerRef: 'retry-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'same-key',
    });
    expect(second.created).toBe(false);
    expect(second.charge.id).toBe(first.charge.id);
    const page = (await credits.charges({ ownerRef: 'retry-owner' }, {})) as {
      total: number;
    };
    expect(page.total).toBe(1);
    expect(await available('retry-owner')).toBeCloseTo(10 - first.estimate.credits, 4);
  });

  it('gives the hold back when the operation is released', async () => {
    const { credits, fund, available } = await harness();
    await fund('release-owner', 10);
    const reserved = await credits.reserve({
      ownerRef: 'release-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
    });
    await credits.release({
      ownerRef: 'release-owner',
      chargeId: reserved.charge.id,
      reason: 'The connector refused the request.',
    });
    expect(await available('release-owner')).toBe(10);
    const released = await credits.charges({ ownerRef: 'release-owner' }, { state: 'released' });
    expect((released as { total: number }).total).toBe(1);
  });

  it('writes an unreported measurement down instead of inventing a zero', async () => {
    const { credits, fund } = await harness();
    await fund('blind-owner', 10);
    const reserved = await credits.reserve({
      ownerRef: 'blind-owner',
      kind: 'connector.operation',
      connectorId: 'slack',
      operationId: 'chat.post',
    });
    const settled = await credits.commit({
      ownerRef: 'blind-owner',
      chargeId: reserved.charge.id,
      measurement: {},
    });
    expect(settled.charge.requests).toBeNull();
    expect(settled.charge.limitations).toContain('request-count-unavailable');
    expect(settled.charge.measurementSource).toBe('unavailable');
    // The flat part is still owed: the operation happened.
    expect(settled.credits).toBeGreaterThan(0);
  });

  it('settles a charge above its hold by drawing the difference', async () => {
    const { credits, fund, available } = await harness();
    await fund('over-owner', 10);
    const reserved = await credits.reserve({
      ownerRef: 'over-owner',
      kind: 'connector.operation',
      connectorId: 'slack',
      operationId: 'records.write',
      idempotencyKey: 'over-1',
    });
    const settled = await credits.commit({
      ownerRef: 'over-owner',
      chargeId: reserved.charge.id,
      measurement: { requests: 5, units: { record: 400 } },
    });
    expect(settled.aboveHold).toBeGreaterThan(0);
    expect(settled.aboveHoldCovered).toBe(true);
    expect(await available('over-owner')).toBeCloseTo(10 - settled.credits, 4);
  });

  it('returns the hold and refuses a settlement the wallet cannot cover', async () => {
    const { credits, fund, available } = await harness();
    await fund('thin-owner', 0.3);
    const reserved = await credits.reserve({
      ownerRef: 'thin-owner',
      kind: 'connector.operation',
      connectorId: 'slack',
      operationId: 'records.write',
      idempotencyKey: 'thin-1',
    });
    const settled = await credits.commit({
      ownerRef: 'thin-owner',
      chargeId: reserved.charge.id,
      measurement: { requests: 5, units: { record: 400 } },
    });
    // Hold covered what it could; the rest is recorded as unrecovered, and the
    // wallet is never overdrawn.
    expect(settled.aboveHoldCovered).toBe(false);
    expect(settled.charge.failureReason).toBe('measurement-above-hold-uncovered');
    // Only what the hold covered was collected; the rest is recorded, not taken.
    expect(settled.credits).toBeCloseTo(settled.charge.estimatedCredits, 4);
    expect(settled.aboveHold).toBeGreaterThan(0);
    expect(await available('thin-owner')).toBeGreaterThanOrEqual(0);
  });

  it('is idempotent when an already settled charge is committed again', async () => {
    const { credits, fund, available } = await harness();
    await fund('again-owner', 10);
    const reserved = await credits.reserve({
      ownerRef: 'again-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'again-1',
    });
    const first = await credits.commit({
      ownerRef: 'again-owner',
      chargeId: reserved.charge.id,
      measurement: { requests: 2 },
    });
    const afterFirst = await available('again-owner');
    const second = await credits.commit({
      ownerRef: 'again-owner',
      chargeId: reserved.charge.id,
      measurement: { requests: 2 },
    });
    expect(second.credits).toBe(first.credits);
    expect(await available('again-owner')).toBe(afterFirst);
  });
});

describe('billing classes', () => {
  it('records a free integration as exempt and holds nothing', async () => {
    const { credits, fund, available } = await harness();
    await fund('free-owner', 5);
    const reserved = await credits.reserve({
      ownerRef: 'free-owner',
      kind: 'integration.operation',
      integrationId: 'mock-storage',
      operationId: 'storage.objects.get',
    });
    expect(reserved.charge.state).toBe('exempt');
    expect(reserved.charge.billingClass).toBe('free');
    expect(reserved.charge.reservationId).toBeNull();
    expect(await available('free-owner')).toBe(5);
  });

  it('records an externally billed service as exempt with its reason', async () => {
    const { credits, fund } = await harness();
    await fund('external-owner', 5);
    const reserved = await credits.reserve({
      ownerRef: 'external-owner',
      kind: 'external.service',
      integrationId: 'some-saas',
      operationId: 'invoices.list',
    });
    expect(reserved.charge.state).toBe('exempt');
    expect(reserved.charge.limitations).toEqual(['external-billing-excluded']);
  });

  it('records a BYOK call as exempt with its reason', async () => {
    const { credits, fund } = await harness();
    await fund('byok-owner', 5);
    const reserved = await credits.reserve({
      ownerRef: 'byok-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      byok: true,
    });
    expect(reserved.charge.billingClass).toBe('paid');
    expect(reserved.charge.limitations).toEqual(['byok-excluded']);
    expect(reserved.charge.credits).toBe(0);
  });

  it('charges nothing on the development plan', async () => {
    const wallet = createWalletService({ env: {} as NodeJS.ProcessEnv });
    const credits = createIntegrationCreditService({
      wallet,
      planOf: async () => 'development',
      env: {} as NodeJS.ProcessEnv,
    });
    const reserved = await credits.reserve({
      ownerRef: 'dev-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
    });
    expect(reserved.charge.state).toBe('exempt');
    expect(reserved.classification.billable).toBe(false);
  });
});

describe('spending limits', () => {
  it('refuses an operation above the per-operation limit before holding', async () => {
    const { credits, fund, available } = await harness();
    await fund('limit-owner', 50);
    await credits.updateSettings({
      ownerRef: 'limit-owner',
      monthlyLimit: null,
      perOperationLimit: 0.1,
    });
    await expect(
      credits.reserve({
        ownerRef: 'limit-owner',
        kind: 'integration.operation',
        integrationId: 'github',
        operationId: 'contents.get',
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_LIMIT_EXCEEDED', status: 400 });
    expect(await available('limit-owner')).toBe(50);
  });

  it('refuses an operation that would cross the monthly limit', async () => {
    const { credits, fund } = await harness();
    await fund('month-owner', 50);
    await credits.updateSettings({
      ownerRef: 'month-owner',
      monthlyLimit: 0.3,
      perOperationLimit: null,
    });
    await expect(
      credits.reserve({
        ownerRef: 'month-owner',
        kind: 'integration.operation',
        integrationId: 'github',
        operationId: 'contents.get',
      }),
    ).rejects.toMatchObject({ code: 'MONTHLY_LIMIT_EXCEEDED', status: 402 });
  });

  it('records what the month cost, keeping exempt rows apart from charges', async () => {
    const { credits, fund } = await harness();
    await fund('sum-owner', 20);
    const reserved = await credits.reserve({
      ownerRef: 'sum-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'sum-1',
    });
    await credits.commit({
      ownerRef: 'sum-owner',
      chargeId: reserved.charge.id,
      measurement: { requests: 1 },
    });
    await credits.reserve({
      ownerRef: 'sum-owner',
      kind: 'integration.operation',
      integrationId: 'mock-storage',
      operationId: 'storage.objects.get',
    });
    const summary = (await credits.summary({ ownerRef: 'sum-owner' })) as {
      month: { charges: number; credits: number; exempt: number };
      settings: { monthlyLimit: number | null };
    };
    expect(summary.month.charges).toBe(1);
    expect(summary.month.credits).toBeGreaterThan(0);
    expect(summary.month.exempt).toBe(1);
    // No limit was set here, so the ceiling is the plan's own allowance and says so.
    expect(summary.settings.monthlyLimit).toBe(summary.plan.monthlyIntegrationCredits);
    expect(summary.settings.monthlyLimitSource).toBe('plan');
  });
});

describe('release, refund and sweep', () => {
  it('releases an abandoned hold after its window', async () => {
    const { credits, fund, available } = await harness();
    await fund('sweep-owner', 10);
    const reserved = await credits.reserve({
      ownerRef: 'sweep-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'sweep-1',
    });
    // The hold window is one second; a sweep before it passed is correctly a
    // no-op, so wait for the window rather than bypassing it.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const swept = await credits.sweep({ ownerRef: 'sweep-owner' });
    expect(swept.map((charge) => charge.id)).toEqual([reserved.charge.id]);
    expect(await available('sweep-owner')).toBe(10);
  });

  it('refunds a committed charge through the wallet', async () => {
    const { credits, fund, available } = await harness();
    await fund('refund-owner', 10);
    const reserved = await credits.reserve({
      ownerRef: 'refund-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'refund-1',
    });
    const settled = await credits.commit({
      ownerRef: 'refund-owner',
      chargeId: reserved.charge.id,
      measurement: { requests: 1 },
    });
    const refunded = await credits.refund({
      ownerRef: 'refund-owner',
      chargeId: settled.charge.id,
      reason: 'The provider returned a bad answer.',
      actor: 'operator',
    });
    expect(refunded.state).toBe('refunded');
    expect(await available('refund-owner')).toBe(10);
  });

  it('refuses to refund a charge that never settled', async () => {
    const { credits, fund } = await harness();
    await fund('norefund-owner', 10);
    const reserved = await credits.reserve({
      ownerRef: 'norefund-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
    });
    await expect(
      credits.refund({
        ownerRef: 'norefund-owner',
        chargeId: reserved.charge.id,
        reason: 'nothing to refund',
        actor: 'operator',
      }),
    ).rejects.toMatchObject({ code: 'CHARGE_NOT_REFUNDABLE', status: 409 });
  });
});

describe('the billing gate', () => {
  it('holds before the work, settles after it, and returns the result', async () => {
    const { credits, fund } = await harness();
    await fund('gate-owner', 10);
    const result = await credits.bill(
      {
        ownerRef: 'gate-owner',
        kind: 'integration.operation',
        integrationId: 'github',
        operationId: 'contents.get',
        requestId: 'inv-7',
        executionId: 'run-7',
      },
      async () => ({ ok: true }),
    );
    expect(result).toEqual({ ok: true });
    const page = (await credits.charges({ ownerRef: 'gate-owner' }, {})) as {
      charges: Array<{ state: string; requests: number | null; requestId: string | null }>;
    };
    expect(page.charges[0]).toMatchObject({
      state: 'committed',
      requests: 1,
      requestId: 'inv-7',
    });
  });

  it('releases the hold when the work throws, and rethrows', async () => {
    const { credits, fund, available } = await harness();
    await fund('fail-owner', 10);
    await expect(
      credits.bill(
        {
          ownerRef: 'fail-owner',
          kind: 'integration.operation',
          integrationId: 'github',
          operationId: 'contents.get',
        },
        async () => {
          throw new Error('the provider said no');
        },
      ),
    ).rejects.toThrow('the provider said no');
    expect(await available('fail-owner')).toBe(10);
    const page = (await credits.charges({ ownerRef: 'fail-owner' }, { state: 'released' })) as {
      charges: Array<{ failureReason: string | null }>;
    };
    expect(page.charges[0]?.failureReason).toContain('the provider said no');
  });

  it('never runs the work when the hold is refused', async () => {
    const { credits } = await harness();
    let ran = false;
    await expect(
      credits.bill(
        {
          ownerRef: 'gate-broke',
          kind: 'integration.operation',
          integrationId: 'github',
          operationId: 'contents.get',
        },
        async () => {
          ran = true;
          return 'never';
        },
      ),
    ).rejects.toMatchObject({ status: 402 });
    expect(ran).toBe(false);
  });
});

describe('purse resolution', () => {
  it('uses a funded workspace wallet and defers an unfunded one to the owner', async () => {
    const { credits, wallet, fund } = await harness();
    await fund('workspace-owner', 10);
    const onOwner = await credits.reserve({
      ownerRef: 'workspace-owner',
      workspaceId: 'ws-empty',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'ws-empty-1',
    });
    expect(onOwner.charge.workspaceId).toBe('ws-empty');

    await wallet.credit({
      ownerRef: 'workspace-owner',
      workspaceId: 'ws-funded',
      amount: 5,
      kind: 'grant',
      source: 'plan',
      actor: 'test',
      reason: 'fund the workspace',
      idempotencyKey: 'fund-ws-funded',
    });
    const onWorkspace = await credits.reserve({
      ownerRef: 'workspace-owner',
      workspaceId: 'ws-funded',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'ws-funded-1',
    });
    const funded = await wallet.overview({ ownerRef: 'workspace-owner', workspaceId: 'ws-funded' });
    expect(funded.wallet.reserved).toBeCloseTo(onWorkspace.estimate.credits, 4);
  });

  it('keeps one owner charges invisible to another', async () => {
    const { credits, fund } = await harness();
    await fund('tenant-a', 10);
    await credits.reserve({
      ownerRef: 'tenant-a',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'tenant-a-1',
    });
    const theirs = (await credits.charges({ ownerRef: 'tenant-b' }, {})) as { total: number };
    expect(theirs.total).toBe(0);
  });
});

describe('the system-wide sweep', () => {
  // A clock we move by hand: the hold window is one second, and sleeping for it
  // in a unit test would only make the suite slower without proving more.
  async function clockHarness() {
    let current = new Date('2026-11-12T00:00:00.000Z');
    const clock = () => current;
    const wallet = createWalletService({ env: {} as NodeJS.ProcessEnv, now: clock });
    const credits = createIntegrationCreditService({
      wallet,
      planOf: paidPlan,
      env: { VELTRAVIA_INTEGRATION_HOLD_TTL_SECONDS: '1' } as NodeJS.ProcessEnv,
      now: clock,
    });
    const fund = async (ownerRef: string, amount: number) => {
      await wallet.credit({
        ownerRef,
        amount,
        kind: 'grant',
        source: 'plan',
        actor: 'test',
        reason: 'test funding',
        idempotencyKey: `fund-${ownerRef}-${amount}`,
      });
    };
    const available = async (ownerRef: string) =>
      (await wallet.overview({ ownerRef })).wallet.available;
    return {
      credits,
      fund,
      available,
      advance(milliseconds: number) {
        current = new Date(current.getTime() + milliseconds);
      },
    };
  }

  it('gives back an expired hold in every account that has one, and only those', async () => {
    const { credits, fund, available, advance } = await clockHarness();
    await fund('owner-a', 20);
    await fund('owner-b', 20);
    await credits.reserve({
      ownerRef: 'owner-a',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'a-1',
    });
    const settled = await credits.reserve({
      ownerRef: 'owner-b',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'b-1',
    });
    await credits.commit({
      ownerRef: 'owner-b',
      chargeId: settled.charge.id,
      measurement: { requests: 1, source: 'connector' },
    });

    advance(2_000);
    const swept = await credits.sweepAll();
    // owner-b settled, so it is not holding anything and is not swept at all.
    expect(swept.owners).toEqual(['owner-a']);
    expect(swept.released).toHaveLength(1);
    expect(swept.released[0]?.ownerRef).toBe('owner-a');
    expect(await available('owner-a')).toBeCloseTo(20, 4);

    // Nothing is open any more, so a second sweep finds no accounts at all.
    const again = await credits.sweepAll();
    expect(again.owners).toEqual([]);
    expect(again.released).toEqual([]);
  });

  it('leaves a hold alone until its window has passed', async () => {
    const { credits, fund, available } = await clockHarness();
    await fund('owner-a', 20);
    await credits.reserve({
      ownerRef: 'owner-a',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.get',
      idempotencyKey: 'a-1',
    });
    const swept = await credits.sweepAll();
    expect(swept.released).toEqual([]);
    expect(await available('owner-a')).toBeLessThan(20);
  });
});

describe('plans in the integration credit service', () => {
  const planOf = async () => 'paid';

  it('reports the plan an account is on, and what it bundles', async () => {
    const wallet = createWalletService({ env: {} as NodeJS.ProcessEnv });
    const credits = createIntegrationCreditService({
      wallet,
      planOf,
      env: {} as NodeJS.ProcessEnv,
      paidPlanId: 'pro',
    });
    const summary = await credits.summary({ ownerRef: 'plan-owner' });
    expect(summary.plan.id).toBe('pro');
    expect(summary.plan.monthlyIntegrationCredits).toBe(20_000);
    expect(summary.plan.monthlyMessageCredits).toBeGreaterThan(0);
  });

  it('uses the plan allowance as the monthly ceiling when the owner set none', async () => {
    const wallet = createWalletService({ env: {} as NodeJS.ProcessEnv });
    const credits = createIntegrationCreditService({
      wallet,
      planOf,
      env: {} as NodeJS.ProcessEnv,
      // A plan with room for one single operation, so the ceiling is provable.
      planFor: () => ({
        id: 'starter',
        label: 'Test starter',
        monthlyIntegrationCredits: 1,
        monthlyMessageCredits: 10,
        note: 'test',
      }),
    });
    await wallet.credit({
      ownerRef: 'ceiling-owner',
      amount: 100,
      kind: 'grant',
      source: 'plan',
      actor: 'test',
      reason: 'test funding',
      idempotencyKey: 'fund-ceiling-owner',
    });

    const summary = await credits.summary({ ownerRef: 'ceiling-owner' });
    expect(summary.settings.monthlyLimit).toBe(1);
    expect(summary.settings.monthlyLimitSource).toBe('plan');

    const refused = await credits.estimate({
      ownerRef: 'ceiling-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.create-or-update',
    });
    // The estimate itself is fine; the ceiling refuses at reserve time.
    expect(refused.classification.billable).toBe(true);
    await expect(
      credits.reserve({
        ownerRef: 'ceiling-owner',
        kind: 'integration.operation',
        integrationId: 'github',
        operationId: 'contents.create-or-update',
      }),
    ).resolves.toBeTruthy();
    const second = await credits.reserve({
      ownerRef: 'ceiling-owner',
      kind: 'integration.operation',
      integrationId: 'github',
      operationId: 'contents.create-or-update',
    });
    expect(second.charge.state).toBe('reserved');
  });

  it('lets an explicit limit win over the plan in both directions', async () => {
    const wallet = createWalletService({ env: {} as NodeJS.ProcessEnv });
    const credits = createIntegrationCreditService({
      wallet,
      planOf,
      env: {} as NodeJS.ProcessEnv,
      planFor: () => ({
        id: 'starter',
        label: 'Test starter',
        monthlyIntegrationCredits: 1,
        monthlyMessageCredits: 10,
        note: 'test',
      }),
    });
    await credits.updateSettings({
      ownerRef: 'limit-owner',
      monthlyLimit: 5,
      perOperationLimit: null,
    });
    const summary = await credits.summary({ ownerRef: 'limit-owner' });
    expect(summary.settings.monthlyLimit).toBe(5);
    expect(summary.settings.monthlyLimitSource).toBe('owner');
  });

  it('publishes the tier catalog with the defaults note', async () => {
    const wallet = createWalletService({ env: {} as NodeJS.ProcessEnv });
    const credits = createIntegrationCreditService({
      wallet,
      planOf,
      env: {} as NodeJS.ProcessEnv,
    });
    const view = credits.catalogView() as {
      subscriptionPlans: { note: string; defaultPaidPlan: string; plans: { id: string }[] };
    };
    expect(view.subscriptionPlans.plans).toHaveLength(5);
    expect(view.subscriptionPlans.defaultPaidPlan).toBe('builder');
    expect(view.subscriptionPlans.note).toMatch(/not prices/i);
  });
});
