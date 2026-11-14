/**
 * The in-memory allocation store (Step 62).
 *
 * It exists so a laptop and the test suite run the same rules as PostgreSQL, and
 * so the concurrency property can be tested without a database. The one thing it
 * must not do is introduce an `await` between reading the state inside `apply`
 * and writing the result: a check that yields is a check two callers can pass.
 * There is no `await` in that path, on purpose.
 */

import { randomUUID } from 'node:crypto';

import { applyMovement, type AllocationState, type MovementOp } from './movement.js';
import type { AllocationPolicyConfig } from './policies.js';
import type {
  AllocationQuery,
  AllocationHistoryQuery,
  AllocationStore,
  MovementApplied,
  MovementRequest,
} from './store.js';
import type { Allocation, AllocationEvent, CreditCategory, WorkspacePool } from './types.js';

const poolKey = (ownerRef: string, workspaceId: string, category: CreditCategory): string =>
  `${ownerRef}\u0000${workspaceId}\u0000${category}`;

export class InMemoryAllocationStore implements AllocationStore {
  private readonly pools = new Map<string, WorkspacePool>();
  private readonly allocations = new Map<string, Allocation>();
  private readonly events: AllocationEvent[] = [];
  private readonly applied = new Map<string, MovementApplied>();
  private readonly policies = new Map<string, AllocationPolicyConfig>();
  private seq = 0;

  constructor(private readonly newId: () => string = () => `alc_${randomUUID()}`) {}

  private rowsFor(ownerRef: string, workspaceId: string, category: CreditCategory): Allocation[] {
    return [...this.allocations.values()].filter(
      (allocation) =>
        allocation.ownerRef === ownerRef &&
        allocation.workspaceId === workspaceId &&
        allocation.category === category,
    );
  }

  /** Synchronous on purpose: `apply` must read and write with no await between. */
  private snapshot(
    ownerRef: string,
    workspaceId: string,
    category: CreditCategory,
  ): AllocationState {
    return {
      pool: this.pools.get(poolKey(ownerRef, workspaceId, category)) ?? null,
      allocations: this.rowsFor(ownerRef, workspaceId, category),
    };
  }

  async load(
    ownerRef: string,
    workspaceId: string,
    category: CreditCategory,
  ): Promise<AllocationState> {
    return this.snapshot(ownerRef, workspaceId, category);
  }

  async apply(request: MovementRequest): Promise<MovementApplied> {
    const replayKey = `${request.ownerRef}\u0000${request.idempotencyKey}`;
    const previous = this.applied.get(replayKey);
    if (previous !== undefined) return { ...previous, replayed: true };

    // No await from here to the writes below. A check that yields is a check two
    // callers can both pass, which is exactly how two reservations each take the
    // last credit.
    const state = this.snapshot(request.ownerRef, request.workspaceId, request.category);
    const result = applyMovement(state, request.ops as readonly MovementOp[], {
      ownerRef: request.ownerRef,
      workspaceId: request.workspaceId,
      category: request.category,
      actor: request.actor,
      reason: request.reason,
      operationKey: request.operationKey,
      operationKind: request.operationKind,
      occurredAt: request.occurredAt,
      nextId: () => `ale_${randomUUID()}`,
      nextSeq: 0,
    });

    // ---- no await from here to the end: the check above and these writes are
    // one synchronous step, which is what gives the memory store its atomicity.
    if (result.pool !== null) {
      this.pools.set(poolKey(request.ownerRef, request.workspaceId, request.category), result.pool);
    }
    for (const allocation of result.allocations) {
      this.allocations.set(allocation.id, allocation);
    }
    const events: AllocationEvent[] = [];
    for (const event of result.events) {
      this.seq += 1;
      const stored: AllocationEvent = { ...event, seq: this.seq };
      this.events.push(stored);
      events.push(stored);
    }
    const applied: MovementApplied = {
      replayed: false,
      pool: result.pool,
      allocations: result.allocations,
      events,
    };
    this.applied.set(replayKey, applied);
    return applied;
  }

  async get(allocationId: string): Promise<Allocation | null> {
    return this.allocations.get(allocationId) ?? null;
  }

  async list(query: AllocationQuery): Promise<readonly Allocation[]> {
    const rows = [...this.allocations.values()].filter((allocation) => {
      if (allocation.ownerRef !== query.ownerRef) return false;
      if (query.workspaceId != null && allocation.workspaceId !== query.workspaceId) return false;
      if (query.category != null && allocation.category !== query.category) return false;
      if (query.targetKind != null && allocation.targetKind !== query.targetKind) return false;
      if (query.targetRef != null && allocation.targetRef !== query.targetRef) return false;
      if (query.state != null && allocation.state !== query.state) return false;
      return true;
    });
    rows.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.createdAt.localeCompare(b.createdAt);
    });
    return query.limit == null ? rows : rows.slice(0, query.limit);
  }

  async history(query: AllocationHistoryQuery): Promise<readonly AllocationEvent[]> {
    const rows = this.events.filter((event) => {
      if (event.ownerRef !== query.ownerRef) return false;
      if (query.workspaceId != null && event.workspaceId !== query.workspaceId) return false;
      if (query.category != null && event.category !== query.category) return false;
      if (query.allocationId != null && event.allocationId !== query.allocationId) return false;
      if (query.beforeSeq != null && event.seq >= query.beforeSeq) return false;
      return true;
    });
    const newestFirst = rows.sort((a, b) => b.seq - a.seq);
    return query.limit == null ? newestFirst : newestFirst.slice(0, query.limit);
  }

  async policy(
    ownerRef: string,
    workspaceId: string,
    category: CreditCategory,
  ): Promise<AllocationPolicyConfig | null> {
    return this.policies.get(poolKey(ownerRef, workspaceId, category)) ?? null;
  }

  async savePolicy(config: AllocationPolicyConfig): Promise<AllocationPolicyConfig> {
    this.policies.set(poolKey(config.ownerRef, config.workspaceId, config.category), config);
    return config;
  }
}
