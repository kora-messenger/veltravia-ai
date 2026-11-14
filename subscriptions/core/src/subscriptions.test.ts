/**
 * The subscription rules, as rules.
 *
 * These tests never touch a database or a route: they pin the four statements
 * the rest of Step 60 relies on - absent means denied, a period that has ended
 * is over, a renewal consumes exactly one period, and a suspended account has
 * nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_PLAN_ID,
  InMemorySubscriptionStore,
  PLAN_DEFAULTS_NOTE,
  SubscriptionConflictError,
  SubscriptionError,
  addMonths,
  applyRenewal,
  assess,
  assignSubscription,
  cancelSubscription,
  catalogueFor,
  changePlan,
  checkEntitlement,
  developmentPlan,
  entitlementSummary,
  findPlan,
  hasEntitlement,
  normalizePlanDraft,
  periodFor,
  reactivateSubscription,
  resolveEffectivePlan,
  seedPlans,
  suspendSubscription,
  withinQuantity,
  type SubscriptionRecord,
} from './index.js';
import { INTEGRATION_PLANS } from '@veltravia/integration-credits-core';

const NOW = '2026-03-15T12:00:00.000Z';
const plans = seedPlans(() => NOW);
const development = developmentPlan(() => NOW);
const builder = findPlan(plans, 'builder');
if (builder === null) throw new Error('builder seed missing');

function subscription(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    ...assignSubscription({
      id: 'sub_1',
      ownerRef: 'owner-a',
      plan: builder,
      now: NOW,
      actor: 'test',
    }),
    ...overrides,
  };
}

describe('the shipped catalogue', () => {
  it('carries the Step 56 tier numbers forward unchanged', () => {
    for (const id of ['development', 'starter', 'builder', 'pro', 'elite'] as const) {
      const plan = findPlan(plans, id);
      expect(plan).not.toBeNull();
      expect(plan?.monthlyIntegrationCredits).toBe(INTEGRATION_PLANS[id].monthlyIntegrationCredits);
      expect(plan?.monthlyMessageCredits).toBe(INTEGRATION_PLANS[id].monthlyMessageCredits);
    }
  });

  it('says in the same breath that these are defaults, not prices', () => {
    expect(PLAN_DEFAULTS_NOTE).toMatch(/not prices/i);
    expect(PLAN_DEFAULTS_NOTE).toMatch(/no checkout/i);
    for (const plan of plans) {
      expect(JSON.stringify(plan)).not.toMatch(/price|usd|ngn|₦|\$/i);
    }
  });

  it('orders the catalogue by rank and honours visibility and activation', () => {
    const ordered = catalogueFor(plans).map((plan) => plan.id);
    expect(ordered).toEqual(['development', 'starter', 'builder', 'pro', 'elite']);
    const hidden = plans.map((plan) => (plan.id === 'pro' ? { ...plan, visible: false } : plan));
    expect(catalogueFor(hidden).map((plan) => plan.id)).not.toContain('pro');
    const off = plans.map((plan) => (plan.id === 'elite' ? { ...plan, active: false } : plan));
    expect(catalogueFor(off).map((plan) => plan.id)).not.toContain('elite');
  });

  it('lets nobody buy their way in without a payment step', () => {
    for (const plan of plans) {
      expect(plan.selfService).toBe(plan.id === DEVELOPMENT_PLAN_ID);
    }
  });

  it('grants the features this build already ships on the included allowance', () => {
    for (const key of [
      'features.coding_agent',
      'features.superagent',
      'features.app_builder',
      'features.integrations',
      'api.access',
    ]) {
      expect(hasEntitlement(development, key)).toBe(true);
    }
  });
});

describe('entitlements', () => {
  it('treats a key a plan does not state as a refusal', () => {
    const sparse = { ...development, entitlements: {} };
    expect(hasEntitlement(sparse, 'features.coding_agent')).toBe(false);
    const decision = checkEntitlement(sparse, 'features.coding_agent');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('does not include');
  });

  it('reads null as unlimited for a quantity and zero for an absent one', () => {
    const plan = {
      ...development,
      entitlements: { ...development.entitlements, 'limits.projects': null },
    };
    expect(withinQuantity(plan, 'limits.projects', 10_000)).toBe(true);
    const capped = {
      ...development,
      entitlements: { ...development.entitlements, 'limits.projects': 3 },
    };
    expect(withinQuantity(capped, 'limits.projects', 3)).toBe(true);
    expect(withinQuantity(capped, 'limits.projects', 4)).toBe(false);
    expect(withinQuantity(sparseOf(development), 'limits.projects', 1)).toBe(false);
  });

  it('refuses to answer for a key it does not know', () => {
    expect(() => checkEntitlement(development, 'features.teleportation')).toThrow(
      SubscriptionError,
    );
    try {
      checkEntitlement(development, 'features.teleportation');
    } catch (error) {
      expect((error as SubscriptionError).code).toBe('UNKNOWN_ENTITLEMENT');
      expect((error as SubscriptionError).status).toBe(400);
    }
  });

  it('summarises a plan from its own row, not from a guess', () => {
    const summary = entitlementSummary(builder);
    const coding = summary.find((entry) => entry.key === 'features.coding_agent');
    expect(coding?.granted).toBe(true);
    expect(summary.every((entry) => entry.label.length > 0)).toBe(true);
  });
});

function sparseOf(plan: typeof development) {
  const { 'limits.projects': _removed, ...rest } = plan.entitlements;
  return { ...plan, entitlements: rest };
}

describe('plan validation', () => {
  it('accepts a well formed plan', () => {
    const plan = normalizePlanDraft(
      {
        id: 'studio',
        name: 'Studio',
        description: 'A plan an operator defined.',
        rank: 25,
        monthlyMessageCredits: 300,
        monthlyIntegrationCredits: 4_000,
        entitlements: { 'features.coding_agent': true, 'limits.projects': 5 },
        quotas: { concurrentJobs: 4 },
      },
      { requireId: true },
    );
    expect(plan.id).toBe('studio');
    expect(plan.entitlements['limits.projects']).toBe(5);
  });

  it('refuses a boolean written as text, because "false" is truthy', () => {
    expect(() =>
      normalizePlanDraft(
        { id: 'studio', name: 'Studio', entitlements: { 'features.coding_agent': 'true' } },
        { requireId: true },
      ),
    ).toThrow(/true or false/);
  });

  it('refuses an entitlement it does not know, naming the field', () => {
    try {
      normalizePlanDraft(
        { id: 'studio', name: 'Studio', entitlements: { 'features.time_travel': true } },
        { requireId: true },
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as SubscriptionError).code).toBe('INVALID_PLAN');
      expect((error as SubscriptionError).details['field']).toBe(
        'entitlements.features.time_travel',
      );
    }
  });

  it('refuses a quota this build does not measure', () => {
    expect(() =>
      normalizePlanDraft(
        { id: 'studio', name: 'Studio', quotas: { unicorns: 1 } },
        { requireId: true },
      ),
    ).toThrow(/not a quota/);
  });

  it('refuses to deactivate the allowance a lapsed subscription falls back to', () => {
    expect(() =>
      normalizePlanDraft(
        { id: DEVELOPMENT_PLAN_ID, name: 'Included allowance', active: false },
        { requireId: true },
      ),
    ).toThrow(/cannot be deactivated/);
  });

  it('refuses a self-selectable plan that cannot be assigned', () => {
    expect(() =>
      normalizePlanDraft(
        { id: 'studio', name: 'Studio', active: false, selfService: true },
        { requireId: true },
      ),
    ).toThrow(/self-selectable/);
  });
});

describe('periods', () => {
  it('adds a calendar month and clamps a short one', () => {
    expect(addMonths('2026-01-31T00:00:00.000Z', 1)).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths('2026-12-15T00:00:00.000Z', 1)).toBe('2027-01-15T00:00:00.000Z');
    expect(periodFor('2026-03-15T12:00:00.000Z')).toEqual({
      start: '2026-03-15T12:00:00.000Z',
      end: '2026-04-15T12:00:00.000Z',
    });
  });
});

describe('lifecycle', () => {
  it('is active and entitled inside its first period', () => {
    const record = subscription();
    const result = assess(record, NOW);
    expect(result.status).toBe('active');
    expect(result.entitled).toBe(true);
    expect(result.daysRemaining).toBe(31);
  });

  it('expires by the clock when renewal is off, without anybody running a job', () => {
    const record = subscription({ renews: false });
    const result = assess(record, '2026-04-16T00:00:00.000Z');
    expect(result.status).toBe('expired');
    expect(result.entitled).toBe(false);
    expect(result.stale).toBe(true);
  });

  it('becomes past due when renewal is on and the period ran out', () => {
    const record = subscription();
    const result = assess(record, '2026-04-16T00:00:00.000Z');
    expect(result.status).toBe('past_due');
    expect(result.renewalDue).toBe(true);
    // Access continues while the renewal is outstanding: the work already in
    // flight must not be cut off by a billing hiccup.
    expect(result.entitled).toBe(true);
  });

  it('advances exactly one period per renewal, and reports what it consumed', () => {
    const record = subscription();
    const first = applyRenewal(record, '2026-04-16T00:00:00.000Z', 'sweep');
    expect(first.applied).toBe(true);
    expect(first.period).toEqual({
      start: '2026-03-15T12:00:00.000Z',
      end: '2026-04-15T12:00:00.000Z',
    });
    expect(first.record.currentPeriodStart).toBe('2026-04-15T12:00:00.000Z');
    expect(first.record.status).toBe('active');
    expect(first.record.version).toBe(record.version + 1);

    const again = applyRenewal(first.record, '2026-04-16T00:00:00.000Z', 'sweep');
    expect(again.applied).toBe(false);
  });

  it('catches up one period at a time when several were missed', () => {
    const record = subscription();
    const late = applyRenewal(record, '2026-06-20T00:00:00.000Z', 'sweep');
    expect(late.stillBehind).toBe(1);
    const second = applyRenewal(late.record, '2026-06-20T00:00:00.000Z', 'sweep');
    expect(second.applied).toBe(true);
    expect(second.stillBehind).toBe(1);
  });

  it('lets a cancellation run to the end of the period it paid for', () => {
    const record = cancelSubscription(subscription(), NOW, 'operator');
    expect(record.status).toBe('canceled');
    expect(record.renews).toBe(false);
    expect(assess(record, '2026-04-01T00:00:00.000Z').entitled).toBe(true);
    expect(assess(record, '2026-04-16T00:00:00.000Z').entitled).toBe(false);
  });

  it('stops a suspended account completely, then restores it', () => {
    const suspended = suspendSubscription(subscription(), NOW, 'operator', 'Chargeback');
    expect(assess(suspended, NOW).entitled).toBe(false);
    expect(applyRenewal(suspended, '2026-05-01T00:00:00.000Z', 'sweep').applied).toBe(false);

    const back = reactivateSubscription(suspended, '2026-04-20T00:00:00.000Z', 'operator');
    expect(back.status).toBe('active');
    expect(back.suspensionReason).toBeNull();
    // Its period had run out while it was held, so it starts a fresh one now
    // rather than back-dating the months it did not have.
    expect(back.currentPeriodStart).toBe('2026-04-20T00:00:00.000Z');
  });

  it('refuses a plan change on a suspended subscription', () => {
    const suspended = suspendSubscription(subscription(), NOW, 'operator', 'Review');
    const pro = findPlan(plans, 'pro');
    if (pro === null) throw new Error('pro missing');
    expect(() =>
      changePlan({
        record: suspended,
        plan: pro,
        previousRank: builder.rank,
        now: NOW,
        actor: 'operator',
      }),
    ).toThrow(/suspended/i);
  });

  it('calls a higher rank an upgrade and leaves the period alone', () => {
    const pro = findPlan(plans, 'pro');
    if (pro === null) throw new Error('pro missing');
    const result = changePlan({
      record: subscription(),
      plan: pro,
      previousRank: builder.rank,
      now: NOW,
      actor: 'operator',
    });
    expect(result.direction).toBe('upgrade');
    expect(result.record.planId).toBe('pro');
    expect(result.record.currentPeriodStart).toBe(subscription().currentPeriodStart);
    expect(result.record.version).toBe(subscription().version + 1);
  });

  it('calls a lower rank a downgrade without touching the period', () => {
    const starter = findPlan(plans, 'starter');
    if (starter === null) throw new Error('starter missing');
    const result = changePlan({
      record: subscription(),
      plan: starter,
      previousRank: builder.rank,
      now: NOW,
      actor: 'operator',
    });
    expect(result.direction).toBe('downgrade');
  });

  it('refuses to assign a deactivated plan', () => {
    const off = { ...builder, active: false };
    expect(() =>
      assignSubscription({ id: 'sub_2', ownerRef: 'owner-b', plan: off, now: NOW, actor: 'test' }),
    ).toThrow(/not being assigned/);
  });
});

describe('resolving which plan applies', () => {
  it('gives an account with no subscription the included allowance', () => {
    const effective = resolveEffectivePlan({ plans, subscription: null, now: NOW });
    expect(effective.source).toBe('development-allowance');
    expect(effective.plan.id).toBe(DEVELOPMENT_PLAN_ID);
    expect(effective.entitled).toBe(true);
  });

  it('applies the subscribed plan while it is live', () => {
    const effective = resolveEffectivePlan({ plans, subscription: subscription(), now: NOW });
    expect(effective.source).toBe('subscription');
    expect(effective.plan.id).toBe('builder');
    expect(effective.status).toBe('active');
  });

  it('falls back to the included allowance when the subscription lapsed, and says so', () => {
    const effective = resolveEffectivePlan({
      plans,
      subscription: subscription({ renews: false }),
      now: '2026-05-01T00:00:00.000Z',
    });
    expect(effective.source).toBe('lapsed');
    expect(effective.plan.id).toBe(DEVELOPMENT_PLAN_ID);
    expect(effective.reason).toContain('included allowance applies');
    expect(effective.reason).toContain('Nothing was deleted');
  });

  it('grants nothing at all while suspended', () => {
    const effective = resolveEffectivePlan({
      plans,
      subscription: suspendSubscription(subscription(), NOW, 'operator', 'Review'),
      now: NOW,
    });
    expect(effective.source).toBe('suspended');
    expect(effective.entitled).toBe(false);
    expect(effective.reason).toBe('Review');
  });

  it('keeps subscribers on a plan that was deactivated', () => {
    const deactivated = plans.map((plan) =>
      plan.id === 'builder' ? { ...plan, active: false } : plan,
    );
    const effective = resolveEffectivePlan({
      plans: deactivated,
      subscription: subscription(),
      now: NOW,
    });
    expect(effective.plan.id).toBe('builder');
    expect(effective.entitled).toBe(true);
  });
});

describe('the in-memory store', () => {
  const newStore = () => new InMemorySubscriptionStore({ now: () => NOW });

  it('refuses a stale write instead of merging two changes', async () => {
    const store = newStore();
    const record = subscription();
    await store.saveSubscription(record, null);
    await expect(store.saveSubscription({ ...record, planId: 'pro' }, null)).rejects.toBeInstanceOf(
      SubscriptionConflictError,
    );
    const saved = await store.saveSubscription({ ...record, version: 2 }, 1);
    expect(saved.version).toBe(2);
  });

  it('records a period once, however many times it is asked', async () => {
    const store = newStore();
    const entry = {
      ownerRef: 'owner-a',
      periodStart: NOW,
      periodEnd: '2026-04-15T12:00:00.000Z',
      planId: 'builder',
      messageCredits: 250,
      integrationCredits: 10_000,
      kind: 'renewal' as const,
      processedAt: NOW,
      actor: 'sweep',
    };
    expect((await store.recordPeriod(entry)).created).toBe(true);
    expect((await store.recordPeriod(entry)).created).toBe(false);
    expect(await store.listPeriods('owner-a')).toHaveLength(1);
  });

  it('writes an event once per dedupe key', async () => {
    const store = newStore();
    const event = {
      id: 'evt_1',
      ownerRef: 'owner-a',
      kind: 'upgraded' as const,
      planId: 'pro',
      previousPlanId: 'builder',
      status: 'active' as const,
      message: 'Upgraded',
      actor: 'operator',
      dedupeKey: 'upgraded:builder:pro:2026-03-15',
      occurredAt: NOW,
    };
    expect((await store.appendEvent(event)).created).toBe(true);
    expect((await store.appendEvent({ ...event, id: 'evt_2' })).created).toBe(false);
    expect(await store.listEvents('owner-a')).toHaveLength(1);
  });

  it('keeps one account from reading another account rows', async () => {
    const store = newStore();
    await store.saveSubscription(subscription({ ownerRef: 'owner-a' }), null);
    expect(await store.readSubscription('owner-b')).toBeNull();
  });
});
