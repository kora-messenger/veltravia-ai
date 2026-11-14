/**
 * Workspace credit allocation vocabulary (Step 62).
 *
 * A workspace already holds credits in the wallet (Step 53). This package does
 * not hold a second balance: it splits the one the workspace already has into
 * named allowances so a project, a member or an agent can be given a budget, and
 * so a run can be refused *before* it draws on credit nobody meant it to have.
 *
 * Three rules are structural, not conventions:
 *
 *  1. **The categories never mix.** AI-token credit and integration credit are
 *     separate pools with separate allocations. There is no conversion function
 *     in this package, on purpose: a rate between them would be a pricing
 *     decision nobody has made.
 *  2. **An allocation is a ceiling, not a wallet.** `allocated` is the most the
 *     target may spend; `consumed` is what it did spend; `reserved` is credit
 *     promised to work in flight. Allocating does not create credit and
 *     reclaiming does not destroy it, because the workspace wallet stays the
 *     only thing that moves a balance.
 *  3. **Checking and writing are one step.** Billing asks `authorize`, which
 *     reserves inside the same transaction that reads the balance, so two runs
 *     cannot both be told there is room for the last thousand credits.
 */

export const CREDIT_CATEGORIES = ['ai_tokens', 'integration_credits'] as const;
export type CreditCategory = (typeof CREDIT_CATEGORIES)[number];

/** Labels a person reads in the UI for each category. */
export const CREDIT_CATEGORY_LABELS: Readonly<Record<CreditCategory, string>> = {
  ai_tokens: 'AI token credits',
  integration_credits: 'Integration credits',
};

export function isCreditCategory(value: unknown): value is CreditCategory {
  return value === 'ai_tokens' || value === 'integration_credits';
}

/** What a workspace may hand an allowance to. Closed: a new kind is a migration. */
export const ALLOCATION_TARGET_KINDS = ['member', 'project', 'agent', 'environment'] as const;
export type AllocationTargetKind = (typeof ALLOCATION_TARGET_KINDS)[number];

export function isAllocationTargetKind(value: unknown): value is AllocationTargetKind {
  return value === 'member' || value === 'project' || value === 'agent' || value === 'environment';
}

/**
 * How a workspace splits its pool. `manual` is the default: nothing is split
 * until somebody says so, which is exactly how the product behaved before this
 * step, so enabling allocations cannot silently change an existing account.
 */
export const ALLOCATION_POLICIES = [
  'manual',
  'equal',
  'project',
  'member',
  'priority',
  'restricted',
  'temporary',
  'automatic',
] as const;
export type AllocationPolicyName = (typeof ALLOCATION_POLICIES)[number];

export function isAllocationPolicyName(value: unknown): value is AllocationPolicyName {
  return (ALLOCATION_POLICIES as readonly unknown[]).includes(value);
}

/** Plain-language description, used by the API and the panel. */
export const ALLOCATION_POLICY_LABELS: Readonly<Record<AllocationPolicyName, string>> = {
  manual: 'Manual: allocations are made one at a time by an administrator.',
  equal: 'Equal: the pool is split evenly across the named targets.',
  project: 'Project based: the pool is split evenly across the workspace projects.',
  member: 'Member based: the pool is split evenly across the named members.',
  priority: 'Priority: targets are funded in priority order until the pool runs out.',
  restricted: 'Restricted: the allowance may only pay for the listed operations.',
  temporary: 'Temporary: the allowance expires and its unspent credit returns to the pool.',
  automatic: 'Automatic: a target may open its own allowance up to the configured ceiling.',
};

/** `exhausted` is derived from the numbers; the rest are decisions. */
export const ALLOCATION_STATES = ['active', 'revoked', 'expired'] as const;
export type AllocationLifecycleState = (typeof ALLOCATION_STATES)[number];

export interface Allocation {
  readonly id: string;
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly category: CreditCategory;
  readonly targetKind: AllocationTargetKind;
  readonly targetRef: string;
  /** Administrator-set ceiling on `allocated`. Null means the pool is the only ceiling. */
  readonly limit: number | null;
  /** Credit granted from the workspace pool. */
  readonly allocated: number;
  /** Credit promised to work in flight. */
  readonly reserved: number;
  /** Credit spent for good. */
  readonly consumed: number;
  /** Higher is funded first under the `priority` policy. */
  readonly priority: number;
  readonly policy: AllocationPolicyName;
  /** Operations a `restricted` allocation may pay for. Empty means every operation. */
  readonly allowedOperations: readonly string[];
  readonly state: AllocationLifecycleState;
  readonly expiresAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What is still spendable on one allocation. Never negative. */
export function allocationAvailable(allocation: Allocation): number {
  const available = allocation.allocated - allocation.consumed - allocation.reserved;
  return available < 0
    ? 0
    : round(allocation.allocated - allocation.consumed - allocation.reserved);
}

/** Unspent credit that is not promised to work: what reclaiming would return. */
export function allocationReclaimable(allocation: Allocation): number {
  return allocationAvailable(allocation);
}

export function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The workspace's ceiling for one category.
 *
 * `setPool` is the only way to change it, and it is refused when the new total
 * is below what is already allocated, so a pool can never be made smaller than
 * the promises drawn on it.
 */
export interface WorkspacePool {
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly category: CreditCategory;
  /** Most credit the workspace may have allocated at once, in this category. */
  readonly total: number;
  readonly note: string;
  readonly version: number;
  readonly updatedAt: string;
}

export const POOL_STATES = ['all'] as const;

export type AllocationEventKind =
  | 'pool_set'
  | 'allocated'
  | 'increased'
  | 'reduced'
  | 'reclaimed'
  | 'reserved'
  | 'settled'
  | 'released'
  | 'limit_set'
  | 'priority_set'
  | 'revoked'
  | 'expired'
  | 'grant_refused';

export interface AllocationEvent {
  readonly seq: number;
  readonly id: string;
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly category: CreditCategory;
  readonly allocationId: string | null;
  readonly targetKind: AllocationTargetKind | null;
  readonly targetRef: string | null;
  readonly kind: AllocationEventKind;
  /** Magnitude of the movement, never a sign. */
  readonly amount: number;
  readonly allocatedAfter: number;
  readonly consumedAfter: number;
  readonly reservedAfter: number;
  readonly operationKey: string | null;
  readonly operationKind: string | null;
  readonly actor: string;
  readonly reason: string;
  readonly occurredAt: string;
}

/** Hard ceilings. Passing one is a refusal, never a clamp. */
export const ALLOCATION_LIMITS = {
  /** One allocation's ceiling, in credits. */
  maxAllocationCredits: 1_000_000,
  /** A pool's ceiling, in credits. */
  maxPoolCredits: 10_000_000,
  /** Active allocations one workspace may hold per category. */
  maxAllocationsPerWorkspace: 200,
  /** Length of an actor or reason string we will store. */
  maxActorLength: 200,
  maxReasonLength: 400,
  /** Page size for a history read. */
  historyPageSize: 100,
} as const;

export type AllocationErrorCode =
  | 'POOL_EXCEEDED'
  | 'POOL_NOT_SET'
  | 'ALLOCATION_NOT_FOUND'
  | 'ALLOCATION_EXHAUSTED'
  | 'ALLOCATION_EXPIRED'
  | 'ALLOCATION_REVOKED'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_AMOUNT'
  | 'INVALID_STATE'
  | 'DUPLICATE'
  | 'OPERATION_NOT_ALLOWED'
  | 'TARGET_MISMATCH'
  | 'VERSION_CONFLICT';

export class AllocationError extends Error {
  constructor(
    readonly code: AllocationErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AllocationError';
  }
}

/**
 * Validates an amount at the edge. A string, a negative, a zero or more than
 * four decimal places is refused rather than coerced, because a credit number
 * that arrived as `"1e9"` is a caller mistake and not a budget.
 */
export function assertAmount(value: unknown, field = 'amount'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AllocationError('INVALID_AMOUNT', `${field} must be a finite number.`, 400, {
      field,
    });
  }
  if (value <= 0) {
    throw new AllocationError('INVALID_AMOUNT', `${field} must be greater than zero.`, 400, {
      field,
      value,
    });
  }
  if (value > ALLOCATION_LIMITS.maxAllocationCredits) {
    throw new AllocationError(
      'INVALID_AMOUNT',
      `${field} is above the maximum of ${ALLOCATION_LIMITS.maxAllocationCredits} credits.`,
      400,
      { field, value, maximum: ALLOCATION_LIMITS.maxAllocationCredits },
    );
  }
  const rounded = round(value);
  if (Math.abs(rounded - value) > 1e-9) {
    throw new AllocationError(
      'INVALID_AMOUNT',
      `${field} supports at most four decimal places.`,
      400,
      {
        field,
        value,
      },
    );
  }
  return rounded;
}

/** A pool ceiling may be zero (a workspace that has handed out nothing yet). */
export function assertPoolTotal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AllocationError(
      'INVALID_AMOUNT',
      'pool total must be zero or a positive number.',
      400,
    );
  }
  if (value > ALLOCATION_LIMITS.maxPoolCredits) {
    throw new AllocationError(
      'INVALID_AMOUNT',
      `pool total is above the maximum of ${ALLOCATION_LIMITS.maxPoolCredits} credits.`,
      400,
      { maximum: ALLOCATION_LIMITS.maxPoolCredits },
    );
  }
  return round(value);
}

export function assertActor(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AllocationError('INVALID_STATE', 'an actor is required.', 400);
  }
  return value.trim().slice(0, ALLOCATION_LIMITS.maxActorLength);
}

export function assertReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AllocationError('INVALID_STATE', 'a reason is required.', 400);
  }
  return value.trim().slice(0, ALLOCATION_LIMITS.maxReasonLength);
}

export function assertTargetRef(value: unknown, field = 'targetRef'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AllocationError('INVALID_STATE', `${field} is required.`, 400, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length > 200) {
    throw new AllocationError('INVALID_STATE', `${field} is too long.`, 400, { field });
  }
  return trimmed;
}
