/**
 * The arithmetic of an allocation movement (Step 62).
 *
 * Every rule about credit lives here, in one place, so the in-memory store and
 * the PostgreSQL store cannot disagree about what an operation means. A store
 * loads the rows it is about to change, calls `applyMovement`, and writes the
 * result plus the event inside one transaction; the check and the write are
 * therefore never separated.
 *
 * The invariants, in the order they are enforced:
 *
 *  - a pool must exist before anything is allocated from it;
 *  - the sum of `allocated` across live allocations may never exceed the pool;
 *  - an allocation's `allocated` may never exceed its own `limit`;
 *  - `consumed + reserved` may never exceed `allocated`, so a reduction cannot
 *    take back credit that was already spent or promised;
 *  - a reservation may not exceed what is available, and a settlement may not
 *    exceed what was reserved;
 *  - a revoked or expired allocation takes no new work, and a revoked one still
 *    holding a reservation is refused until the reservation is released.
 */

import {
  AllocationError,
  allocationAvailable,
  assertAmount,
  assertPoolTotal,
  round,
  type Allocation,
  type AllocationEvent,
  type AllocationEventKind,
  type AllocationPolicyName,
  type AllocationLifecycleState,
  type AllocationTargetKind,
  type CreditCategory,
  type WorkspacePool,
} from './types.js';

/** Everything one workspace holds in one category. What a movement operates on. */
export interface AllocationState {
  readonly pool: WorkspacePool | null;
  readonly allocations: readonly Allocation[];
}

export interface AllocationDraft {
  readonly id: string;
  readonly targetKind: AllocationTargetKind;
  readonly targetRef: string;
  readonly allocated: number;
  readonly limit: number | null;
  readonly priority: number;
  readonly policy: AllocationPolicyName;
  readonly allowedOperations: readonly string[];
  readonly expiresAt: string | null;
}

export type MovementOp =
  | { readonly op: 'set_pool'; readonly total: number; readonly note?: string }
  | { readonly op: 'create'; readonly allocation: AllocationDraft }
  | { readonly op: 'increase'; readonly allocationId: string; readonly amount: number }
  | { readonly op: 'reduce'; readonly allocationId: string; readonly amount: number }
  | { readonly op: 'reclaim'; readonly allocationId: string }
  | { readonly op: 'set_limit'; readonly allocationId: string; readonly limit: number | null }
  | { readonly op: 'set_priority'; readonly allocationId: string; readonly priority: number }
  | {
      readonly op: 'reserve';
      readonly allocationId: string;
      readonly amount: number;
      readonly operationKind: string | null;
    }
  | { readonly op: 'settle'; readonly allocationId: string; readonly amount: number }
  | { readonly op: 'release'; readonly allocationId: string; readonly amount: number }
  | { readonly op: 'revoke'; readonly allocationId: string }
  | { readonly op: 'expire'; readonly allocationId: string };

export interface MovementContext {
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly category: CreditCategory;
  readonly actor: string;
  readonly reason: string;
  readonly operationKey: string | null;
  readonly operationKind: string | null;
  readonly occurredAt: string;
  readonly nextId: () => string;
  /** Sequence number the store will assign; the memory store fills its own. */
  readonly nextSeq?: number;
}

export interface MovementResult {
  readonly pool: WorkspacePool | null;
  readonly allocations: readonly Allocation[];
  readonly events: readonly AllocationEvent[];
}

const find = (state: AllocationState, id: string): Allocation => {
  const allocation = state.allocations.find((candidate) => candidate.id === id);
  if (allocation === undefined) {
    throw new AllocationError('ALLOCATION_NOT_FOUND', 'That allocation was not found.', 404, {
      allocationId: id,
    });
  }
  return allocation;
};

const live = (allocation: Allocation): boolean =>
  allocation.state === 'active' || allocation.state === 'expired';

/** Credit already promised by live allocations, which the pool must cover. */
export function committedToAllocations(allocations: readonly Allocation[]): number {
  return round(
    allocations.filter(live).reduce((total, allocation) => total + allocation.allocated, 0),
  );
}

/** Unallocated credit in the pool: what is left to hand out. */
export function poolAvailable(
  pool: WorkspacePool | null,
  allocations: readonly Allocation[],
  category: CreditCategory,
): number {
  if (pool === null || pool.category !== category) return 0;
  const available = pool.total - committedToAllocations(allocations);
  return available < 0 ? 0 : round(available);
}

function assertPoolRoom(
  pool: WorkspacePool | null,
  allocations: readonly Allocation[],
  adding: number,
  category: CreditCategory,
): void {
  if (pool === null) {
    throw new AllocationError(
      'POOL_NOT_SET',
      'This workspace has no allocation pool yet. Set the pool before allocating credit.',
      409,
      { category },
    );
  }
  const committed = committedToAllocations(allocations);
  if (round(committed + adding) > round(pool.total) + 1e-9) {
    throw new AllocationError(
      'POOL_EXCEEDED',
      'The workspace does not have enough unallocated credit for that.',
      409,
      {
        category,
        poolTotal: pool.total,
        allocated: committed,
        available: round(Math.max(0, pool.total - committed)),
        requested: adding,
      },
    );
  }
}

const eventFor = (
  ctx: MovementContext,
  allocation: Allocation | null,
  kind: AllocationEventKind,
  amount: number,
): AllocationEvent => ({
  seq: ctx.nextSeq ?? 0,
  id: ctx.nextId(),
  ownerRef: ctx.ownerRef,
  workspaceId: ctx.workspaceId,
  category: ctx.category,
  allocationId: allocation?.id ?? null,
  targetKind: allocation?.targetKind ?? null,
  targetRef: allocation?.targetRef ?? null,
  kind,
  amount: round(amount),
  allocatedAfter: allocation?.allocated ?? 0,
  consumedAfter: allocation?.consumed ?? 0,
  reservedAfter: allocation?.reserved ?? 0,
  operationKey: ctx.operationKey,
  operationKind: ctx.operationKind,
  actor: ctx.actor,
  reason: ctx.reason,
  occurredAt: ctx.occurredAt,
});

const withPatch = (
  allocation: Allocation,
  patch: Partial<Allocation>,
  now: string,
): Allocation => ({
  ...allocation,
  ...patch,
  version: allocation.version + 1,
  updatedAt: now,
});

function assertUsable(allocation: Allocation, now: string): void {
  if (allocation.state === 'revoked') {
    throw new AllocationError(
      'ALLOCATION_REVOKED',
      'That allocation was revoked, so it cannot be spent from.',
      409,
      { allocationId: allocation.id },
    );
  }
  if (allocation.state === 'expired') {
    throw new AllocationError(
      'ALLOCATION_EXPIRED',
      'That allocation expired, so it cannot be spent from.',
      409,
      { allocationId: allocation.id },
    );
  }
  if (allocation.expiresAt !== null && Date.parse(allocation.expiresAt) <= Date.parse(now)) {
    throw new AllocationError(
      'ALLOCATION_EXPIRED',
      'That allocation has expired, so it cannot be spent from.',
      409,
      { allocationId: allocation.id, expiresAt: allocation.expiresAt },
    );
  }
}

/**
 * Applies every operation to the loaded state and returns the rows to write.
 * Throws `AllocationError` on the first refusal; a store must therefore call
 * this before it writes anything.
 */
export function applyMovement(
  state: AllocationState,
  ops: readonly MovementOp[],
  ctx: MovementContext,
): MovementResult {
  let pool = state.pool;
  const allocations = new Map(state.allocations.map((allocation) => [allocation.id, allocation]));
  const events: AllocationEvent[] = [];

  const replace = (allocation: Allocation, kind: AllocationEventKind, amount: number): void => {
    allocations.set(allocation.id, allocation);
    events.push(eventFor(ctx, allocation, kind, amount));
  };

  for (const op of ops) {
    switch (op.op) {
      case 'set_pool': {
        const total = assertPoolTotal(op.total);
        if (pool !== null) {
          const committed = committedToAllocations([...allocations.values()]);
          if (total + 1e-9 < committed) {
            throw new AllocationError(
              'POOL_EXCEEDED',
              'The pool cannot be smaller than the credit already allocated from it.',
              409,
              { total, allocated: committed },
            );
          }
        }
        pool = {
          ownerRef: ctx.ownerRef,
          workspaceId: ctx.workspaceId,
          category: ctx.category,
          total,
          note: op.note ?? pool?.note ?? '',
          version: (pool?.version ?? 0) + 1,
          updatedAt: ctx.occurredAt,
        };
        events.push(eventFor(ctx, null, 'pool_set', total));
        break;
      }

      case 'create': {
        const draft = op.allocation;
        if (allocations.has(draft.id)) {
          throw new AllocationError('DUPLICATE', 'That allocation already exists.', 409, {
            allocationId: draft.id,
          });
        }
        const amount = assertAmount(draft.allocated, 'allocated');
        if (draft.limit !== null && amount > draft.limit + 1e-9) {
          throw new AllocationError(
            'LIMIT_EXCEEDED',
            'The allocation is above the ceiling set for that target.',
            409,
            { requested: amount, limit: draft.limit },
          );
        }
        assertPoolRoom(pool, [...allocations.values()], amount, ctx.category);
        const allocation: Allocation = {
          id: draft.id,
          ownerRef: ctx.ownerRef,
          workspaceId: ctx.workspaceId,
          category: ctx.category,
          targetKind: draft.targetKind,
          targetRef: draft.targetRef,
          limit: draft.limit,
          allocated: amount,
          reserved: 0,
          consumed: 0,
          priority: draft.priority,
          policy: draft.policy,
          allowedOperations: [...draft.allowedOperations],
          state: 'active',
          expiresAt: draft.expiresAt,
          version: 1,
          createdAt: ctx.occurredAt,
          updatedAt: ctx.occurredAt,
        };
        replace(allocation, 'allocated', amount);
        break;
      }

      case 'increase': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        if (current.state !== 'active') {
          throw new AllocationError(
            'INVALID_STATE',
            'Only an active allocation can be increased.',
            409,
            {
              allocationId: current.id,
              state: current.state,
            },
          );
        }
        const amount = assertAmount(op.amount);
        const next = round(current.allocated + amount);
        if (current.limit !== null && next > current.limit + 1e-9) {
          throw new AllocationError(
            'LIMIT_EXCEEDED',
            'That increase would take the allocation above its ceiling.',
            409,
            { allocationId: current.id, limit: current.limit, requested: next },
          );
        }
        assertPoolRoom(pool, [...allocations.values()], amount, ctx.category);
        replace(withPatch(current, { allocated: next }, ctx.occurredAt), 'increased', amount);
        break;
      }

      case 'reduce': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        const amount = assertAmount(op.amount);
        const free = round(current.allocated - current.consumed - current.reserved);
        if (amount > free + 1e-9) {
          throw new AllocationError(
            'INVALID_AMOUNT',
            'That reduction would take back credit that is spent or promised to work in flight.',
            409,
            {
              allocationId: current.id,
              requested: amount,
              reclaimable: free,
              consumed: current.consumed,
              reserved: current.reserved,
            },
          );
        }
        replace(
          withPatch(current, { allocated: round(current.allocated - amount) }, ctx.occurredAt),
          'reduced',
          amount,
        );
        break;
      }

      case 'reclaim': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        const free = round(current.allocated - current.consumed - current.reserved);
        replace(
          withPatch(current, { allocated: round(current.allocated - free) }, ctx.occurredAt),
          'reclaimed',
          free,
        );
        break;
      }

      case 'set_limit': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        if (op.limit !== null) {
          if (typeof op.limit !== 'number' || !Number.isFinite(op.limit) || op.limit < 0) {
            throw new AllocationError('INVALID_AMOUNT', 'a limit must be zero or more.', 400);
          }
          if (op.limit + 1e-9 < current.allocated) {
            throw new AllocationError(
              'LIMIT_EXCEEDED',
              'A ceiling cannot be set below what is already allocated. Reduce the allocation first.',
              409,
              { allocationId: current.id, allocated: current.allocated, limit: op.limit },
            );
          }
        }
        replace(
          withPatch(current, { limit: op.limit }, ctx.occurredAt),
          'limit_set',
          op.limit ?? 0,
        );
        break;
      }

      case 'set_priority': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        if (typeof op.priority !== 'number' || !Number.isFinite(op.priority)) {
          throw new AllocationError('INVALID_STATE', 'priority must be a number.', 400);
        }
        replace(
          withPatch(current, { priority: Math.trunc(op.priority) }, ctx.occurredAt),
          'priority_set',
          current.allocated,
        );
        break;
      }

      case 'reserve': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        assertUsable(current, ctx.occurredAt);
        const amount = assertAmount(op.amount, 'reservation');
        if (
          current.allowedOperations.length > 0 &&
          (op.operationKind === null || !current.allowedOperations.includes(op.operationKind))
        ) {
          throw new AllocationError(
            'OPERATION_NOT_ALLOWED',
            'That allocation only pays for the operations listed on it.',
            409,
            {
              allocationId: current.id,
              operationKind: op.operationKind,
              allowed: current.allowedOperations,
            },
          );
        }
        const available = allocationAvailable(current);
        if (amount > available + 1e-9) {
          throw new AllocationError(
            'ALLOCATION_EXHAUSTED',
            'That allocation does not have enough credit left for this operation.',
            402,
            {
              allocationId: current.id,
              available,
              requested: amount,
              allocated: current.allocated,
              consumed: current.consumed,
              reserved: current.reserved,
            },
          );
        }
        replace(
          withPatch(current, { reserved: round(current.reserved + amount) }, ctx.occurredAt),
          'reserved',
          amount,
        );
        break;
      }

      case 'settle': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        const amount = assertAmount(op.amount, 'settlement');
        if (amount > current.reserved + 1e-9) {
          throw new AllocationError(
            'INVALID_STATE',
            'A settlement cannot exceed what was reserved.',
            409,
            { allocationId: current.id, reserved: current.reserved, requested: amount },
          );
        }
        const consumed = round(current.consumed + amount);
        const reserved = round(current.reserved - amount);
        if (round(consumed + reserved) > current.allocated + 1e-9) {
          throw new AllocationError(
            'INVALID_STATE',
            'A settlement would spend more credit than was allocated.',
            409,
            { allocationId: current.id, allocated: current.allocated, consumed, reserved },
          );
        }
        // A settled allocation stays active even at zero available: state is a
        // decision (revoked, expired), never an inference from a balance.
        replace(withPatch(current, { consumed, reserved }, ctx.occurredAt), 'settled', amount);
        break;
      }

      case 'release': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        const amount = assertAmount(op.amount, 'release');
        if (amount > current.reserved + 1e-9) {
          throw new AllocationError(
            'INVALID_STATE',
            'A release cannot exceed what was reserved.',
            409,
            { allocationId: current.id, reserved: current.reserved, requested: amount },
          );
        }
        replace(
          withPatch(current, { reserved: round(current.reserved - amount) }, ctx.occurredAt),
          'released',
          amount,
        );
        break;
      }

      case 'expire': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        if (
          current.state !== 'active' ||
          current.expiresAt === null ||
          Date.parse(current.expiresAt) > Date.parse(ctx.occurredAt) ||
          current.reserved > 0
        ) {
          // Nothing to do: either it has not expired yet, it already was
          // handled, or a reservation must be released first.
          break;
        }
        replace(
          withPatch(current, { state: 'expired' as AllocationLifecycleState }, ctx.occurredAt),
          'expired',
          0,
        );
        break;
      }

      case 'revoke': {
        const allocation = find(state, op.allocationId);
        const current = allocations.get(allocation.id) ?? allocation;
        if (current.reserved > 0) {
          throw new AllocationError(
            'INVALID_STATE',
            'That allocation still holds credit for work in flight. Release it before revoking.',
            409,
            { allocationId: current.id, reserved: current.reserved },
          );
        }
        replace(
          withPatch(
            current,
            { state: 'revoked' as AllocationLifecycleState, allocated: current.consumed },
            ctx.occurredAt,
          ),
          'revoked',
          round(current.allocated - current.consumed),
        );
        break;
      }
    }
  }

  return {
    pool,
    allocations: [...allocations.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    events,
  };
}

/**
 * Marks allocations whose expiry has passed, so a read tells the truth and the
 * next movement records the expiry once. Unspent credit returns to the pool by
 * virtue of the allocation no longer counting as live.
 */
export function expireDue(
  allocations: readonly Allocation[],
  now: string,
): { allocations: readonly Allocation[]; expired: readonly Allocation[] } {
  const expired: Allocation[] = [];
  const next = allocations.map((allocation) => {
    if (
      allocation.state === 'active' &&
      allocation.expiresAt !== null &&
      Date.parse(allocation.expiresAt) <= Date.parse(now)
    ) {
      const updated: Allocation = {
        ...allocation,
        state: 'expired',
        version: allocation.version + 1,
        updatedAt: now,
      };
      expired.push(updated);
      return updated;
    }
    return allocation;
  });
  return { allocations: next, expired };
}
