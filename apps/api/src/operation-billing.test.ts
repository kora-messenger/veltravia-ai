import { describe, expect, it, vi } from 'vitest';

import { createOperationBilling } from './operation-billing.js';

/**
 * Operation billing (Step 55).
 *
 * The charge for a coding run or an agent execution must be one row, whatever the
 * number of model calls, and must never invent a number it was not given. These
 * tests stand in for the wallet so the accounting rules are proved on their own.
 */

const charge = (id: string, state: 'reserved' | 'exempt' = 'reserved') => ({
  id,
  state,
  estimatedCredits: 5,
  basis: 'flat',
  exempt: state === 'exempt',
  policyId: 'paid.coding',
});

function fakeService() {
  const reserved: Record<string, unknown>[] = [];
  const committed: Record<string, unknown>[] = [];
  const released: Record<string, unknown>[] = [];
  let next = 1;
  const service = {
    reserve: vi.fn(async (input: Record<string, unknown>) => {
      // The real store keys on (owner, idempotencyKey); the fake must too, or a
      // repeated begin would hand back a fresh charge instead of the first one.
      const existing = reserved.find(
        (row) => row.idempotencyKey === input.idempotencyKey && row.ownerRef === input.ownerRef,
      );
      const id = existing === undefined ? `mch_${next++}` : String(existing.__chargeId);
      if (existing === undefined) {
        Object.defineProperty(input, '__chargeId', { value: id, enumerable: false });
        reserved.push(input);
      }
      return {
        charge: charge(id),
        created: existing === undefined,
        estimate: {},
        reservationId: null,
      };
    }),
    commit: vi.fn(async (input: Record<string, unknown>) => {
      committed.push(input);
      return {
        charge: { id: input.chargeId },
        credits: 5,
        released: 0,
        aboveHold: 0,
        aboveHoldCovered: true,
      };
    }),
    release: vi.fn(async (input: Record<string, unknown>) => {
      released.push(input);
      return { id: input.chargeId, state: 'released' };
    }),
  };
  return { service, reserved, committed, released };
}

const ref = {
  ownerRef: 'owner-1',
  kind: 'coding.run' as const,
  operationId: 'run_abc',
  projectId: 'proj_1',
  workspaceId: 'ws_1',
};

describe('operation billing', () => {
  it('settles the tokens a call reported when the settlement carries extra metadata', async () => {
    // The provider call reports against the operation id it was given, which
    // carries no workspace; the settlement knows the workspace too. Keying the
    // tally on the workspace lost every call and charged a flat estimate.
    const { service, committed } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    await billing.begin(ref);
    billing.record(
      { ownerRef: ref.ownerRef, kind: ref.kind, operationId: ref.operationId },
      { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 400 },
    );
    billing.record(
      { ownerRef: ref.ownerRef, kind: ref.kind, operationId: ref.operationId },
      { inputTokens: 500, outputTokens: 100 },
    );

    const settled = await billing.settle(ref);
    expect(settled.calls).toBe(2);
    const measurement = (committed[0] as { measurement: Record<string, unknown> }).measurement;
    expect(measurement).toMatchObject({
      inputTokens: 1_500,
      outputTokens: 300,
      cachedTokens: 400,
      source: 'provider',
    });
  });

  it('holds once for an operation and settles one charge for every model call', async () => {
    const { service, reserved, committed } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    const ledger = await billing.begin(ref);
    ledger.record({ inputTokens: 1_000, outputTokens: 200, modelId: 'gpt-4o-mini' });
    ledger.record({ inputTokens: 2_000, outputTokens: 300, cachedInputTokens: 500 });

    const settlement = await billing.settle(ref);
    expect(settlement.settled).toBe(true);
    expect(settlement.credits).toBe(5);
    expect(reserved).toHaveLength(1);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      chargeId: 'mch_1',
      measurement: {
        inputTokens: 3_000,
        outputTokens: 500,
        cachedTokens: 500,
        source: 'provider',
      },
    });
  });

  it('keeps a number missing rather than turning it into a zero', async () => {
    const { service, committed } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    const ledger = await billing.begin(ref);
    ledger.record({ outputTokens: 120 });

    await billing.settle(ref);
    const measurement = committed[0].measurement as Record<string, unknown>;
    expect(measurement.inputTokens).toBeNull();
    expect(measurement.cachedTokens).toBeNull();
    expect(measurement.outputTokens).toBe(120);
    expect(measurement.source).toBe('unavailable');
  });

  it('settles an operation only once, even if two callers ask at the same time', async () => {
    const { service, committed } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    const ledger = await billing.begin(ref);
    ledger.record({ inputTokens: 900, outputTokens: 90 });

    const [first, second] = await Promise.all([billing.settle(ref), billing.settle(ref)]);
    expect(committed).toHaveLength(1);
    expect([first.settled, second.settled].filter(Boolean)).toHaveLength(1);
  });

  it('finds the first hold when the same operation starts twice', async () => {
    const { service, reserved } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    const first = await billing.begin(ref);
    const second = await billing.begin(ref);
    expect(reserved).toHaveLength(1);
    expect(second.chargeId).toBe(first.chargeId);
    expect(second.key).toBe(first.key);
  });

  it('releases the hold for an operation that is abandoned', async () => {
    const { service, released, committed } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    const ledger = await billing.begin(ref);
    ledger.record({ inputTokens: 10, outputTokens: 10 });
    await billing.abandon(ref, 'the coding run was cancelled');

    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      chargeId: 'mch_1',
      reason: 'the coding run was cancelled',
    });
    expect(committed).toHaveLength(0);
    expect(billing.size()).toBe(0);
  });

  it('records a usage report that arrives before the operation is opened', async () => {
    const { service, committed } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    billing.record(ref, { inputTokens: 400, outputTokens: 40 });
    const ledger = await billing.begin(ref);
    ledger.record({ inputTokens: 100, outputTokens: 10 });

    await billing.settle(ref);
    expect((committed[0].measurement as Record<string, number>).inputTokens).toBe(500);
  });

  it('does not charge an operation the plan exempts', async () => {
    const service = {
      reserve: vi.fn(async () => ({
        charge: charge('mch_exempt', 'exempt'),
        created: true,
        estimate: {},
        reservationId: null,
      })),
      commit: vi.fn(async (input: Record<string, unknown>) => ({
        charge: { id: input.chargeId },
        credits: 0,
        released: 0,
        aboveHold: 0,
        aboveHoldCovered: true,
      })),
      release: vi.fn(),
    };
    const billing = createOperationBilling({ messageCredits: service as never });

    const ledger = await billing.begin(ref);
    expect(ledger.exempt).toBe(true);
    ledger.record({ inputTokens: 10, outputTokens: 10 });
    await billing.settle(ref);
    // An exempt charge has no hold: nothing is settled and nothing is invented.
    expect(service.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeId: 'mch_exempt',
        measurement: expect.objectContaining({ inputTokens: 10, outputTokens: 10 }),
      }),
    );
  });

  it('reports no hold rather than charging when nothing was opened', async () => {
    const { service, committed } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    const settlement = await billing.settle(ref);
    expect(settlement.settled).toBe(false);
    expect(settlement.reason).toBe('no-hold');
    expect(committed).toHaveLength(0);
  });

  it('keeps one operation apart from another with the same id under a different kind', async () => {
    const { service, reserved } = fakeService();
    const billing = createOperationBilling({ messageCredits: service as never });

    await billing.begin(ref);
    await billing.begin({ ...ref, kind: 'agent.execution' });
    expect(reserved).toHaveLength(2);
    expect(billing.size()).toBe(2);
  });
});
