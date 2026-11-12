/**
 * Unified billing (Step 57).
 *
 * The claim under test is narrow and important: an operation either passes one
 * gate or it does not run, and a refusal names what is missing without touching
 * the caller's work. These tests use the real wallet, the real charging catalog,
 * the real operation ledger and the real usage meter - only the provider is
 * absent, because no provider is involved in deciding whether work may start.
 */

import { describe, expect, it } from 'vitest';

import { createInfrastructureMetering } from './infrastructure-metering.js';
import { createMessageCreditService } from './message-credit-service.js';
import { createOperationBilling } from './operation-billing.js';
import { createUsageService } from './usage-service.js';
import {
  BILLING_OPERATIONS,
  billingErrorBody,
  createUnifiedBilling,
  isBillingRefusal,
} from './unified-billing.js';
import { createWalletService } from './wallet-service.js';

const paidEnv = { VELTRAVIA_DEPLOYMENT_MODE: 'production' } as NodeJS.ProcessEnv;

function harness(options: { plan?: string; funded?: number } = {}) {
  const now = () => new Date('2026-11-12T10:00:00.000Z');
  const wallet = createWalletService({ env: paidEnv, now });
  const usage = createUsageService({ env: paidEnv, now });
  const messageCredits = createMessageCreditService({
    env: paidEnv,
    wallet,
    planOf: async () => options.plan ?? 'paid',
    now,
  });
  const operationBilling = createOperationBilling({ messageCredits });
  const billing = createUnifiedBilling({ messageCredits, operationBilling, wallet, now });
  const metering = createInfrastructureMetering({ usage, now });
  return { wallet, usage, messageCredits, operationBilling, billing, metering };
}

const fund = async (
  wallet: ReturnType<typeof createWalletService>,
  ownerRef: string,
  amount: number,
) => {
  await wallet.credit({
    ownerRef,
    amount,
    kind: 'grant',
    reason: 'test grant',
    actor: 'test',
    idempotencyKey: `grant:${ownerRef}:${amount}`,
  });
};

describe('the operation registry', () => {
  it('names every operation with a treatment and a reason, and never leaves one blank', () => {
    expect(BILLING_OPERATIONS.length).toBeGreaterThanOrEqual(8);
    for (const entry of BILLING_OPERATIONS) {
      expect(entry.operation.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(20);
      expect(entry.attribution.length).toBeGreaterThan(0);
      // A credit-billed operation must name the interaction kind it is priced by;
      // anything else must say why it is not charged.
      if (entry.treatment === 'charged' && entry.operation !== 'connector') {
        expect(entry.kind).not.toBeNull();
      }
    }
  });

  it('marks the lanes that are metered or exempt instead of pretending they are free', () => {
    const byId = new Map(BILLING_OPERATIONS.map((entry) => [entry.operation, entry]));
    expect(byId.get('background-job')?.treatment).toBe('metered');
    expect(byId.get('document-job')?.treatment).toBe('byok-exempt');
    expect(byId.get('intelligence-synthesis')?.treatment).toBe('byok-exempt');
    expect(byId.get('reasoning')?.kind).toBe('reasoning.run');
    expect(byId.get('agent-run')?.kind).toBe('agent.run');
  });

  it('refuses an operation nobody registered, rather than billing it opaquely', async () => {
    const { billing } = harness();
    await expect(
      billing.open({
        ownerRef: 'owner-a',
        kind: 'chat.message',
        operationId: 'x1',
        // @ts-expect-error - deliberately not a registered operation id
        operation: 'mystery-work',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isBillingRefusal(error)).toBe(true);
      const body = billingErrorBody(error);
      expect(body.status).toBe(400);
      expect(body.body.error.code).toBe('BILLING_UNKNOWN_OPERATION');
      return true;
    });
  });
});

describe('a refusal before any work happens', () => {
  it('blocks a paid operation at a zero balance and says what is missing', async () => {
    const { billing, wallet } = harness();
    const before = await wallet.overview({ ownerRef: 'broke-owner' });

    const error = await billing
      .open({ ownerRef: 'broke-owner', kind: 'reasoning.run', operationId: 'run-1', operation: 'reasoning' })
      .then(
        () => null,
        (refusal: unknown) => refusal,
      );

    expect(error).not.toBeNull();
    expect(isBillingRefusal(error)).toBe(true);
    const body = billingErrorBody(error);
    expect(body.status).toBe(402);
    expect(body.body.error.code).toBe('BILLING_INSUFFICIENT_CREDITS');
    const details = body.body.error.details ?? {};
    expect(details['operation']).toBe('reasoning');
    expect(details['operationLabel']).toBe('Reasoning run');
    expect(Number(details['requiredCredits'])).toBeGreaterThan(0);
    expect(Array.isArray(details['preserved'])).toBe(true);

    // Nothing was reserved by the refusal, so the wallet is exactly as it was.
    const after = await wallet.overview({ ownerRef: 'broke-owner' });
    expect(after.wallet.available).toBe(before.wallet.available);
    expect(after.wallet.reserved).toBe(before.wallet.reserved);
  });

  it('lets the same operation through once the balance covers it', async () => {
    const { billing, wallet } = harness();
    await fund(wallet, 'funded-owner', 100);

    const handle = await billing.open({
      ownerRef: 'funded-owner',
      kind: 'reasoning.run',
      operationId: 'run-ok',
      operation: 'reasoning',
      projectId: 'prj_1',
    });
    expect(handle.chargeId).not.toBeNull();
    expect(handle.treatment).toBe('charged');

    const held = await wallet.overview({ ownerRef: 'funded-owner' });
    expect(held.wallet.reserved).toBeGreaterThan(0);

    const settlement = await handle.settle();
    expect(settlement.settled).toBe(true);
    expect(settlement.credits).toBeGreaterThan(0);

    const after = await wallet.overview({ ownerRef: 'funded-owner' });
    expect(after.wallet.reserved).toBe(0);
    expect(after.wallet.spent).toBeGreaterThan(0);
  });

  it('releases the hold of an operation that never ran', async () => {
    const { billing, wallet } = harness();
    await fund(wallet, 'release-owner', 100);
    const handle = await billing.open({
      ownerRef: 'release-owner',
      kind: 'agent.run',
      operationId: 'agent-1',
      operation: 'agent-run',
    });
    await handle.release('the run was cancelled');

    const after = await wallet.overview({ ownerRef: 'release-owner' });
    expect(after.wallet.reserved).toBe(0);
    expect(after.wallet.spent).toBe(0);
    expect(after.wallet.available).toBe(100);
  });

  it('does not charge an operation twice for a repeated operation id', async () => {
    const { billing, wallet } = harness();
    await fund(wallet, 'retry-owner', 100);

    const first = await billing.open({
      ownerRef: 'retry-owner',
      kind: 'agent.run',
      operationId: 'same-run',
      operation: 'agent-run',
    });
    const second = await billing.open({
      ownerRef: 'retry-owner',
      kind: 'agent.run',
      operationId: 'same-run',
      operation: 'agent-run',
    });
    expect(second.chargeId).toBe(first.chargeId);

    await first.settle();
    const settledAgain = await second.settle();
    expect(settledAgain.settled).toBe(false);
    expect(settledAgain.reason).toBe('already-settled');
  });
});

describe('lanes that are not charged in credits', () => {
  it('hands back an exempt handle for BYOK-only work and records nothing', async () => {
    const { billing, wallet } = harness();
    const handle = await billing.open({
      ownerRef: 'doc-owner',
      kind: 'chat.message',
      operationId: 'job-1',
      operation: 'document-job',
    });
    expect(handle.chargeId).toBeNull();
    expect(handle.exempt).toBe(true);
    const settlement = await handle.settle();
    expect(settlement.settled).toBe(false);
    expect(settlement.reason).toContain('byok-exempt');

    const view = await wallet.overview({ ownerRef: 'doc-owner' });
    expect(view.wallet.reserved).toBe(0);
  });

  it('never blocks an exempt operation on a zero balance', async () => {
    const { billing } = harness();
    const handle = await billing.open({
      ownerRef: 'broke-owner',
      kind: 'chat.message',
      operationId: 'job-2',
      operation: 'intelligence-synthesis',
    });
    expect(handle.exempt).toBe(true);
  });
});

describe('reconciliation across lanes', () => {
  it('reports a clean account as consistent and counts open holds', async () => {
    const { billing, wallet } = harness();
    await fund(wallet, 'clean-owner', 50);
    const handle = await billing.open({
      ownerRef: 'clean-owner',
      kind: 'reasoning.run',
      operationId: 'rec-1',
      operation: 'reasoning',
    });

    const open = await billing.reconcile('clean-owner');
    expect(open.consistent).toBe(true);
    expect(open.stranding.openHolds).toBe(1);
    expect(open.stranding.oldestHeldAt).not.toBeNull();

    await handle.settle();
    const closed = await billing.reconcile('clean-owner');
    expect(closed.consistent).toBe(true);
    expect(closed.stranding.openHolds).toBe(0);
    expect(closed.messageCharges.chargesWithoutEntry).toBe(0);
  });

  it('publishes what it checked, so a clean result is not an empty claim', async () => {
    const { billing } = harness();
    const report = await billing.reconcile('quiet-owner');
    expect(report.checked.length).toBeGreaterThanOrEqual(4);
    expect(report.at).toMatch(/T/);
    expect(report.wallet.problems).toEqual([]);
  });
});

describe('capabilities', () => {
  it('lists the lanes and the gaps instead of claiming full coverage', async () => {
    const { billing } = harness();
    const view = billing.capabilities();
    expect(view.lanes.length).toBeGreaterThanOrEqual(5);
    expect(view.operations.length).toBe(BILLING_OPERATIONS.length);
    // Today there is no unwired operation; the field exists so a future gap is
    // published rather than hidden.
    expect(Array.isArray(view.gaps)).toBe(true);
  });
});
