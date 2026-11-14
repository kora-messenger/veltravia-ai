/**
 * The allocation book (Step 62).
 *
 * This is the only thing an API route or a billing gate talks to. It turns a
 * plain instruction ("give this project 2,000 AI credits") into one store
 * movement, and it answers the one question billing asks before work starts:
 * "may this operation draw on credit, and which allowance does it draw from?"
 *
 * It holds no balance. `allocated` is a ceiling copied from the workspace pool,
 * not new credit, so a mistake is corrected by reducing the allocation and the
 * workspace wallet is still the single place a credit is spent.
 *
 * The backward-compatibility rule is the important one: **a workspace with no
 * allocations behaves exactly as it did before Step 62.** `authorize` only
 * refuses when an allocation exists and cannot cover the work. That is why
 * turning this feature on cannot break an existing account mid-run.
 */

import { randomUUID } from 'node:crypto';

import { applyMovement, expireDue, poolAvailable, type MovementOp } from './movement.js';
import {
  DEFAULT_ALLOCATION_POLICY,
  distribute as distributePolicy,
  platformAllocationLimits,
  targetCeiling,
  type AllocationPolicyConfig,
  type DistributionResult,
  type DistributionTarget,
  type PlatformAllocationLimits,
} from './policies.js';
import type { AllocationStore, MovementRequest } from './store.js';
import {
  ALLOCATION_LIMITS,
  AllocationError,
  allocationAvailable,
  assertActor,
  assertAmount,
  assertPoolTotal,
  assertReason,
  assertTargetRef,
  isAllocationPolicyName,
  isAllocationTargetKind,
  isCreditCategory,
  round,
  type Allocation,
  type AllocationEvent,
  type AllocationPolicyName,
  type AllocationLifecycleState,
  type AllocationTargetKind,
  type CreditCategory,
  type WorkspacePool,
} from './types.js';

export interface AllocationBookOptions {
  readonly store: AllocationStore;
  readonly now?: (() => Date) | undefined;
  readonly newId?: (() => string) | undefined;
  readonly platform?: PlatformAllocationLimits | undefined;
  readonly maxAllocationsPerWorkspace?: number | undefined;
}

export interface AllocationSummaryCategory {
  readonly category: CreditCategory;
  readonly pool: {
    readonly total: number;
    readonly allocated: number;
    readonly available: number;
    readonly note: string;
    readonly set: boolean;
  };
  readonly totals: {
    readonly allocated: number;
    readonly reserved: number;
    readonly consumed: number;
    readonly available: number;
  };
  readonly allocations: readonly (Allocation & { readonly available: number })[];
  readonly policy: AllocationPolicyConfig;
}

export interface AllocationSummary {
  readonly workspaceId: string;
  readonly categories: readonly AllocationSummaryCategory[];
  readonly note: string;
}

export type AllocationRefusalCode =
  | 'ALLOCATION_EXHAUSTED'
  | 'ALLOCATION_EXPIRED'
  | 'ALLOCATION_REVOKED'
  | 'OPERATION_NOT_ALLOWED'
  | 'ALLOCATION_NOT_FOUND'
  | 'ALLOCATION_UNAVAILABLE';

export interface AllocationAuthorization {
  /** True when the work may start. */
  readonly allowed: boolean;
  /** The allocation the credit is reserved on, when one applies. */
  readonly allocationId: string | null;
  readonly targetKind: AllocationTargetKind | null;
  readonly targetRef: string | null;
  readonly amount: number;
  readonly available: number | null;
  readonly code: AllocationRefusalCode | null;
  readonly reason: string;
  /** The reservation key, so the caller settles or releases exactly this hold. */
  readonly operationKey: string | null;
}

interface MovementMeta {
  readonly workspaceId: string;
  readonly category: CreditCategory;
  readonly actor: string;
  readonly reason: string;
  readonly operationKey?: string | null;
  readonly operationKind?: string | null;
  readonly idempotencyKey?: string | null;
}

export class AllocationBook {
  private readonly store: AllocationStore;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly platform: PlatformAllocationLimits;
  private readonly maxPerWorkspace: number;

  constructor(options: AllocationBookOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `alc_${randomUUID()}`);
    this.platform = options.platform ?? platformAllocationLimits();
    this.maxPerWorkspace =
      options.maxAllocationsPerWorkspace ?? this.platform.maxAllocationsPerWorkspace;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private movement(meta: MovementMeta, ops: readonly MovementOp[]): MovementRequest {
    return {
      ownerRef: '',
      workspaceId: meta.workspaceId,
      category: meta.category,
      idempotencyKey: meta.idempotencyKey ?? `mov_${randomUUID()}`,
      actor: assertActor(meta.actor),
      reason: assertReason(meta.reason),
      operationKey: meta.operationKey ?? null,
      operationKind: meta.operationKind ?? null,
      occurredAt: this.stamp(),
      ops,
    };
  }

  /** Applies a movement for one owner. The owner is a parameter, never part of the body. */
  private async apply(
    ownerRef: string,
    meta: MovementMeta,
    ops: readonly MovementOp[],
  ): Promise<{
    pool: WorkspacePool | null;
    allocations: readonly Allocation[];
    events: readonly AllocationEvent[];
  }> {
    const request = { ...this.movement(meta, ops), ownerRef };
    const result = await this.store.apply(request);
    return { pool: result.pool, allocations: result.allocations, events: result.events };
  }

  async setPool(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly total: number;
    readonly note?: string;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<WorkspacePool> {
    const total = assertPoolTotal(input.total);
    if (total > this.platform.maxPoolCredits) {
      throw new AllocationError(
        'LIMIT_EXCEEDED',
        `The pool is above this deployment's ceiling of ${this.platform.maxPoolCredits} credits.`,
        409,
        { total, maximum: this.platform.maxPoolCredits },
      );
    }
    const result = await this.apply(input.ownerRef, input, [
      { op: 'set_pool', total, ...(input.note === undefined ? {} : { note: input.note }) },
    ]);
    if (result.pool === null) throw new Error('the pool was not written');
    return result.pool;
  }

  async allocate(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly targetKind: AllocationTargetKind;
    readonly targetRef: string;
    readonly amount: number;
    readonly limit?: number | null;
    readonly priority?: number;
    readonly policy?: AllocationPolicyName;
    readonly allowedOperations?: readonly string[];
    readonly expiresAt?: string | null;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation> {
    if (!isCreditCategory(input.category)) {
      throw new AllocationError('INVALID_STATE', 'Unknown credit category.', 400);
    }
    if (!isAllocationTargetKind(input.targetKind)) {
      throw new AllocationError('INVALID_STATE', 'Unknown allocation target.', 400);
    }
    const policy = input.policy ?? 'manual';
    if (!isAllocationPolicyName(policy)) {
      throw new AllocationError('INVALID_STATE', 'Unknown allocation policy.', 400);
    }
    const amount = assertAmount(input.amount, 'amount');
    if (amount > this.platform.maxAllocationCredits) {
      throw new AllocationError(
        'LIMIT_EXCEEDED',
        `One allocation may not exceed ${this.platform.maxAllocationCredits} credits here.`,
        409,
        { requested: amount, maximum: this.platform.maxAllocationCredits },
      );
    }
    const targetRef = assertTargetRef(input.targetRef);
    const limit = input.limit ?? null;
    if (limit !== null) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
        throw new AllocationError('INVALID_AMOUNT', 'a limit must be zero or more.', 400);
      }
      if (limit > this.platform.maxAllocationCredits) {
        throw new AllocationError(
          'LIMIT_EXCEEDED',
          `A ceiling may not exceed ${this.platform.maxAllocationCredits} credits here.`,
          409,
          { limit, maximum: this.platform.maxAllocationCredits },
        );
      }
    }
    if (policy === 'temporary' && (input.expiresAt === undefined || input.expiresAt === null)) {
      throw new AllocationError(
        'INVALID_STATE',
        'A temporary allocation needs an expiry date.',
        400,
      );
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const parsed = Date.parse(input.expiresAt);
      if (!Number.isFinite(parsed)) {
        throw new AllocationError('INVALID_STATE', 'expiresAt must be a date.', 400);
      }
      if (parsed <= this.now().getTime()) {
        throw new AllocationError('INVALID_STATE', 'expiresAt must be in the future.', 400);
      }
    }

    const state = await this.store.load(input.ownerRef, input.workspaceId, input.category);
    const live = state.allocations.filter((allocation) => allocation.state === 'active');
    if (live.length >= this.maxPerWorkspace) {
      throw new AllocationError(
        'LIMIT_EXCEEDED',
        'This workspace already holds as many allocations as one workspace may have.',
        409,
        { maximum: this.maxPerWorkspace },
      );
    }
    const duplicate = live.find(
      (allocation) =>
        allocation.targetKind === input.targetKind && allocation.targetRef === targetRef,
    );
    if (duplicate !== undefined) {
      throw new AllocationError(
        'DUPLICATE',
        'That target already has an allocation in this category. Increase it instead.',
        409,
        { allocationId: duplicate.id, targetKind: input.targetKind, targetRef },
      );
    }

    const id = this.newId();
    const result = await this.apply(input.ownerRef, input, [
      {
        op: 'create',
        allocation: {
          id,
          targetKind: input.targetKind,
          targetRef,
          allocated: amount,
          limit,
          priority: Math.trunc(input.priority ?? 0),
          policy,
          allowedOperations: input.allowedOperations ?? [],
          expiresAt: input.expiresAt ?? null,
        },
      },
    ]);
    const created = result.allocations.find((allocation) => allocation.id === id);
    if (created === undefined) throw new Error('the allocation was not written');
    return created;
  }

  async increase(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const amount = assertAmount(input.amount, 'amount');
    if (allocation.allocated + amount > this.platform.maxAllocationCredits) {
      throw new AllocationError(
        'LIMIT_EXCEEDED',
        `One allocation may not exceed ${this.platform.maxAllocationCredits} credits here.`,
        409,
        { maximum: this.platform.maxAllocationCredits },
      );
    }
    const result = await this.apply(
      input.ownerRef,
      { ...input, workspaceId: allocation.workspaceId, category: allocation.category },
      [{ op: 'increase', allocationId: allocation.id, amount }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  async reduce(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const amount = assertAmount(input.amount, 'amount');
    const result = await this.apply(
      input.ownerRef,
      { ...input, workspaceId: allocation.workspaceId, category: allocation.category },
      [{ op: 'reduce', allocationId: allocation.id, amount }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  async reclaim(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const result = await this.apply(
      input.ownerRef,
      { ...input, workspaceId: allocation.workspaceId, category: allocation.category },
      [{ op: 'reclaim', allocationId: allocation.id }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  async setLimit(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly limit: number | null;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const result = await this.apply(
      input.ownerRef,
      { ...input, workspaceId: allocation.workspaceId, category: allocation.category },
      [{ op: 'set_limit', allocationId: allocation.id, limit: input.limit }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  async setPriority(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly priority: number;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const result = await this.apply(
      input.ownerRef,
      { ...input, workspaceId: allocation.workspaceId, category: allocation.category },
      [{ op: 'set_priority', allocationId: allocation.id, priority: input.priority }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  async revoke(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const result = await this.apply(
      input.ownerRef,
      { ...input, workspaceId: allocation.workspaceId, category: allocation.category },
      [{ op: 'revoke', allocationId: allocation.id }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  /**
   * Applies a policy's split. Each allocation is one movement, so a refusal
   * halfway leaves the earlier ones in place and the caller sees exactly which
   * targets were funded.
   */
  async distribute(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly policy: AllocationPolicyName;
    readonly budget: number;
    readonly targets: readonly DistributionTarget[];
    readonly actor: string;
    readonly reason: string;
    readonly allowedOperations?: readonly string[];
    readonly expiresAt?: string | null;
  }): Promise<{ planned: DistributionResult; applied: readonly Allocation[] }> {
    const state = await this.store.load(input.ownerRef, input.workspaceId, input.category);
    const available = poolAvailable(state.pool, state.allocations, input.category);
    if (available <= 0) {
      throw new AllocationError(
        'POOL_EXCEEDED',
        'There is no unallocated credit in this workspace pool.',
        409,
        { category: input.category },
      );
    }
    const budget = Math.min(assertAmount(input.budget, 'budget'), available);
    const policy = await this.policy(input.ownerRef, input.workspaceId, input.category);
    const planned = distributePolicy({
      policy: input.policy,
      targets: input.targets,
      budget,
      category: input.category,
      maxTargetSharePct: policy.maxTargetSharePct,
      platform: {
        maxTargetSharePct: this.platform.maxTargetSharePct,
        maxAllocationCredits: this.platform.maxAllocationCredits,
      },
    });

    const applied: Allocation[] = [];
    for (const entry of planned.planned) {
      if (entry.amount <= 0) continue;
      const ceiling = targetCeiling(
        state.pool?.total ?? 0,
        { maxTargetSharePct: policy.maxTargetSharePct },
        this.platform,
      );
      applied.push(
        await this.allocate({
          ownerRef: input.ownerRef,
          workspaceId: input.workspaceId,
          category: input.category,
          targetKind: entry.target.kind,
          targetRef: entry.target.ref,
          amount: entry.amount,
          limit: entry.target.limit ?? (ceiling > 0 && ceiling < entry.amount ? ceiling : null),
          priority: entry.target.priority ?? 0,
          policy: input.policy,
          allowedOperations: entry.target.allowedOperations ?? input.allowedOperations ?? [],
          expiresAt: entry.target.expiresAt ?? input.expiresAt ?? null,
          actor: input.actor,
          reason: input.reason,
        }),
      );
    }
    return { planned, applied };
  }

  /** Holds credit for one operation. Same operation key twice returns the first hold. */
  async reserve(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly operationKey: string;
    readonly operationKind: string | null;
    readonly actor: string;
    readonly reason: string;
    readonly idempotencyKey?: string | null;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const amount = assertAmount(input.amount, 'reservation');
    const result = await this.apply(
      input.ownerRef,
      {
        ...input,
        workspaceId: allocation.workspaceId,
        category: allocation.category,
        idempotencyKey: input.idempotencyKey ?? input.operationKey,
      },
      [{ op: 'reserve', allocationId: allocation.id, amount, operationKind: input.operationKind }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  async settle(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly operationKey: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const amount = assertAmount(input.amount, 'settlement');
    const result = await this.apply(
      input.ownerRef,
      {
        workspaceId: allocation.workspaceId,
        category: allocation.category,
        actor: input.actor,
        reason: input.reason,
        operationKey: input.operationKey,
        idempotencyKey: `${input.operationKey}:settle`,
      },
      [{ op: 'settle', allocationId: allocation.id, amount }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  async release(input: {
    readonly ownerRef: string;
    readonly allocationId: string;
    readonly amount: number;
    readonly operationKey: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<Allocation> {
    const allocation = await this.requireAllocation(input.ownerRef, input.allocationId);
    const amount = assertAmount(input.amount, 'release');
    const result = await this.apply(
      input.ownerRef,
      {
        workspaceId: allocation.workspaceId,
        category: allocation.category,
        actor: input.actor,
        reason: input.reason,
        operationKey: input.operationKey,
        idempotencyKey: `${input.operationKey}:release`,
      },
      [{ op: 'release', allocationId: allocation.id, amount }],
    );
    return this.pick(result.allocations, allocation.id);
  }

  /**
   * Billing's one question.
   *
   * The target is resolved from the caller's own identifiers (their project, the
   * agent they are using) and never from a model-supplied owner. When an
   * allowance applies, credit is reserved inside the store's transaction, so the
   * answer and the hold are the same step.
   */
  async authorize(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly amount: number;
    readonly operationKey: string;
    readonly operationKind: string | null;
    readonly projectId?: string | null;
    readonly agentRef?: string | null;
    readonly memberRef?: string | null;
    readonly actor?: string | null;
  }): Promise<AllocationAuthorization> {
    const amount = round(input.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new AllocationError('INVALID_AMOUNT', 'amount must be zero or more.', 400);
    }
    if (amount === 0) {
      return {
        allowed: true,
        allocationId: null,
        targetKind: null,
        targetRef: null,
        amount: 0,
        available: null,
        code: null,
        reason: 'Nothing is owed, so no allowance is consulted.',
        operationKey: null,
      };
    }

    let state = await this.store.load(input.ownerRef, input.workspaceId, input.category);
    // Expiry is written down before the decision, so an expired allowance cannot
    // keep holding pool credit and a later read tells the truth.
    const due = expireDue(state.allocations, this.stamp()).expired;
    if (due.length > 0) {
      await this.apply(
        input.ownerRef,
        {
          workspaceId: input.workspaceId,
          category: input.category,
          actor: 'system',
          reason: 'Allocation expiry',
          operationKey: null,
        },
        due.map((allocation) => ({ op: 'expire' as const, allocationId: allocation.id })),
      );
      state = await this.store.load(input.ownerRef, input.workspaceId, input.category);
    }

    const candidates = state.allocations
      .filter((allocation) => allocation.state === 'active')
      .filter((allocation) => {
        if (allocation.targetKind === 'project') return allocation.targetRef === input.projectId;
        if (allocation.targetKind === 'agent') return allocation.targetRef === input.agentRef;
        if (allocation.targetKind === 'member') return allocation.targetRef === input.memberRef;
        if (allocation.targetKind === 'environment') return false;
        return false;
      })
      .sort((a, b) => {
        const rank = (kind: AllocationTargetKind): number =>
          kind === 'project' ? 0 : kind === 'agent' ? 1 : kind === 'member' ? 2 : 3;
        const byRank = rank(a.targetKind) - rank(b.targetKind);
        if (byRank !== 0) return byRank;
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });

    const chosen = candidates[0];
    if (chosen === undefined) {
      const policy = await this.policy(input.ownerRef, input.workspaceId, input.category);
      if (policy.defaultPolicy === 'automatic' && policy.autoLimit > 0) {
        const target = this.automaticTarget(input);
        if (target !== null) {
          const available = poolAvailable(state.pool, state.allocations, input.category);
          const ceiling = Math.min(policy.autoLimit, this.platform.maxAllocationCredits);
          const grant = round(Math.min(ceiling, available, Math.max(amount, 0)));
          if (grant >= amount && grant > 0) {
            const allocation = await this.allocate({
              ownerRef: input.ownerRef,
              workspaceId: input.workspaceId,
              category: input.category,
              targetKind: target.kind,
              targetRef: target.ref,
              amount: grant,
              limit: ceiling,
              priority: 0,
              policy: 'automatic',
              actor: input.actor ?? 'system',
              reason: 'Automatic allocation under the workspace policy',
            });
            return this.reserveOn(input, allocation, amount);
          }
          return {
            allowed: false,
            allocationId: null,
            targetKind: target.kind,
            targetRef: target.ref,
            amount,
            available,
            code: 'ALLOCATION_EXHAUSTED',
            reason: `This workspace allocates credit automatically up to ${ceiling}, and ${available} is unallocated.`,
            operationKey: null,
          };
        }
      }
      return {
        allowed: true,
        allocationId: null,
        targetKind: null,
        targetRef: null,
        amount,
        available: null,
        code: null,
        reason:
          'This workspace has not allocated credit for that target, so the workspace balance is the only check.',
        operationKey: null,
      };
    }

    return this.reserveOn(input, chosen, amount);
  }

  private async reserveOn(
    input: {
      readonly ownerRef: string;
      readonly operationKey: string;
      readonly operationKind: string | null;
      readonly actor?: string | null;
    },
    allocation: Allocation,
    requested: number,
  ): Promise<AllocationAuthorization> {
    const amount = round(requested);
    const available = allocationAvailable(allocation);
    try {
      const reserved = await this.reserve({
        ownerRef: input.ownerRef,
        allocationId: allocation.id,
        amount,
        operationKey: input.operationKey,
        operationKind: input.operationKind,
        actor: input.actor ?? 'system',
        reason: `${input.operationKind ?? 'operation'} ${input.operationKey}`,
      });
      return {
        allowed: true,
        allocationId: allocation.id,
        targetKind: allocation.targetKind,
        targetRef: allocation.targetRef,
        amount,
        available: allocationAvailable(reserved),
        code: null,
        reason: `Reserved on the ${allocation.targetKind} allowance for ${allocation.targetRef}.`,
        operationKey: input.operationKey,
      };
    } catch (error) {
      if (!(error instanceof AllocationError)) throw error;
      if (
        error.code !== 'ALLOCATION_EXHAUSTED' &&
        error.code !== 'ALLOCATION_EXPIRED' &&
        error.code !== 'ALLOCATION_REVOKED' &&
        error.code !== 'OPERATION_NOT_ALLOWED' &&
        error.code !== 'ALLOCATION_NOT_FOUND'
      ) {
        throw error;
      }
      return {
        allowed: false,
        allocationId: allocation.id,
        targetKind: allocation.targetKind,
        targetRef: allocation.targetRef,
        amount,
        available,
        code: error.code,
        reason: error.message,
        operationKey: null,
      };
    }
  }

  private automaticTarget(input: {
    readonly projectId?: string | null;
    readonly agentRef?: string | null;
  }): { kind: AllocationTargetKind; ref: string } | null {
    if (typeof input.projectId === 'string' && input.projectId.length > 0) {
      return { kind: 'project', ref: input.projectId };
    }
    if (typeof input.agentRef === 'string' && input.agentRef.length > 0) {
      return { kind: 'agent', ref: input.agentRef };
    }
    return null;
  }

  async summary(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
  }): Promise<AllocationSummary> {
    const categories: AllocationSummaryCategory[] = [];
    for (const category of ['ai_tokens', 'integration_credits'] as const) {
      const state = await this.store.load(input.ownerRef, input.workspaceId, category);
      const { allocations } = expireDue(state.allocations, this.stamp());
      const live = allocations.filter((allocation) => allocation.state === 'active');
      const committed = round(live.reduce((total, allocation) => total + allocation.allocated, 0));
      const reserved = round(live.reduce((total, allocation) => total + allocation.reserved, 0));
      const consumed = round(live.reduce((total, allocation) => total + allocation.consumed, 0));
      categories.push({
        category,
        pool: {
          total: state.pool?.total ?? 0,
          allocated: committed,
          available: state.pool === null ? 0 : round(Math.max(0, state.pool.total - committed)),
          note: state.pool?.note ?? '',
          set: state.pool !== null,
        },
        totals: {
          allocated: committed,
          reserved,
          consumed,
          available: round(
            live.reduce((total, allocation) => total + allocationAvailable(allocation), 0),
          ),
        },
        allocations: allocations
          .slice()
          .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
          .map((allocation) => ({ ...allocation, available: allocationAvailable(allocation) })),
        policy: await this.policy(input.ownerRef, input.workspaceId, category),
      });
    }
    return {
      workspaceId: input.workspaceId,
      categories,
      note: 'An allocation is a ceiling over the workspace wallet, never a second balance. Spending it still moves credit through the wallet.',
    };
  }

  async list(query: {
    readonly ownerRef: string;
    readonly workspaceId?: string | null;
    readonly category?: CreditCategory | null;
    readonly targetKind?: AllocationTargetKind | null;
    readonly targetRef?: string | null;
    readonly state?: AllocationLifecycleState | null;
    readonly limit?: number | null;
  }): Promise<readonly Allocation[]> {
    return this.store.list(query);
  }

  async history(query: {
    readonly ownerRef: string;
    readonly workspaceId?: string | null;
    readonly category?: CreditCategory | null;
    readonly allocationId?: string | null;
    readonly limit?: number | null;
    readonly beforeSeq?: number | null;
  }): Promise<readonly AllocationEvent[]> {
    return this.store.history(query);
  }

  async get(ownerRef: string, allocationId: string): Promise<Allocation | null> {
    const allocation = await this.store.get(allocationId);
    return allocation !== null && allocation.ownerRef === ownerRef ? allocation : null;
  }

  async policy(
    ownerRef: string,
    workspaceId: string,
    category: CreditCategory,
  ): Promise<AllocationPolicyConfig> {
    const stored = await this.store.policy(ownerRef, workspaceId, category);
    if (stored !== null) return stored;
    return {
      ownerRef,
      workspaceId,
      category,
      ...DEFAULT_ALLOCATION_POLICY,
      updatedAt: this.stamp(),
    };
  }

  async setPolicy(input: {
    readonly ownerRef: string;
    readonly workspaceId: string;
    readonly category: CreditCategory;
    readonly defaultPolicy: AllocationPolicyName;
    readonly autoLimit: number;
    readonly maxTargetSharePct: number;
    readonly actor: string;
    readonly reason: string;
  }): Promise<AllocationPolicyConfig> {
    if (!isAllocationPolicyName(input.defaultPolicy)) {
      throw new AllocationError('INVALID_STATE', 'Unknown allocation policy.', 400);
    }
    const autoLimit = input.autoLimit === 0 ? 0 : assertAmount(input.autoLimit, 'autoLimit');
    if (autoLimit > this.platform.maxAllocationCredits) {
      throw new AllocationError(
        'LIMIT_EXCEEDED',
        `The automatic ceiling may not exceed ${this.platform.maxAllocationCredits} credits here.`,
        409,
        { maximum: this.platform.maxAllocationCredits },
      );
    }
    const share = Math.min(
      Math.max(0, Math.min(100, Math.trunc(input.maxTargetSharePct))),
      this.platform.maxTargetSharePct,
    );
    const config: AllocationPolicyConfig = {
      ownerRef: input.ownerRef,
      workspaceId: input.workspaceId,
      category: input.category,
      defaultPolicy: input.defaultPolicy,
      autoLimit,
      maxTargetSharePct: share,
      updatedAt: this.stamp(),
    };
    await this.store.savePolicy(config);
    return config;
  }

  /** Releases the unspent part of every expired allocation, so the pool knows. */
  async sweepExpired(ownerRef: string, workspaceId: string): Promise<number> {
    let released = 0;
    for (const category of ['ai_tokens', 'integration_credits'] as const) {
      const state = await this.store.load(ownerRef, workspaceId, category);
      const due = expireDue(state.allocations, this.stamp()).expired.filter(
        (allocation) => allocation.reserved === 0,
      );
      if (due.length === 0) continue;
      await this.apply(
        ownerRef,
        {
          workspaceId,
          category,
          actor: 'system',
          reason: 'Allocation expiry sweep',
          operationKey: null,
        },
        due.map((allocation) => ({ op: 'expire' as const, allocationId: allocation.id })),
      );
      released += due.length;
    }
    return released;
  }

  private pick(allocations: readonly Allocation[], id: string): Allocation {
    const allocation = allocations.find((candidate) => candidate.id === id);
    if (allocation === undefined) {
      throw new AllocationError('ALLOCATION_NOT_FOUND', 'That allocation was not found.', 404, {
        allocationId: id,
      });
    }
    return allocation;
  }

  private async requireAllocation(ownerRef: string, allocationId: string): Promise<Allocation> {
    const allocation = await this.get(ownerRef, allocationId);
    if (allocation === null) {
      throw new AllocationError('ALLOCATION_NOT_FOUND', 'That allocation was not found.', 404, {
        allocationId,
      });
    }
    return allocation;
  }
}

/** Exported so tests and the API can share the arithmetic instead of copying it. */
export { applyMovement, poolAvailable, expireDue };
export type { MovementOp };
export const ALLOCATION_CEILINGS = ALLOCATION_LIMITS;
