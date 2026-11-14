/**
 * Allocation policies (Step 62).
 *
 * A policy is how a workspace decides *which* target gets *how much*, never
 * whether the workspace may hand out more than it has. That second question is
 * answered by the pool arithmetic in `movement.ts` for every policy, so a new
 * policy cannot widen a budget by being added.
 *
 * `distribute` is pure: it returns the split it would make, and the caller
 * applies it one allocation at a time through the book. That is why a partial
 * failure mid-way leaves earlier allocations in place rather than rolling a
 * database transaction back over decisions a person already saw.
 */

import {
  ALLOCATION_LIMITS,
  AllocationError,
  assertAmount,
  round,
  type AllocationPolicyName,
  type AllocationTargetKind,
  type CreditCategory,
} from './types.js';

/** A target a policy may fund. `priority` is only read by the priority policy. */
export interface DistributionTarget {
  readonly kind: AllocationTargetKind;
  readonly ref: string;
  readonly priority?: number;
  /** Optional per-target ceiling the split must respect. */
  readonly limit?: number | null;
  readonly allowedOperations?: readonly string[];
  readonly expiresAt?: string | null;
}

export interface DistributionPlanned {
  readonly target: DistributionTarget;
  readonly amount: number;
}

export interface DistributionResult {
  readonly policy: AllocationPolicyName;
  readonly budget: number;
  readonly planned: readonly DistributionPlanned[];
  readonly unallocated: number;
  readonly note: string;
}

/** Policies that split a pool on their own. The rest are modifiers. */
export const DISTRIBUTING_POLICIES: readonly AllocationPolicyName[] = [
  'equal',
  'project',
  'member',
  'priority',
];

export const MODIFIER_POLICIES: readonly AllocationPolicyName[] = [
  'restricted',
  'temporary',
  'automatic',
];

/** Workspace-level configuration: the default rule and the automatic ceiling. */
export interface AllocationPolicyConfig {
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly category: CreditCategory;
  readonly defaultPolicy: AllocationPolicyName;
  /**
   * Ceiling an `automatic` target may open for itself without an administrator.
   * Zero disables automatic allocation entirely.
   */
  readonly autoLimit: number;
  /** Most of the pool one target may hold, as a percentage. 100 disables the cap. */
  readonly maxTargetSharePct: number;
  readonly updatedAt: string;
}

export const DEFAULT_ALLOCATION_POLICY: Omit<
  AllocationPolicyConfig,
  'ownerRef' | 'workspaceId' | 'category' | 'updatedAt'
> = {
  defaultPolicy: 'manual',
  autoLimit: 0,
  maxTargetSharePct: 100,
};

/**
 * Platform maxima, from the deployment's environment. A workspace may be more
 * restrictive than these and never less, so an operator can cap what any one
 * workspace hands out without editing customer rows.
 */
export interface PlatformAllocationLimits {
  readonly maxPoolCredits: number;
  readonly maxAllocationCredits: number;
  readonly maxAllocationsPerWorkspace: number;
  /** Percentage of a pool one target may hold, the strictest of this and the workspace's. */
  readonly maxTargetSharePct: number;
}

export function platformAllocationLimits(
  env: NodeJS.ProcessEnv = process.env,
): PlatformAllocationLimits {
  const int = (name: string, fallback: number, max: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(Math.trunc(parsed), max);
  };
  return {
    maxPoolCredits: int('VELTRAVIA_MAX_POOL_CREDITS', ALLOCATION_LIMITS.maxPoolCredits, 1e9),
    maxAllocationCredits: int(
      'VELTRAVIA_MAX_ALLOCATION_CREDITS',
      ALLOCATION_LIMITS.maxAllocationCredits,
      1e9,
    ),
    maxAllocationsPerWorkspace: int(
      'VELTRAVIA_MAX_ALLOCATIONS_PER_WORKSPACE',
      ALLOCATION_LIMITS.maxAllocationsPerWorkspace,
      10_000,
    ),
    maxTargetSharePct: int('VELTRAVIA_MAX_TARGET_SHARE_PCT', 100, 100),
  };
}

/**
 * The largest amount a policy may hand one target given the configuration and
 * the platform ceiling. Zero means "no cap from configuration".
 */
export function targetCeiling(
  poolTotal: number,
  config: Pick<AllocationPolicyConfig, 'maxTargetSharePct'>,
  platform: Pick<PlatformAllocationLimits, 'maxTargetSharePct' | 'maxAllocationCredits'>,
): number {
  const pct = Math.min(config.maxTargetSharePct, platform.maxTargetSharePct);
  const fromShare = pct >= 100 ? poolTotal : round((poolTotal * pct) / 100);
  return Math.min(fromShare, platform.maxAllocationCredits);
}

/**
 * Splits `budget` across `targets`.
 *
 * The split is exact: the parts always add up to the budget, because a
 * remainder that vanished would make the panel's numbers disagree with the
 * ledger. The remainder goes to the first target in the order given (priority
 * order for `priority`), so repeating the same call is deterministic.
 */
export function distribute(input: {
  readonly policy: AllocationPolicyName;
  readonly targets: readonly DistributionTarget[];
  readonly budget: number;
  readonly category: CreditCategory;
  readonly maxTargetSharePct?: number;
  readonly platform?: Pick<PlatformAllocationLimits, 'maxTargetSharePct' | 'maxAllocationCredits'>;
}): DistributionResult {
  const policy = input.policy;
  const budget = assertAmount(input.budget, 'budget');

  if (policy === 'manual') {
    throw new AllocationError(
      'INVALID_STATE',
      'The manual policy allocates one target at a time. Name the target and the amount.',
      400,
      { policy },
    );
  }
  if (policy === 'automatic') {
    throw new AllocationError(
      'INVALID_STATE',
      'The automatic policy opens allowances on demand. Configure its ceiling instead of distributing.',
      400,
      { policy },
    );
  }

  const filtered = input.targets.filter((target) => {
    if (policy === 'project') return target.kind === 'project';
    if (policy === 'member') return target.kind === 'member';
    return true;
  });
  if (filtered.length === 0) {
    throw new AllocationError(
      'INVALID_STATE',
      'There are no targets of that kind to allocate credit to.',
      400,
      { policy },
    );
  }
  if (filtered.length > ALLOCATION_LIMITS.maxAllocationsPerWorkspace) {
    throw new AllocationError(
      'LIMIT_EXCEEDED',
      'That is more targets than one workspace may hold allocations for.',
      400,
      { targets: filtered.length, maximum: ALLOCATION_LIMITS.maxAllocationsPerWorkspace },
    );
  }

  const ceiling =
    input.platform === undefined
      ? null
      : targetCeiling(
          budget,
          { maxTargetSharePct: input.maxTargetSharePct ?? 100 },
          input.platform,
        );

  const ordered =
    policy === 'priority'
      ? [...filtered].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      : filtered;

  const planned: DistributionPlanned[] = [];
  let remaining = budget;

  if (policy === 'priority') {
    // Fund in order, each taking an even share of what is left, so the first
    // target is never starved and the last still gets something.
    ordered.forEach((target, index) => {
      const slots = ordered.length - index;
      let amount = round(remaining / slots);
      if (target.limit !== null && target.limit !== undefined && amount > target.limit) {
        amount = round(target.limit);
      }
      if (ceiling !== null && amount > ceiling) amount = ceiling;
      if (amount <= 0) return;
      planned.push({ target, amount });
      remaining = round(remaining - amount);
    });
  } else {
    const each = round(budget / ordered.length);
    let assigned = 0;
    ordered.forEach((target, index) => {
      // The first target absorbs the rounding remainder, so the parts add up to
      // the budget exactly rather than leaving a few thousandths behind.
      let amount = index === 0 ? round(budget - each * (ordered.length - 1)) : each;
      if (target.limit !== null && target.limit !== undefined && amount > target.limit) {
        amount = round(target.limit);
      }
      if (ceiling !== null && amount > ceiling) amount = ceiling;
      planned.push({ target, amount });
      assigned = round(assigned + amount);
    });
    remaining = round(budget - assigned);
  }

  return {
    policy,
    budget,
    planned,
    unallocated: remaining < 0 ? 0 : remaining,
    note:
      policy === 'priority'
        ? 'Funded in priority order; each target took an even share of what remained.'
        : ceiling === null
          ? 'Split evenly, with the rounding remainder on the first target.'
          : `Split evenly under a per-target ceiling of ${ceiling} credits.`,
  };
}
