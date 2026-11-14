/**
 * The subscription lifecycle, driven by a clock we control.
 *
 * HTTP cannot walk a year of periods, so the renewal arithmetic, the lapsed
 * fallback and the concurrency guarantees are proven here against the service
 * directly, with `now` injected. Every test is about a promise Step 60 makes:
 *
 *  - a renewal runs once per period, however many times the job runs;
 *  - a lapsed subscription loses the paid allowances and keeps the data;
 *  - a suspension grants neither the managed keys nor a personal one;
 *  - two simultaneous assignments cannot both win.
 */

import { describe, expect, it } from 'vitest';

import { createSubscriptionService } from './subscription-service.js';
import { createUsageService } from './usage-service.js';
import { InMemorySubscriptionStore } from '@veltravia/subscriptions-core';

const OWNER = 'lifecycle-owner';

/** A clock the test moves by hand, so periods end when the test says so. */
function clock(start = '2026-03-15T12:00:00.000Z') {
  let at = new Date(start);
  return {
    now: (): Date => at,
    advance(days: number): void {
      at = new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
    },
    set(iso: string): void {
      at = new Date(iso);
    },
  };
}

async function service(overrides: { developmentMode?: boolean } = {}) {
  const time = clock();
  const store = new InMemorySubscriptionStore({ now: () => time.now().toISOString() });
  const subscriptions = createSubscriptionService({
    store,
    now: time.now,
    developmentMode: overrides.developmentMode ?? true,
  });
  await subscriptions.ensureCatalogue();
  return { time, store, subscriptions };
}

describe('renewal', () => {
  it('does nothing until the period ends', async () => {
    const { subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'builder', actor: 'op', reason: 'paid' });
    expect((await subscriptions.renew(OWNER, 'sweep')).applied).toBe(0);
  });

  it('advances exactly one period, and a repeated run does nothing', async () => {
    const { time, subscriptions } = await service();
    const assigned = await subscriptions.assign({
      ownerRef: OWNER,
      planId: 'builder',
      actor: 'op',
      reason: 'paid',
    });

    time.advance(32);
    const first = await subscriptions.renew(OWNER, 'sweep');
    expect(first.applied).toBe(1);

    const second = await subscriptions.renew(OWNER, 'sweep');
    expect(second.applied).toBe(0);

    const after = await subscriptions.adminSubscription(OWNER);
    expect(after.subscription?.currentPeriodStart).toBe(assigned.currentPeriodEnd);
    expect(after.periods).toHaveLength(2);
  });

  it('records the period it consumed, so a retry cannot advance twice', async () => {
    const { time, store, subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'builder', actor: 'op', reason: 'paid' });
    time.advance(32);
    await subscriptions.renew(OWNER, 'sweep');

    // A second job that speaks to the store directly finds the period taken.
    const periods = await store.listPeriods(OWNER);
    const claim = await store.recordPeriod({
      ownerRef: OWNER,
      periodStart: periods[0]!.periodStart,
      periodEnd: periods[0]!.periodEnd,
      planId: periods[0]!.planId,
      messageCredits: 1,
      integrationCredits: 1,
      kind: 'renewal',
      processedAt: time.now().toISOString(),
      actor: 'second-job',
    });
    expect(claim.created).toBe(false);
  });

  it('catches up one period per run when several were missed', async () => {
    const { time, subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'builder', actor: 'op', reason: 'paid' });
    time.advance(95);

    const renewed = await subscriptions.renew(OWNER, 'sweep');
    // Three periods have ended by 18 June (15 April, 15 May, 15 June), and the
    // fourth runs to 15 July, so the run stops there rather than racing ahead.
    expect(renewed.applied).toBe(3);
    const after = await subscriptions.adminSubscription(OWNER);
    expect(new Date(after.subscription!.currentPeriodEnd).getTime()).toBeGreaterThan(
      time.now().getTime(),
    );
  });

  it('notifies once per period', async () => {
    const { time, subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'builder', actor: 'op', reason: 'paid' });
    time.advance(32);
    await subscriptions.renew(OWNER, 'sweep');
    await subscriptions.renew(OWNER, 'sweep');

    const events = (await subscriptions.events(OWNER, 50)) as { kind: string }[];
    expect(events.filter((event) => event.kind === 'renewed')).toHaveLength(1);
  });

  it('sweeps every due account and leaves the rest alone', async () => {
    const { time, subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'builder', actor: 'op', reason: 'paid' });
    await subscriptions.assign({
      ownerRef: 'fresh-owner',
      planId: 'starter',
      actor: 'op',
      reason: 'paid',
    });
    time.advance(1);
    const sweep = await subscriptions.sweep('renewal-sweep');
    expect(sweep.renewed).toBe(0);

    time.advance(40);
    const after = await subscriptions.sweep('renewal-sweep');
    expect(after.renewed).toBe(2);
  });
});

describe('lapsing', () => {
  it('falls back to the included allowance and keeps everything the account owns', async () => {
    const { time, subscriptions } = await service();
    await subscriptions.assign({
      ownerRef: OWNER,
      planId: 'pro',
      actor: 'op',
      reason: 'paid',
      renews: false,
    });
    time.advance(40);

    const effective = await subscriptions.effective(OWNER);
    expect(effective.source).toBe('lapsed');
    expect(effective.plan.id).toBe('development');
    expect(effective.entitled).toBe(true);
    expect(effective.reason).toContain('Nothing was deleted');

    // The row is still there, so nothing was destroyed by the downgrade.
    const detail = await subscriptions.adminSubscription(OWNER);
    expect(detail.subscription?.planId).toBe('pro');
    expect(detail.periods.length).toBe(1);
  });

  it('drops the paid quota set when it lapses', async () => {
    const { time, subscriptions } = await service();
    await subscriptions.assign({
      ownerRef: OWNER,
      planId: 'pro',
      actor: 'op',
      reason: 'paid',
      renews: false,
    });
    const paid = await subscriptions.access(OWNER);
    expect(paid.quotaLimits?.['concurrentJobs']).toBe(16);

    time.advance(40);
    const lapsed = await subscriptions.access(OWNER);
    expect(lapsed.quotaLimits?.['concurrentJobs']).toBe(3);
  });

  it('lets a cancellation run to the end of the paid period', async () => {
    const { time, subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'builder', actor: 'op', reason: 'paid' });
    const canceled = await subscriptions.cancel({
      ownerRef: OWNER,
      actor: OWNER,
      reason: 'No longer needed',
    });
    expect(canceled.status).toBe('canceled');
    expect(canceled.renews).toBe(false);

    time.advance(10);
    const mid = await subscriptions.effective(OWNER);
    expect(mid.source).toBe('subscription');
    expect(mid.plan.id).toBe('builder');

    time.advance(30);
    const after = await subscriptions.effective(OWNER);
    expect(after.source).toBe('lapsed');
  });
});

describe('a suspension grants nothing', () => {
  it('stops both provider routes until it is lifted', async () => {
    const { subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'elite', actor: 'op', reason: 'paid' });

    const before = await subscriptions.access(OWNER);
    expect(before.managedProviders).toBe(true);
    expect(before.byokProviders).toBe(true);

    await subscriptions.suspend({ ownerRef: OWNER, actor: 'op', reason: 'Chargeback' });
    const held = await subscriptions.access(OWNER);
    expect(held.entitled).toBe(false);
    expect(held.managedProviders).toBe(false);
    expect(held.byokProviders).toBe(false);
    expect(held.reason).toBe('Chargeback');
  });
});

describe('plan changes', () => {
  it('keeps the period and the whole history across an upgrade then a downgrade', async () => {
    const { subscriptions } = await service();
    const assigned = await subscriptions.assign({
      ownerRef: OWNER,
      planId: 'starter',
      actor: 'op',
      reason: 'paid',
    });
    const up = await subscriptions.changePlan({
      ownerRef: OWNER,
      planId: 'elite',
      actor: 'op',
      reason: 'grew',
    });
    expect(up.direction).toBe('upgrade');
    expect(up.subscription.currentPeriodStart).toBe(assigned.currentPeriodStart);
    expect(up.subscription.currentPeriodEnd).toBe(assigned.currentPeriodEnd);

    const down = await subscriptions.changePlan({
      ownerRef: OWNER,
      planId: 'starter',
      actor: 'op',
      reason: 'shrank',
    });
    expect(down.direction).toBe('downgrade');

    const detail = await subscriptions.adminSubscription(OWNER);
    expect(detail.audit.length).toBeGreaterThanOrEqual(3);
    expect(detail.periods).toHaveLength(1);
    const kinds = (detail.events as { kind: string }[]).map((event) => event.kind);
    expect(kinds).toContain('upgraded');
    expect(kinds).toContain('downgraded');
  });

  it('refuses a change when the caller is looking at an older version', async () => {
    const { subscriptions } = await service();
    const assigned = await subscriptions.assign({
      ownerRef: OWNER,
      planId: 'starter',
      actor: 'op',
      reason: 'paid',
    });
    await expect(
      subscriptions.changePlan({
        ownerRef: OWNER,
        planId: 'pro',
        actor: 'op',
        reason: 'race',
        expectedVersion: assigned.version - 1,
      }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONFLICT' });
  });

  it('refuses a second assignment rather than replacing the first', async () => {
    const { subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'starter', actor: 'op', reason: 'paid' });
    await expect(
      subscriptions.assign({ ownerRef: OWNER, planId: 'pro', actor: 'op', reason: 'again' }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_EXISTS' });
  });

  it('lets only one of two simultaneous assignments win', async () => {
    const { subscriptions } = await service();
    const results = await Promise.allSettled([
      subscriptions.assign({ ownerRef: OWNER, planId: 'starter', actor: 'op', reason: 'a' }),
      subscriptions.assign({ ownerRef: OWNER, planId: 'pro', actor: 'op', reason: 'b' }),
    ]);
    const won = results.filter((result) => result.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const detail = await subscriptions.adminSubscription(OWNER);
    expect(detail.periods).toHaveLength(1);
  });
});

describe('the catalogue an operator edits', () => {
  it('applies an edited plan immediately, without a restart', async () => {
    const { subscriptions } = await service();
    const before = await subscriptions.catalogue();
    const development = before.find((plan) => plan.id === 'development')!;
    expect(development.monthlyIntegrationCredits).toBe(500);

    await subscriptions.savePlan({
      draft: { ...development, monthlyIntegrationCredits: 750 },
      actor: 'op',
      reason: 'Raised the included allowance',
    });

    const after = await subscriptions.catalogue();
    expect(after.find((plan) => plan.id === 'development')?.monthlyIntegrationCredits).toBe(750);
    const overview = await subscriptions.overview(OWNER);
    expect(overview.effective.plan.monthlyIntegrationCredits).toBe(750);
  });

  it('keeps the accounts already on a plan that was deactivated', async () => {
    const { subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'starter', actor: 'op', reason: 'paid' });
    await subscriptions.setPlanActive({
      planId: 'starter',
      active: false,
      actor: 'op',
      reason: 'Retired for new customers',
    });

    const effective = await subscriptions.effective(OWNER);
    expect(effective.plan.id).toBe('starter');
    expect(effective.entitled).toBe(true);

    const catalogue = await subscriptions.catalogue();
    expect(catalogue.map((plan) => plan.id)).not.toContain('starter');
    await expect(
      subscriptions.assign({ ownerRef: 'new-owner', planId: 'starter', actor: 'op', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'PLAN_INACTIVE' });
  });
});

describe('the meter follows the plan', () => {
  it('refuses a personal provider key while suspended, before anything is sent', async () => {
    const { subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'pro', actor: 'op', reason: 'paid' });
    await subscriptions.suspend({ ownerRef: OWNER, actor: 'op', reason: 'Chargeback' });

    const usage = createUsageService({
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      subscription: subscriptions,
    });

    await expect(
      usage.guardProviderCall({ ownerRef: OWNER, byok: true, requestedTokens: 100 }),
    ).rejects.toMatchObject({ code: 'USAGE_BYOK_NOT_IN_PLAN' });
  });

  it('names the plan in force, not a guess', async () => {
    const { subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'builder', actor: 'op', reason: 'paid' });
    const usage = createUsageService({
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      subscription: subscriptions,
    });
    const entitlement = await usage.entitlement(OWNER);
    expect(entitlement.label).toBe('Builder');
    expect(entitlement.planId).toBe('paid');

    const other = await usage.entitlement('nobody-in-particular');
    expect(other.planId).toBe('development');
    expect(other.label).toBe('Included allowance');
  });

  it('takes the quota set from the plan', async () => {
    const { subscriptions } = await service();
    await subscriptions.assign({ ownerRef: OWNER, planId: 'pro', actor: 'op', reason: 'paid' });
    const usage = createUsageService({
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      subscription: subscriptions,
    });
    const snapshot = await usage.snapshot(OWNER);
    const concurrent = snapshot.limits.find((limit) => limit.key === 'concurrentJobs');
    expect(concurrent?.value).toBe(16);

    const fallback = await usage.snapshot('someone-else');
    expect(fallback.limits.find((limit) => limit.key === 'concurrentJobs')?.value).toBe(3);
  });
});
