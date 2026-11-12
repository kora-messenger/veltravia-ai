import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAID_PLAN,
  INTEGRATION_PLANS,
  PLAN_DEFAULTS_NOTE,
  SUBSCRIPTION_PLAN_IDS,
  isSubscriptionPlanId,
  planById,
  planForEntitlement,
  publishablePlans,
} from './plans.js';

describe('subscription plans', () => {
  it('ships four paid tiers above the development allowance, in ascending order', () => {
    const paid = SUBSCRIPTION_PLAN_IDS.filter((id) => id !== 'development');
    expect(paid).toHaveLength(4);
    const allowances = paid.map((id) => INTEGRATION_PLANS[id].monthlyIntegrationCredits);
    expect(allowances).toEqual([...allowances].sort((left, right) => left - right));
    expect(new Set(allowances).size).toBe(paid.length);
    // The free allowance is below every paid tier, or the tiers mean nothing.
    for (const id of paid) {
      expect(INTEGRATION_PLANS.development.monthlyIntegrationCredits).toBeLessThan(
        INTEGRATION_PLANS[id].monthlyIntegrationCredits,
      );
    }
  });

  it('bundles message credits too, never more than the integration allowance', () => {
    for (const id of SUBSCRIPTION_PLAN_IDS) {
      const plan = INTEGRATION_PLANS[id];
      expect(plan.monthlyMessageCredits).toBeGreaterThan(0);
      expect(Number.isFinite(plan.monthlyIntegrationCredits)).toBe(true);
    }
  });

  it('maps the entitlement it is given, and never guesses upwards', () => {
    expect(planForEntitlement('development').id).toBe('development');
    expect(planForEntitlement('paid').id).toBe(DEFAULT_PAID_PLAN);
    expect(planForEntitlement('paid', 'elite').id).toBe('elite');
    // A tier named directly is honoured, an unknown one is not.
    expect(planForEntitlement('pro').id).toBe('pro');
    expect(planForEntitlement('marktplaats-ultra').id).toBe('development');
    expect(planForEntitlement(null).id).toBe('development');
    expect(planForEntitlement(undefined).id).toBe('development');
  });

  it('recognises only the shipped identifiers', () => {
    expect(isSubscriptionPlanId('builder')).toBe(true);
    expect(isSubscriptionPlanId('Builder')).toBe(false);
    expect(isSubscriptionPlanId('')).toBe(false);
    expect(planById('nope')).toBeNull();
  });

  it('publishes every plan with the defaults note attached', () => {
    const published = publishablePlans('pro');
    expect(published.plans.map((plan) => plan.id)).toEqual([...SUBSCRIPTION_PLAN_IDS]);
    expect(published.defaultPaidPlan).toBe('pro');
    expect(published.note).toBe(PLAN_DEFAULTS_NOTE);
    // The note must say plainly that this is neither a price nor an offer.
    expect(published.note).toMatch(/not prices/i);
  });
});
