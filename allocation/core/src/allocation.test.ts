import { describe, expect, it } from 'vitest';

import { AllocationBook } from './book.js';
import { InMemoryAllocationStore } from './memory.js';
import { distribute } from './policies.js';
import { AllocationError } from './types.js';

const owner = 'owner-1';
const workspace = 'ws-1';

function book(): AllocationBook {
  let tick = 0;
  return new AllocationBook({
    store: new InMemoryAllocationStore(),
    now: () => new Date(Date.parse('2026-11-14T10:00:00.000Z') + tick++ * 1000),
    newId: (() => {
      let id = 0;
      return () => `alc_${++id}`;
    })(),
  });
}

async function withPool(target: AllocationBook, total = 10_000, category = 'ai_tokens' as const) {
  await target.setPool({
    ownerRef: owner,
    workspaceId: workspace,
    category,
    total,
    actor: 'ijezie',
    reason: 'Monthly allowance',
  });
}

describe('the allocation book', () => {
  it('refuses an allocation before the workspace has a pool', async () => {
    const allocations = book();
    await expect(
      allocations.allocate({
        ownerRef: owner,
        workspaceId: workspace,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: 'prj_1',
        amount: 500,
        actor: 'ijezie',
        reason: 'project budget',
      }),
    ).rejects.toMatchObject({ code: 'POOL_NOT_SET' });
  });

  it('never allocates more than the pool holds', async () => {
    const allocations = book();
    await withPool(allocations, 1_000);
    await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 800,
      actor: 'ijezie',
      reason: 'project budget',
    });
    const error = await allocations
      .allocate({
        ownerRef: owner,
        workspaceId: workspace,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: 'prj_2',
        amount: 300,
        actor: 'ijezie',
        reason: 'second project',
      })
      .catch((caught: unknown) => caught as AllocationError);
    expect(error).toBeInstanceOf(AllocationError);
    expect((error as AllocationError).code).toBe('POOL_EXCEEDED');
    expect((error as AllocationError).details['available']).toBe(200);
  });

  it('keeps the two credit categories apart', async () => {
    const allocations = book();
    await withPool(allocations, 1_000, 'ai_tokens');
    await withPool(allocations, 50, 'integration_credits');
    await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'integration_credits',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 50,
      actor: 'ijezie',
      reason: 'connector work',
    });
    // The AI-token pool is untouched by an integration allocation.
    const summary = await allocations.summary({ ownerRef: owner, workspaceId: workspace });
    const ai = summary.categories.find((entry) => entry.category === 'ai_tokens');
    const integration = summary.categories.find(
      (entry) => entry.category === 'integration_credits',
    );
    expect(ai?.pool.allocated).toBe(0);
    expect(ai?.pool.available).toBe(1_000);
    expect(integration?.pool.available).toBe(0);
  });

  it('reserves, settles and releases without moving the workspace wallet', async () => {
    const allocations = book();
    await withPool(allocations);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 1_000,
      actor: 'ijezie',
      reason: 'project budget',
    });
    await allocations.reserve({
      ownerRef: owner,
      allocationId: allocation.id,
      amount: 400,
      operationKey: 'op-1',
      operationKind: 'chat.message',
      actor: 'system',
      reason: 'chat turn',
    });
    let summary = await allocations.summary({ ownerRef: owner, workspaceId: workspace });
    let row = summary.categories[0]!.allocations[0]!;
    expect(row.reserved).toBe(400);
    expect(row.available).toBe(600);

    await allocations.settle({
      ownerRef: owner,
      allocationId: allocation.id,
      amount: 250,
      operationKey: 'op-1',
      actor: 'system',
      reason: 'chat turn settled',
    });
    await allocations.release({
      ownerRef: owner,
      allocationId: allocation.id,
      amount: 150,
      operationKey: 'op-1',
      actor: 'system',
      reason: 'unused hold released',
    });
    summary = await allocations.summary({ ownerRef: owner, workspaceId: workspace });
    row = summary.categories[0]!.allocations[0]!;
    expect(row.consumed).toBe(250);
    expect(row.reserved).toBe(0);
    expect(row.available).toBe(750);
  });

  it('refuses a reservation larger than what is left', async () => {
    const allocations = book();
    await withPool(allocations);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 100,
      actor: 'ijezie',
      reason: 'small budget',
    });
    const error = await allocations
      .reserve({
        ownerRef: owner,
        allocationId: allocation.id,
        amount: 101,
        operationKey: 'op-1',
        operationKind: 'chat.message',
        actor: 'system',
        reason: 'too big',
      })
      .catch((caught: unknown) => caught as AllocationError);
    expect((error as AllocationError).code).toBe('ALLOCATION_EXHAUSTED');
  });

  it('answers a repeated reservation once', async () => {
    const allocations = book();
    await withPool(allocations);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 500,
      actor: 'ijezie',
      reason: 'project budget',
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await allocations.reserve({
        ownerRef: owner,
        allocationId: allocation.id,
        amount: 100,
        operationKey: 'op-repeat',
        operationKind: 'chat.message',
        actor: 'system',
        reason: 'chat turn',
      });
    }
    const summary = await allocations.summary({ ownerRef: owner, workspaceId: workspace });
    expect(summary.categories[0]!.allocations[0]!.reserved).toBe(100);
  });

  it('cannot reduce an allocation below what is already spent or held', async () => {
    const allocations = book();
    await withPool(allocations);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 1_000,
      actor: 'ijezie',
      reason: 'project budget',
    });
    await allocations.reserve({
      ownerRef: owner,
      allocationId: allocation.id,
      amount: 400,
      operationKey: 'op-1',
      operationKind: 'chat.message',
      actor: 'system',
      reason: 'chat turn',
    });
    const error = await allocations
      .reduce({
        ownerRef: owner,
        allocationId: allocation.id,
        amount: 700,
        actor: 'ijezie',
        reason: 'trim the budget',
      })
      .catch((caught: unknown) => caught as AllocationError);
    expect((error as AllocationError).code).toBe('INVALID_AMOUNT');
    expect((error as AllocationError).details['reclaimable']).toBe(600);
  });

  it('reclaims unspent credit back to the pool', async () => {
    const allocations = book();
    await withPool(allocations, 1_000);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 600,
      actor: 'ijezie',
      reason: 'project budget',
    });
    await allocations.reclaim({
      ownerRef: owner,
      allocationId: allocation.id,
      actor: 'ijezie',
      reason: 'project finished',
    });
    const summary = await allocations.summary({ ownerRef: owner, workspaceId: workspace });
    expect(summary.categories[0]!.pool.available).toBe(1_000);
    expect(summary.categories[0]!.allocations[0]!.allocated).toBe(0);
  });

  it('expires a temporary allocation and returns its credit to the pool', async () => {
    let now = Date.parse('2026-11-14T10:00:00.000Z');
    const allocations = new AllocationBook({
      store: new InMemoryAllocationStore(),
      now: () => new Date(now),
    });
    await withPool(allocations, 500);
    await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'agent',
      targetRef: 'agent-1',
      amount: 500,
      policy: 'temporary',
      expiresAt: '2026-11-14T11:00:00.000Z',
      actor: 'ijezie',
      reason: 'a burst for one agent',
    });
    now = Date.parse('2026-11-14T12:00:00.000Z');
    const summary = await allocations.summary({ ownerRef: owner, workspaceId: workspace });
    expect(summary.categories[0]!.pool.available).toBe(500);
    expect(summary.categories[0]!.allocations[0]!.state).toBe('expired');
  });

  it('refuses work on a restricted allocation for an unlisted operation', async () => {
    const allocations = book();
    await withPool(allocations);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 300,
      policy: 'restricted',
      allowedOperations: ['chat.message'],
      actor: 'ijezie',
      reason: 'chat only',
    });
    const error = await allocations
      .reserve({
        ownerRef: owner,
        allocationId: allocation.id,
        amount: 10,
        operationKey: 'op-coding',
        operationKind: 'coding.run',
        actor: 'system',
        reason: 'coding run',
      })
      .catch((caught: unknown) => caught as AllocationError);
    expect((error as AllocationError).code).toBe('OPERATION_NOT_ALLOWED');
  });

  it('authorises against the project allowance and refuses over budget', async () => {
    const allocations = book();
    await withPool(allocations);
    await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 200,
      actor: 'ijezie',
      reason: 'project budget',
    });
    const first = await allocations.authorize({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      amount: 150,
      operationKey: 'op-a',
      operationKind: 'chat.message',
      projectId: 'prj_1',
    });
    expect(first.allowed).toBe(true);
    expect(first.allocationId).not.toBeNull();

    const second = await allocations.authorize({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      amount: 150,
      operationKey: 'op-b',
      operationKind: 'chat.message',
      projectId: 'prj_1',
    });
    expect(second.allowed).toBe(false);
    expect(second.code).toBe('ALLOCATION_EXHAUSTED');

    // A different project has no allowance, so the workspace balance is the check.
    const other = await allocations.authorize({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      amount: 150,
      operationKey: 'op-c',
      operationKind: 'chat.message',
      projectId: 'prj_2',
    });
    expect(other.allowed).toBe(true);
    expect(other.allocationId).toBeNull();
  });

  it('answers two concurrent reservations without both taking the last credit', async () => {
    const allocations = book();
    await withPool(allocations);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 100,
      actor: 'ijezie',
      reason: 'exactly one job',
    });
    const outcomes = await Promise.allSettled([
      allocations.reserve({
        ownerRef: owner,
        allocationId: allocation.id,
        amount: 80,
        operationKey: 'op-1',
        operationKind: 'chat.message',
        actor: 'system',
        reason: 'first',
      }),
      allocations.reserve({
        ownerRef: owner,
        allocationId: allocation.id,
        amount: 80,
        operationKey: 'op-2',
        operationKind: 'chat.message',
        actor: 'system',
        reason: 'second',
      }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const summary = await allocations.summary({ ownerRef: owner, workspaceId: workspace });
    expect(summary.categories[0]!.allocations[0]!.reserved).toBe(80);
  });

  it('refuses a duplicate live allocation for the same target', async () => {
    const allocations = book();
    await withPool(allocations);
    await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 100,
      actor: 'ijezie',
      reason: 'project budget',
    });
    await expect(
      allocations.allocate({
        ownerRef: owner,
        workspaceId: workspace,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: 'prj_1',
        amount: 100,
        actor: 'ijezie',
        reason: 'again',
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('will not shrink the pool below what is already allocated', async () => {
    const allocations = book();
    await withPool(allocations, 1_000);
    await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 700,
      actor: 'ijezie',
      reason: 'project budget',
    });
    await expect(
      allocations.setPool({
        ownerRef: owner,
        workspaceId: workspace,
        category: 'ai_tokens',
        total: 500,
        actor: 'ijezie',
        reason: 'shrink',
      }),
    ).rejects.toMatchObject({ code: 'POOL_EXCEEDED' });
  });

  it('opens an automatic allowance up to the configured ceiling', async () => {
    const allocations = book();
    await withPool(allocations, 1_000);
    await allocations.setPolicy({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      defaultPolicy: 'automatic',
      autoLimit: 400,
      maxTargetSharePct: 100,
      actor: 'ijezie',
      reason: 'let projects open a small allowance',
    });
    const decision = await allocations.authorize({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      amount: 250,
      operationKey: 'op-auto',
      operationKind: 'chat.message',
      projectId: 'prj_9',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.targetRef).toBe('prj_9');
  });

  it('records history for every movement', async () => {
    const allocations = book();
    await withPool(allocations, 1_000);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 400,
      actor: 'ijezie',
      reason: 'project budget',
    });
    await allocations.reserve({
      ownerRef: owner,
      allocationId: allocation.id,
      amount: 100,
      operationKey: 'op-1',
      operationKind: 'chat.message',
      actor: 'system',
      reason: 'chat turn',
    });
    const events = await allocations.history({ ownerRef: owner, workspaceId: workspace });
    expect(events.map((event) => event.kind)).toEqual(['reserved', 'allocated', 'pool_set']);
  });

  it('never shows another owner an allocation', async () => {
    const allocations = book();
    await withPool(allocations);
    const allocation = await allocations.allocate({
      ownerRef: owner,
      workspaceId: workspace,
      category: 'ai_tokens',
      targetKind: 'project',
      targetRef: 'prj_1',
      amount: 100,
      actor: 'ijezie',
      reason: 'project budget',
    });
    expect(await allocations.get('someone-else', allocation.id)).toBeNull();
    await expect(
      allocations.increase({
        ownerRef: 'someone-else',
        allocationId: allocation.id,
        amount: 10,
        actor: 'intruder',
        reason: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'ALLOCATION_NOT_FOUND' });
  });
});

describe('allocation policies', () => {
  it('splits a budget exactly, with the remainder on the first target', () => {
    const result = distribute({
      policy: 'equal',
      budget: 1_000,
      category: 'ai_tokens',
      targets: [
        { kind: 'project', ref: 'a' },
        { kind: 'project', ref: 'b' },
        { kind: 'project', ref: 'c' },
      ],
    });
    expect(result.planned.map((entry) => entry.amount)).toEqual([333.3334, 333.3333, 333.3333]);
    expect(result.unallocated).toBe(0);
  });

  it('funds in priority order', () => {
    const result = distribute({
      policy: 'priority',
      budget: 900,
      category: 'ai_tokens',
      targets: [
        { kind: 'project', ref: 'low', priority: 1 },
        { kind: 'project', ref: 'high', priority: 9 },
      ],
    });
    expect(result.planned[0]!.target.ref).toBe('high');
    expect(result.planned[0]!.amount).toBe(450);
  });

  it('respects a per-target ceiling', () => {
    const result = distribute({
      policy: 'equal',
      budget: 1_000,
      category: 'ai_tokens',
      targets: [
        { kind: 'project', ref: 'a', limit: 100 },
        { kind: 'project', ref: 'b' },
      ],
    });
    expect(result.planned[0]!.amount).toBe(100);
    expect(result.planned[1]!.amount).toBe(500);
    expect(result.unallocated).toBe(400);
  });

  it('refuses to distribute under the manual policy', () => {
    expect(() =>
      distribute({
        policy: 'manual',
        budget: 100,
        category: 'ai_tokens',
        targets: [{ kind: 'project', ref: 'a' }],
      }),
    ).toThrow(/manual policy/i);
  });
});
