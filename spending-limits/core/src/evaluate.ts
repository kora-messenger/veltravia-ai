/**
 * The decision (Step 59).
 *
 * This function answers one question and nothing else: may this operation start,
 * and if not, which rule stopped it? It reads no clock, writes nothing and knows
 * no database - the usage it reasons about is handed to it, already read from
 * the charge lanes. That is what makes it testable across a month boundary, a
 * concurrency race and a restart without touching a store.
 *
 * Three rules keep the answer honest:
 *
 *  1. **Reserved credit counts.** A hold is credit promised to work that has
 *     started. Allowing a second operation because the first has not settled yet
 *     would let one allowance be spent twice.
 *  2. **The tightest applicable rule decides.** Workspace, user and project
 *     limits all apply; the smallest remaining allowance is the answer, and the
 *     refusal names the rule that produced it.
 *  3. **A soft limit never blocks.** It warns. Turning a soft limit into a
 *     refusal because it was close would make the two modes the same thing.
 */

import { windowFor } from './periods.js';
import {
  DEFAULT_PLATFORM_LIMITS,
  creditRound,
  type LimitDecisionReason,
  type LimitScope,
  type LimitStatus,
  type LimitViolation,
  type LimitWarning,
  type PlatformLimitPolicy,
  type SpendCategory,
  type SpendDecision,
  type SpendSample,
  type SpendWindow,
  type SpendingLimitRule,
} from './types.js';

/** One policy in force for this request, with where it came from. */
export interface AppliedPolicy {
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly rules: readonly SpendingLimitRule[];
  readonly perOperationLimit: number | null;
  readonly maxReservedCredits: number | null;
  /** `owner` when a person set it, `plan`/`default` when inherited. */
  readonly source: 'owner' | 'workspace' | 'project' | 'platform-default' | 'platform-ceiling';
  /** True when this policy is a platform default rather than a user's own. */
  readonly inherited?: boolean;
}

export interface EvaluateInput {
  readonly category: SpendCategory;
  /** Credits this operation is estimated to need. Zero still evaluates warnings. */
  readonly requested: number;
  readonly policies: readonly AppliedPolicy[];
  /** Usage per window key, read from the charge lanes. */
  readonly usage: ReadonlyMap<string, readonly SpendSample[]>;
  /** Credit currently held by work in flight across all categories. */
  readonly heldCredits: number;
  readonly platform?: PlatformLimitPolicy;
  readonly now: Date;
}

/** Applicable samples for a window, summed across the target's categories. */
function usageFor(
  samples: readonly SpendSample[],
  target: SpendingLimitRule['target'],
): { committed: number; reserved: number } {
  let committed = 0;
  let reserved = 0;
  for (const sample of samples) {
    // A category rule counts its own category; an `all` rule counts every one.
    if (target !== 'all' && sample.category !== target) continue;
    committed += sample.committed;
    reserved += sample.reserved;
  }
  return { committed: creditRound(committed), reserved: creditRound(reserved) };
}

function statusOf(input: {
  rule: SpendingLimitRule;
  policy: AppliedPolicy;
  window: SpendWindow;
  consumed: number;
  committed: number;
  reserved: number;
}): LimitStatus {
  const limit = input.rule.limit as number;
  const consumed = input.consumed;
  const remaining = creditRound(Math.max(0, limit - consumed));
  const ratio = limit <= 0 ? (consumed > 0 ? 1 : 0) : consumed / limit;
  const crossed = input.rule.warnAt.filter((threshold) => ratio >= threshold);
  return {
    ruleId: input.rule.id,
    scope: input.policy.scope,
    workspaceId: input.policy.workspaceId,
    projectId: input.policy.projectId,
    target: input.rule.target,
    period: input.rule.period,
    mode: input.rule.mode,
    window: input.window,
    limit,
    committed: input.committed,
    reserved: input.reserved,
    consumed,
    remaining,
    ratio: Math.round(ratio * 10_000) / 10_000,
    state: consumed >= limit ? 'reached' : crossed.length > 0 ? 'warning' : 'ok',
    crossed,
    source: input.policy.source,
  };
}

function scopeOf(policy: AppliedPolicy): string {
  if (policy.scope === 'project') return `project:${policy.projectId ?? ''}`;
  if (policy.scope === 'workspace') return `workspace:${policy.workspaceId ?? ''}`;
  return 'user';
}

export function evaluateSpending(input: EvaluateInput): SpendDecision {
  const platform = input.platform ?? DEFAULT_PLATFORM_LIMITS;
  const requested = creditRound(Math.max(0, input.requested));
  const statuses: LimitStatus[] = [];
  const warnings: LimitWarning[] = [];

  for (const policy of input.policies) {
    for (const rule of policy.rules) {
      if (rule.limit === null) continue;
      if (rule.target !== 'all' && rule.target !== input.category) continue;

      const window = windowFor(
        {
          period: rule.period,
          periodDays: rule.periodDays,
          periodAnchor: rule.periodAnchor,
        },
        input.now,
      );
      const samples = input.usage.get(window.key) ?? [];
      const { committed, reserved } = usageFor(samples, rule.target);
      const status = statusOf({
        rule,
        policy,
        window,
        consumed: creditRound(committed + reserved),
        committed,
        reserved,
      });
      statuses.push(status);

      for (const threshold of status.crossed) {
        warnings.push({
          ruleId: rule.id,
          scope: policy.scope,
          workspaceId: policy.workspaceId,
          projectId: policy.projectId,
          windowKey: window.key,
          threshold,
          limit: status.limit,
          consumed: status.consumed,
          dedupeKey: `${scopeOf(policy)}|${rule.id}|${window.key}|${String(threshold)}`,
        });
      }
    }
  }

  const configured =
    statuses.length > 0 ||
    input.policies.some(
      (policy) => policy.perOperationLimit !== null || policy.maxReservedCredits !== null,
    );
  const enforcement = platform.enforcementDisabled
    ? 'disabled'
    : configured
      ? 'enforced'
      : 'unconfigured';

  const violation = enforcement === 'enforced' ? firstViolation(input, statuses, requested) : null;

  // The tightest remaining allowance across every applicable window. This is the
  // number a UI shows as "you can still spend", and it is a floor, never a sum.
  const remainingValues = statuses.map((status) => status.remaining);
  const allowance = remainingValues.length === 0 ? null : Math.min(...remainingValues);

  return {
    allowed: violation === null,
    reason: violation === null ? (configured ? 'allowed' : 'no-policy') : violation.reason,
    enforcement,
    category: input.category,
    requested,
    allowance,
    statuses: statuses.sort((left, right) => left.remaining - right.remaining),
    violation,
    warnings,
    evaluatedAt: input.now.toISOString(),
  };
}

function firstViolation(
  input: EvaluateInput,
  statuses: readonly LimitStatus[],
  requested: number,
): LimitViolation | null {
  // Most specific first: a single operation above its own cap is a clearer
  // answer than the monthly window it also happens to cross.
  let tightest: LimitViolation | null = null;
  for (const policy of input.policies) {
    if (policy.perOperationLimit === null || requested <= policy.perOperationLimit) continue;
    const candidate: LimitViolation = {
      reason: 'per-operation-limit',
      message: `This operation is estimated at ${requested} credits, above the ${policy.perOperationLimit} credit ceiling for a single operation.`,
      ruleId: null,
      scope: policy.scope,
      limit: policy.perOperationLimit,
      requested,
      consumed: null,
      remaining: policy.perOperationLimit,
      window: null,
    };
    if (tightest === null) tightest = candidate;
  }
  if (tightest !== null) return tightest;

  const blocking = statuses.filter(
    (status) => status.mode === 'hard' && creditRound(status.consumed + requested) > status.limit,
  );
  if (blocking.length > 0) {
    const worst = blocking.reduce((left, right) =>
      right.remaining < left.remaining ? right : left,
    );
    return {
      reason: 'hard-limit',
      message:
        worst.consumed >= worst.limit
          ? `Your ${worst.period} ${worst.target === 'all' ? 'spending' : worst.target.replace('_', ' ')} limit of ${worst.limit} credits is already used up for this ${worst.window.label}. It resets at ${worst.window.end}.`
          : `This operation needs ${requested} credits and your ${worst.period} ${worst.target === 'all' ? 'spending' : worst.target.replace('_', ' ')} limit leaves ${worst.remaining}. The limit resets at ${worst.window.end}.`,
      ruleId: worst.ruleId,
      scope: worst.scope,
      limit: worst.limit,
      requested,
      consumed: worst.consumed,
      remaining: worst.remaining,
      window: worst.window,
    };
  }

  for (const policy of input.policies) {
    if (policy.maxReservedCredits === null) continue;
    if (creditRound(input.heldCredits + requested) <= policy.maxReservedCredits) continue;
    return {
      reason: 'reserved-cap',
      message: `Work in flight is already holding ${input.heldCredits} credits. Your ceiling on held credit is ${policy.maxReservedCredits}, and this operation needs ${requested} more.`,
      ruleId: null,
      scope: policy.scope,
      limit: policy.maxReservedCredits,
      requested,
      consumed: input.heldCredits,
      remaining: creditRound(Math.max(0, policy.maxReservedCredits - input.heldCredits)),
      window: null,
    };
  }

  return null;
}

/** Every window this category's rules need, so the caller reads each one once. */
export function windowsFor(
  policies: readonly AppliedPolicy[],
  category: SpendCategory,
  now: Date,
): readonly { rule: SpendingLimitRule; window: SpendWindow }[] {
  const out: { rule: SpendingLimitRule; window: SpendWindow }[] = [];
  const seen = new Set<string>();
  for (const policy of policies) {
    for (const rule of policy.rules) {
      if (rule.limit === null) continue;
      if (rule.target !== 'all' && rule.target !== category) continue;
      const window = windowFor(
        { period: rule.period, periodDays: rule.periodDays, periodAnchor: rule.periodAnchor },
        now,
      );
      const key = `${rule.period}|${String(rule.periodDays)}|${String(rule.periodAnchor)}|${window.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule, window });
    }
  }
  return out;
}

export type { LimitDecisionReason, SpendDecision, SpendCategory };
