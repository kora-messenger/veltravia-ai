/**
 * Reading a plan's entitlements.
 *
 * One function answers "may this account do X", and every gate in the API calls
 * it rather than reading a plan field directly. Two rules make the answers safe:
 *
 *  - **Absent is not allowed.** A key the plan does not state is a refusal, so a
 *    new entitlement added to the registry tomorrow grants nobody anything until
 *    a plan says so.
 *  - **A quantity is a ceiling, not an allowance to spend.** The caller declares
 *    how much it needs; the answer is yes or no. Nothing is decremented here,
 *    because what an account has actually used is the meter's number, not this
 *    package's copy of it.
 */

import {
  SubscriptionError,
  entitlementDefinition,
  type EntitlementKey,
  type EntitlementValue,
  type PlanEntitlements,
  type SubscriptionPlanDefinition,
} from './types.js';

export interface EntitlementDecision {
  readonly key: string;
  readonly allowed: boolean;
  /** What the plan states: `true`, a number, `null` (unlimited) or `undefined`. */
  readonly value: EntitlementValue | undefined;
  /** Plain words for a refusal, safe to show. Null when allowed. */
  readonly reason: string | null;
}

/** The value a plan states for a key, or `undefined` when it states nothing. */
export function entitlementValue(
  plan: Pick<SubscriptionPlanDefinition, 'entitlements'>,
  key: EntitlementKey,
): EntitlementValue | undefined {
  const entitlements: PlanEntitlements = plan.entitlements;
  return Object.prototype.hasOwnProperty.call(entitlements, key) ? entitlements[key] : undefined;
}

/**
 * Is a flag on?
 *
 * `null` counts as on for a flag because an operator writing `"key": null` in a
 * plan means "granted, no number attached", not "revoked". Revoking is writing
 * `false` or removing the key.
 */
export function hasEntitlement(
  plan: Pick<SubscriptionPlanDefinition, 'entitlements'>,
  key: EntitlementKey,
): boolean {
  const value = entitlementValue(plan, key);
  return value === true || value === null;
}

/**
 * Does a quantity have room for `requested`?
 *
 * `null` is unlimited. An absent key is zero. A negative requested amount is
 * treated as zero so a caller cannot smuggle a pass with `-1`.
 */
export function withinQuantity(
  plan: Pick<SubscriptionPlanDefinition, 'entitlements'>,
  key: EntitlementKey,
  requested: number,
): boolean {
  const value = entitlementValue(plan, key);
  if (value === null) return true;
  if (typeof value !== 'number') return false;
  const needed = Number.isFinite(requested) ? Math.max(0, requested) : 0;
  return needed <= value;
}

/** The ceiling a quantity states, or null when unlimited / not granted. */
export function quantityLimit(
  plan: Pick<SubscriptionPlanDefinition, 'entitlements'>,
  key: EntitlementKey,
): number | null {
  const value = entitlementValue(plan, key);
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

/**
 * The single gate.
 *
 * `requested` is how much of a quantity the caller needs; it is ignored for a
 * flag. An unknown key is a 400 rather than a silent yes, because a typo in a
 * gate must never open a door.
 */
export function checkEntitlement(
  plan: SubscriptionPlanDefinition,
  key: EntitlementKey,
  requested = 0,
): EntitlementDecision {
  const definition = entitlementDefinition(key);
  if (definition === null) {
    throw new SubscriptionError(
      'UNKNOWN_ENTITLEMENT',
      `"${key}" is not an entitlement this build knows about.`,
      400,
      { key },
    );
  }
  const value = entitlementValue(plan, key);

  if (definition.kind === 'flag') {
    const allowed = value === true || value === null;
    return {
      key,
      allowed,
      value,
      reason: allowed
        ? null
        : `The ${plan.name} plan does not include ${definition.label.toLowerCase()}.`,
    };
  }

  const allowed = withinQuantity(plan, key, requested);
  const ceiling = quantityLimit(plan, key);
  const reason = allowed
    ? null
    : ceiling === 0
      ? `The ${plan.name} plan does not include ${definition.label.toLowerCase()}.`
      : `The ${plan.name} plan allows ${ceiling ?? 0} ${definition.label.toLowerCase()}; this needs ${requested}.`;

  return { key, allowed, value, reason };
}

/** Refuses, or returns the decision. The error carries the key for the client. */
export function assertEntitlement(
  plan: SubscriptionPlanDefinition,
  key: EntitlementKey,
  requested = 0,
): EntitlementDecision {
  const decision = checkEntitlement(plan, key, requested);
  if (!decision.allowed) {
    throw new SubscriptionError(
      'NOT_IN_PLAN',
      decision.reason ?? 'Not included in this plan.',
      403,
      {
        entitlement: key,
        planId: plan.id,
      },
    );
  }
  return decision;
}

/**
 * Which of the registered keys a plan grants, for a screen.
 *
 * Entries carry `granted` and the stated value so the UI prints the plan's own
 * words instead of guessing from a number.
 */
export function entitlementSummary(plan: SubscriptionPlanDefinition): readonly {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly kind: 'flag' | 'quantity';
  readonly granted: boolean;
  readonly value: EntitlementValue | undefined;
}[] {
  const keys = Object.keys(plan.entitlements).sort();
  return keys.flatMap((key) => {
    const definition = entitlementDefinition(key);
    if (definition === null) return [];
    const value = plan.entitlements[key];
    const granted =
      definition.kind === 'flag' ? value === true || value === null : value !== undefined;
    return [
      {
        key,
        label: definition.label,
        group: definition.group,
        description: definition.description,
        kind: definition.kind,
        granted,
        value,
      },
    ];
  });
}

/**
 * Plan entitlements merged over a set of defaults, so a caller can reason about
 * every key at once. Only used for display and for seeding a plan from another;
 * enforcement always reads the plan itself, because a merge is a place a wrong
 * default could hide.
 */
export function withDefaults(
  entitlements: PlanEntitlements,
  defaults: PlanEntitlements,
): PlanEntitlements {
  return { ...defaults, ...entitlements };
}
