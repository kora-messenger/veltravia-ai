/**
 * Which plan an account is *actually* on, and why.
 *
 * Every gate in the API asks this one question, so the answer has to be
 * arguable in plain words. Four cases, and they are deliberately distinct
 * because the screen has to explain them differently:
 *
 *  - `subscription` - a live subscription; its plan's entitlements apply.
 *  - `development-allowance` - no subscription row at all; the included
 *    allowance applies. This is what every existing account is on.
 *  - `lapsed` - the subscription ran out or was cancelled past its period. The
 *    included allowance applies again, which is a *restriction*, not a bypass:
 *    the paid quotas and the managed provider keys are gone.
 *  - `suspended` - an operator held the account. Nothing is granted until it is
 *    reactivated, not even the included allowance, because a suspension must be
 *    able to stop an account completely.
 *
 * A plan that has been deactivated still applies to the accounts already on it:
 * deactivating means "stop assigning this", not "evict these people".
 */

import { assess } from './lifecycle.js';
import { DEVELOPMENT_PLAN_ID } from './plans.js';
import type { EffectivePlan, SubscriptionPlanDefinition, SubscriptionRecord } from './types.js';

export interface ResolveInput {
  readonly plans: readonly SubscriptionPlanDefinition[];
  readonly subscription: SubscriptionRecord | null;
  readonly now: string;
}

function fallbackPlan(
  plans: readonly SubscriptionPlanDefinition[],
): SubscriptionPlanDefinition | null {
  return plans.find((plan) => plan.id === DEVELOPMENT_PLAN_ID) ?? null;
}

export function resolveEffectivePlan(input: ResolveInput): EffectivePlan {
  const fallback = fallbackPlan(input.plans);
  if (fallback === null) {
    throw new Error('the development allowance plan is missing from the catalogue');
  }

  const { subscription } = input;
  if (subscription === null) {
    return {
      plan: fallback,
      source: 'development-allowance',
      status: 'none',
      entitled: true,
      reason: null,
      subscription: null,
      periodEnded: false,
      renewalDue: false,
    };
  }

  const assessment = assess(subscription, input.now);
  const plan = input.plans.find((entry) => entry.id === subscription.planId) ?? null;

  if (subscription.status === 'suspended') {
    return {
      plan: plan ?? fallback,
      source: 'suspended',
      status: 'suspended',
      entitled: false,
      reason:
        subscription.suspensionReason ?? 'This subscription is suspended until it is reactivated.',
      subscription,
      periodEnded: assessment.periodEnded,
      renewalDue: false,
    };
  }

  if (plan === null || assessment.status === 'expired') {
    return {
      plan: fallback,
      source: 'lapsed',
      status: assessment.status,
      entitled: true,
      reason:
        plan === null
          ? 'The plan this subscription named is no longer in the catalogue, so the included allowance applies.'
          : `The ${plan.name} plan ended on ${subscription.currentPeriodEnd.slice(0, 10)}, so the included allowance applies. Nothing was deleted: your projects, files and history are unchanged.`,
      subscription,
      periodEnded: assessment.periodEnded,
      renewalDue: false,
    };
  }

  return {
    plan,
    source: 'subscription',
    status: assessment.status,
    entitled: true,
    reason: null,
    subscription,
    periodEnded: assessment.periodEnded,
    renewalDue: assessment.renewalDue,
  };
}
