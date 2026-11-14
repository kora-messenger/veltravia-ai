/**
 * The allocation store port (Step 62).
 *
 * One method does the writing (`apply`), and it takes a list of operations plus
 * the context an audit event needs. That shape is deliberate: it is small enough
 * for the in-memory store to run synchronously and for PostgreSQL to run inside
 * a single transaction with `for update` locks, which is what makes two
 * concurrent reservations unable to both see the last credit.
 */

import type { AllocationPolicyConfig } from './policies.js';
import type { MovementOp, AllocationState } from './movement.js';
import type {
  Allocation,
  AllocationEvent,
  AllocationLifecycleState,
  AllocationTargetKind,
  CreditCategory,
  WorkspacePool,
} from './types.js';

export interface MovementRequest {
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly category: CreditCategory;
  /** Unique per owner. A retried request finds its own result instead of doubling it. */
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly reason: string;
  readonly operationKey: string | null;
  readonly operationKind: string | null;
  readonly occurredAt: string;
  readonly ops: readonly MovementOp[];
}

export interface MovementApplied {
  readonly replayed: boolean;
  readonly pool: WorkspacePool | null;
  /** Every allocation in the workspace and category after the movement. */
  readonly allocations: readonly Allocation[];
  readonly events: readonly AllocationEvent[];
}

export interface AllocationQuery {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
  readonly category?: CreditCategory | null;
  readonly targetKind?: AllocationTargetKind | null;
  readonly targetRef?: string | null;
  readonly state?: AllocationLifecycleState | null;
  readonly limit?: number | null;
}

export interface AllocationHistoryQuery {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
  readonly category?: CreditCategory | null;
  readonly allocationId?: string | null;
  readonly limit?: number | null;
  readonly beforeSeq?: number | null;
}

export interface AllocationStore {
  /** The pool and every allocation in it, loaded together for one transaction. */
  load(ownerRef: string, workspaceId: string, category: CreditCategory): Promise<AllocationState>;
  apply(request: MovementRequest): Promise<MovementApplied>;
  get(allocationId: string): Promise<Allocation | null>;
  list(query: AllocationQuery): Promise<readonly Allocation[]>;
  history(query: AllocationHistoryQuery): Promise<readonly AllocationEvent[]>;
  policy(
    ownerRef: string,
    workspaceId: string,
    category: CreditCategory,
  ): Promise<AllocationPolicyConfig | null>;
  savePolicy(config: AllocationPolicyConfig): Promise<AllocationPolicyConfig>;
}
