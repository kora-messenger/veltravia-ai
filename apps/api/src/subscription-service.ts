/**
 * Subscriptions (Step 60).
 *
 * The one place that answers "which plan is this account on, and may it do X".
 * It owns no wallet, no ledger, no charge and no price list:
 *
 *  - **configuration** is the plan catalogue, one row per plan, edited only by an
 *    operator and validated before it is written;
 *  - **state** is one subscription row per account, with the period it is in;
 *  - **the decision** is a read: `effective()` resolves the plan that applies and
 *    `checkEntitlement` turns it into a yes or a no, both pure functions from the
 *    core package;
 *  - **what happened** is written once per dedupe key, so a retried job notifies
 *    once and a renewal cannot advance a period twice.
 *
 * Two things this deliberately does *not* do:
 *
 *  - **It does not grant credit.** A plan states a ceiling; credits still arrive
 *    through the wallet (Step 53). Depositing a "monthly allowance" here would
 *    create a second source of balance, which is exactly what Steps 52-59 were
 *    careful to avoid.
 *  - **It does not collect money.** There is no checkout in this build, so no
 *    plan change moves a currency amount and no proration is invented.
 *
 * The operator surface runs its writes inside the *target* owner's scope, so the
 * repositories keep their invariant that a row is only ever written for the owner
 * in scope; the authorization for reaching another owner is the operator token,
 * checked at the route.
 */

import {
  applyRenewal,
  assess,
  assignSubscription,
  cancelSubscription,
  catalogueFor,
  changePlan as changePlanRecord,
  developmentPlan,
  allPlans,
  expireSubscription,
  findPlan,
  normalizePlanDraft,
  reactivateSubscription,
  resolveEffectivePlan,
  seedPlans,
  settled,
  suspendSubscription,
  SubscriptionError,
  type EffectivePlan,
  type PlanChangeDirection,
  type PlanQuotaLimits,
  type SubscriptionAuditRecord,
  type SubscriptionEventKind,
  type SubscriptionPlanDefinition,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from '@veltravia/subscriptions-core';
import { runWithOwner } from '@veltravia/storage-postgres';

import { InMemorySubscriptionStore } from '@veltravia/subscriptions-core';
import type { SubscriptionStore } from '@veltravia/subscriptions-core';

/** What a gate needs to know about one account, in one object. */
export interface SubscriptionAccess {
  readonly planId: string;
  readonly planName: string;
  readonly status: SubscriptionStatus | 'none';
  readonly source: EffectivePlan['source'];
  readonly entitled: boolean;
  readonly managedProviders: boolean;
  readonly byokProviders: boolean;
  readonly quotaLimits: PlanQuotaLimits | null;
  readonly reason: string | null;
}

export interface SubscriptionServiceOptions {
  readonly store?: SubscriptionStore;
  /** Process environment, read for the deployment mode and self-service flag. */
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** The deployment is in development mode, where BYOK is free. */
  readonly developmentMode?: boolean;
  /** Whether a customer may move themselves between plans. Off by default. */
  readonly selfServiceEnabled?: boolean;
  readonly onEvent?: (event: {
    kind: SubscriptionEventKind;
    ownerRef: string;
    message: string;
  }) => void;
}

export interface OwnerOverview {
  readonly subscription: SubscriptionRecord | null;
  readonly effective: EffectivePlan;
  readonly status: SubscriptionStatus | 'none';
  readonly periodEnded: boolean;
  readonly daysRemaining: number;
  readonly renewalDue: boolean;
  readonly plans: readonly SubscriptionPlanDefinition[];
  readonly periods: readonly {
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly planId: string;
    readonly kind: string;
  }[];
}

export interface ChangeResult {
  readonly subscription: SubscriptionRecord;
  readonly direction: PlanChangeDirection | null;
}

const DEFAULT_PLAN_CACHE_MS = 15_000;

export interface SubscriptionService {
  readonly durable: boolean;
  /** Whether a customer may move themselves between plans. */
  readonly selfServiceEnabled: boolean;
  ensureCatalogue(): Promise<void>;
  plans(): Promise<readonly SubscriptionPlanDefinition[]>;
  catalogue(): Promise<readonly SubscriptionPlanDefinition[]>;
  access(ownerRef: string): Promise<SubscriptionAccess>;
  effective(ownerRef: string): Promise<EffectivePlan>;
  overview(ownerRef: string): Promise<OwnerOverview>;
  events(ownerRef: string, limit?: number): Promise<readonly unknown[]>;
  audit(ownerRef: string, limit?: number): Promise<readonly SubscriptionAuditRecord[]>;
  assign(input: {
    ownerRef: string;
    planId: string;
    actor: string;
    reason: string;
    renews?: boolean;
  }): Promise<SubscriptionRecord>;
  changePlan(input: {
    ownerRef: string;
    planId: string;
    actor: string;
    reason: string;
    expectedVersion?: number | null;
    /** True when the account is moving itself rather than an operator moving it. */
    selfService?: boolean;
  }): Promise<ChangeResult>;
  cancel(input: {
    ownerRef: string;
    actor: string;
    reason: string;
    immediate?: boolean;
  }): Promise<SubscriptionRecord>;
  suspend(input: { ownerRef: string; actor: string; reason: string }): Promise<SubscriptionRecord>;
  reactivate(input: {
    ownerRef: string;
    actor: string;
    reason: string;
  }): Promise<SubscriptionRecord>;
  expire(input: { ownerRef: string; actor: string; reason: string }): Promise<SubscriptionRecord>;
  renew(ownerRef: string, actor: string): Promise<{ readonly applied: number }>;
  sweep(actor: string): Promise<{
    readonly checked: number;
    readonly renewed: number;
    readonly expired: number;
  }>;
  savePlan(input: {
    draft: unknown;
    actor: string;
    reason: string;
  }): Promise<SubscriptionPlanDefinition>;
  setPlanActive(input: {
    planId: string;
    active: boolean;
    actor: string;
    reason: string;
  }): Promise<SubscriptionPlanDefinition>;
  adminSubscriptions(options?: {
    planId?: string;
    status?: string;
    limit?: number;
    skip?: number;
  }): Promise<readonly SubscriptionRecord[]>;
  /** One account, read inside that account's scope, for the operator surface. */
  adminSubscription(ownerRef: string): Promise<{
    readonly subscription: SubscriptionRecord | null;
    readonly effective: EffectivePlan;
    readonly events: readonly unknown[];
    readonly audit: readonly SubscriptionAuditRecord[];
    readonly periods: readonly {
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly planId: string;
      readonly kind: string;
    }[];
  }>;
  platformAudit(limit?: number): Promise<readonly SubscriptionAuditRecord[]>;
}

function iso(date: Date): string {
  return date.toISOString();
}

export function createSubscriptionService(
  options: SubscriptionServiceOptions = {},
): SubscriptionService {
  const now = options.now ?? (() => new Date());
  const store: SubscriptionStore = options.store ?? new InMemorySubscriptionStore();
  const durable = options.store !== undefined;
  const env = options.env ?? process.env;
  const developmentMode =
    options.developmentMode ??
    (env.VELTRAVIA_DEPLOYMENT_MODE?.trim() ??
      (env.NODE_ENV === 'production' ? 'production' : 'development')) !== 'production';
  const selfServiceFlag = (env.VELTRAVIA_SUBSCRIPTION_SELF_SERVICE ?? '').trim().toLowerCase();
  const selfServiceEnabled =
    options.selfServiceEnabled ??
    (selfServiceFlag === '1' || selfServiceFlag === 'on' || selfServiceFlag === 'true');

  let seq = 0;
  const newId = options.newId ?? (() => `sub_${now().getTime().toString(36)}_${++seq}`);

  /** The catalogue, cached briefly. Invalidated by every write to it. */
  let planCache: readonly SubscriptionPlanDefinition[] | null = null;
  let planCacheAt = 0;
  let catalogueReady = false;

  const invalidate = (): void => {
    planCache = null;
    planCacheAt = 0;
  };

  const readPlans = async (): Promise<readonly SubscriptionPlanDefinition[]> => {
    const at = now().getTime();
    if (planCache !== null && at - planCacheAt < DEFAULT_PLAN_CACHE_MS) return planCache;
    const plans = await store.listPlans();
    planCache = plans;
    planCacheAt = at;
    return plans;
  };

  /**
   * Seeds the shipped catalogue once, into an empty database only.
   *
   * It never overwrites an operator's edit: an existing row is left exactly as it
   * is, so a deployment that changed the numbers does not have them reset on the
   * next boot.
   */
  const ensureCatalogue = async (): Promise<void> => {
    if (catalogueReady) return;
    const existing = await store.listPlans();
    const have = new Set(existing.map((plan) => plan.id));
    for (const plan of seedPlans(() => iso(now()))) {
      if (have.has(plan.id)) continue;
      await store.savePlan(plan);
    }
    catalogueReady = true;
    invalidate();
  };

  const planFor = async (planId: string): Promise<SubscriptionPlanDefinition> => {
    const plan = await store.readPlan(planId);
    if (plan === null) {
      throw new SubscriptionError('PLAN_NOT_FOUND', `There is no plan called "${planId}".`, 404, {
        planId,
      });
    }
    return plan;
  };

  const readRecord = async (ownerRef: string): Promise<SubscriptionRecord | null> => {
    return store.readSubscription(ownerRef);
  };

  const effective = async (ownerRef: string): Promise<EffectivePlan> => {
    await ensureCatalogue();
    const [plans, subscription] = await Promise.all([readPlans(), readRecord(ownerRef)]);
    return resolveEffectivePlan({ plans, subscription, now: iso(now()) });
  };

  /**
   * The gate's view.
   *
   * Managed keys and BYOK are read off the plan, but a suspended or lapsed
   * account is never handed a provider key: `entitled` is false for a suspension
   * and the whole answer refuses, which is what stops a held account from
   * spending through either route.
   */
  const access = async (ownerRef: string): Promise<SubscriptionAccess> => {
    const plan = await effective(ownerRef);
    const eligible = plan.entitled && plan.source !== 'suspended';
    const value = (key: string): boolean => plan.plan.entitlements[key] === true;
    return {
      planId: plan.plan.id,
      planName: plan.plan.name,
      status: plan.status,
      source: plan.source,
      entitled: plan.entitled,
      managedProviders: eligible && (value('models.managed') || developmentMode),
      byokProviders: eligible && (value('models.byok') || developmentMode),
      quotaLimits: plan.plan.quotas,
      reason: plan.reason,
    };
  };

  const overview = async (ownerRef: string): Promise<OwnerOverview> => {
    await ensureCatalogue();
    const [plans, subscription] = await Promise.all([readPlans(), readRecord(ownerRef)]);
    const effectivePlan = resolveEffectivePlan({ plans, subscription, now: iso(now()) });
    const assessment = subscription === null ? null : assess(subscription, iso(now()));
    const periods =
      subscription === null
        ? []
        : (await store.listPeriods(ownerRef, 12)).map((entry) => ({
            periodStart: entry.periodStart,
            periodEnd: entry.periodEnd,
            planId: entry.planId,
            kind: entry.kind,
          }));
    return {
      subscription,
      effective: effectivePlan,
      status: effectivePlan.status,
      periodEnded: assessment?.periodEnded ?? false,
      daysRemaining: assessment?.daysRemaining ?? 0,
      renewalDue: assessment?.renewalDue ?? false,
      plans: catalogueFor(plans),
      periods,
    };
  };

  /**
   * Writes one event, once per dedupe key.
   *
   * The event *is* the notification: a screen reads them in order, and the unique
   * key is what makes a retried job silent instead of noisy.
   */
  const notify = async (input: {
    ownerRef: string;
    kind: SubscriptionEventKind;
    planId: string;
    previousPlanId: string | null;
    status: SubscriptionStatus;
    message: string;
    actor: string;
    dedupeKey: string;
  }): Promise<void> => {
    const event = {
      id: `evt_${now().getTime().toString(36)}_${++seq}`,
      ownerRef: input.ownerRef,
      kind: input.kind,
      planId: input.planId,
      previousPlanId: input.previousPlanId,
      status: input.status,
      message: input.message,
      actor: input.actor,
      dedupeKey: input.dedupeKey,
      occurredAt: iso(now()),
    };
    const result = await store.appendEvent(event);
    if (result.created) options.onEvent?.(event);
  };

  const audit = async (input: {
    ownerRef: string;
    action: SubscriptionAuditRecord['action'];
    actor: string;
    reason: string;
    previousState: unknown;
    nextState: unknown;
    scope?: 'owner' | 'platform';
  }): Promise<void> => {
    // Called on the store, not lifted off it: an extracted method loses `this`
    // and the write becomes a TypeError inside the store instead of an audit row.
    const writeAudit = (
      record: SubscriptionAuditRecord,
      scope: 'owner' | 'platform',
    ): Promise<void> => store.appendAudit(record, scope);
    await writeAudit(
      {
        id: `aud_${now().getTime().toString(36)}_${++seq}`,
        ownerRef: input.ownerRef,
        action: input.action,
        actor: input.actor,
        reason: input.reason,
        previousState: input.previousState,
        nextState: input.nextState,
        occurredAt: iso(now()),
      },
      input.scope ?? 'owner',
    );
  };

  const recordPeriod = async (
    record: SubscriptionRecord,
    plan: SubscriptionPlanDefinition,
    kind: 'assignment' | 'renewal',
    actor: string,
  ): Promise<void> => {
    await store.recordPeriod({
      ownerRef: record.ownerRef,
      periodStart: record.currentPeriodStart,
      periodEnd: record.currentPeriodEnd,
      planId: plan.id,
      messageCredits: plan.monthlyMessageCredits,
      integrationCredits: plan.monthlyIntegrationCredits,
      kind,
      processedAt: iso(now()),
      actor,
    });
  };

  /** Every write to another owner runs inside that owner's scope. */
  const asOwner = async <T>(ownerRef: string, fn: () => Promise<T>): Promise<T> =>
    durable ? runWithOwner(ownerRef, fn) : fn();

  const assign = async (input: {
    ownerRef: string;
    planId: string;
    actor: string;
    reason: string;
    renews?: boolean;
  }): Promise<SubscriptionRecord> => {
    await ensureCatalogue();
    const plan = await planFor(input.planId);
    return asOwner(input.ownerRef, async () => {
      const existing = await store.readSubscription(input.ownerRef);
      if (existing !== null) {
        throw new SubscriptionError(
          'SUBSCRIPTION_EXISTS',
          'This account already has a subscription. Change its plan instead of assigning a new one.',
          409,
          { ownerRef: input.ownerRef, planId: existing.planId },
        );
      }
      const record = assignSubscription({
        id: newId(),
        ownerRef: input.ownerRef,
        plan,
        now: iso(now()),
        actor: input.actor,
        ...(input.renews === undefined ? {} : { renews: input.renews }),
      });
      const saved = await store.saveSubscription(record, null);
      await recordPeriod(saved, plan, 'assignment', input.actor);
      await notify({
        ownerRef: saved.ownerRef,
        kind: 'assigned',
        planId: plan.id,
        previousPlanId: null,
        status: saved.status,
        message: `The ${plan.name} plan is now active. Your first period runs to ${saved.currentPeriodEnd.slice(0, 10)}.`,
        actor: input.actor,
        dedupeKey: `assigned:${plan.id}:${saved.currentPeriodStart}`,
      });
      await audit({
        ownerRef: saved.ownerRef,
        action: 'subscription-assigned',
        actor: input.actor,
        reason: input.reason,
        previousState: null,
        nextState: saved,
      });
      return saved;
    });
  };

  /**
   * A plan change. `selfService` changes the *permission* question only: an
   * account may only move itself when the deployment has allowed it and the
   * target plan is marked self-selectable, because without a payment step a
   * self-driven upgrade would be free.
   */
  const changePlan = async (input: {
    ownerRef: string;
    planId: string;
    actor: string;
    reason: string;
    expectedVersion?: number | null;
    selfService?: boolean;
  }): Promise<ChangeResult> => {
    await ensureCatalogue();
    const plan = await planFor(input.planId);
    if (input.selfService === true) {
      if (!selfServiceEnabled) {
        throw new SubscriptionError(
          'SUBSCRIPTION_CHANGE_UNAVAILABLE',
          'Plan changes are made by an operator until checkout exists. Nothing was changed.',
          403,
          { planId: plan.id },
        );
      }
      if (!plan.selfService) {
        throw new SubscriptionError(
          'PLAN_NOT_SELF_SERVICE',
          `The ${plan.name} plan cannot be chosen directly. Nothing was changed.`,
          403,
          { planId: plan.id },
        );
      }
    }
    return asOwner(input.ownerRef, async () => {
      const existing = await store.readSubscription(input.ownerRef);
      if (existing === null) {
        throw new SubscriptionError(
          'SUBSCRIPTION_NOT_FOUND',
          'This account has no subscription to change. Assign a plan instead.',
          404,
          { ownerRef: input.ownerRef },
        );
      }
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== null &&
        input.expectedVersion !== existing.version
      ) {
        throw new SubscriptionError(
          'SUBSCRIPTION_CONFLICT',
          'This subscription changed while you were looking at it. Reload and try again.',
          409,
          { expectedVersion: input.expectedVersion, version: existing.version },
        );
      }
      const previousPlan = await store.readPlan(existing.planId);
      const previousRank = previousPlan?.rank ?? 0;
      const result = changePlanRecord({
        record: existing,
        plan,
        previousRank,
        now: iso(now()),
        actor: input.actor,
      });
      const saved = await store.saveSubscription(result.record, existing.version);
      if (result.direction !== 'same') {
        await notify({
          ownerRef: saved.ownerRef,
          kind: result.direction === 'upgrade' ? 'upgraded' : 'downgraded',
          planId: plan.id,
          previousPlanId: existing.planId,
          status: saved.status,
          message:
            result.direction === 'upgrade'
              ? `Your plan is now ${plan.name}. The new allowances and features are in force from now.`
              : `Your plan is now ${plan.name}. Nothing was deleted: your projects, files and history are unchanged, and the lower ceilings apply to new work.`,
          actor: input.actor,
          dedupeKey: `${result.direction}:${existing.planId}:${plan.id}:${saved.version}`,
        });
      }
      await audit({
        ownerRef: saved.ownerRef,
        action: 'subscription-plan-changed',
        actor: input.actor,
        reason: input.reason,
        previousState: existing,
        nextState: saved,
      });
      return { subscription: saved, direction: result.direction };
    });
  };

  const requireRecord = async (ownerRef: string): Promise<SubscriptionRecord> => {
    const record = await store.readSubscription(ownerRef);
    if (record === null) {
      throw new SubscriptionError(
        'SUBSCRIPTION_NOT_FOUND',
        'This account has no subscription.',
        404,
        { ownerRef },
      );
    }
    return record;
  };

  const cancel = async (input: {
    ownerRef: string;
    actor: string;
    reason: string;
    immediate?: boolean;
  }): Promise<SubscriptionRecord> =>
    asOwner(input.ownerRef, async () => {
      const existing = await requireRecord(input.ownerRef);
      const next = cancelSubscription(existing, iso(now()), input.actor, input.immediate === true);
      const saved = await store.saveSubscription(next, existing.version);
      await notify({
        ownerRef: saved.ownerRef,
        kind: 'canceled',
        planId: saved.planId,
        previousPlanId: saved.planId,
        status: saved.status,
        message:
          input.immediate === true
            ? 'Your subscription was cancelled now. The included allowance applies from this point.'
            : `Your subscription was cancelled and runs to ${saved.currentPeriodEnd.slice(0, 10)}. Nothing else changes before then.`,
        actor: input.actor,
        dedupeKey: `canceled:${saved.planId}:${saved.version}`,
      });
      await audit({
        ownerRef: saved.ownerRef,
        action: 'subscription-canceled',
        actor: input.actor,
        reason: input.reason,
        previousState: existing,
        nextState: saved,
      });
      return saved;
    });

  const suspend = async (input: {
    ownerRef: string;
    actor: string;
    reason: string;
  }): Promise<SubscriptionRecord> =>
    asOwner(input.ownerRef, async () => {
      const existing = await requireRecord(input.ownerRef);
      const next = suspendSubscription(existing, iso(now()), input.actor, input.reason);
      const saved = await store.saveSubscription(next, existing.version);
      await notify({
        ownerRef: saved.ownerRef,
        kind: 'suspended',
        planId: saved.planId,
        previousPlanId: saved.planId,
        status: saved.status,
        message: `Your subscription is suspended: ${saved.suspensionReason ?? 'held by an operator'}. Your data is unchanged.`,
        actor: input.actor,
        dedupeKey: `suspended:${saved.suspendedAt ?? saved.version}`,
      });
      await audit({
        ownerRef: saved.ownerRef,
        action: 'subscription-suspended',
        actor: input.actor,
        reason: input.reason,
        previousState: existing,
        nextState: saved,
      });
      return saved;
    });

  const reactivate = async (input: {
    ownerRef: string;
    actor: string;
    reason: string;
  }): Promise<SubscriptionRecord> =>
    asOwner(input.ownerRef, async () => {
      const existing = await requireRecord(input.ownerRef);
      const next = reactivateSubscription(existing, iso(now()), input.actor);
      const saved = await store.saveSubscription(next, existing.version);
      await notify({
        ownerRef: saved.ownerRef,
        kind: 'reactivated',
        planId: saved.planId,
        previousPlanId: saved.planId,
        status: saved.status,
        message: `Your subscription is active again, in a period that runs to ${saved.currentPeriodEnd.slice(0, 10)}.`,
        actor: input.actor,
        dedupeKey: `reactivated:${saved.currentPeriodStart}`,
      });
      await audit({
        ownerRef: saved.ownerRef,
        action: 'subscription-reactivated',
        actor: input.actor,
        reason: input.reason,
        previousState: existing,
        nextState: saved,
      });
      return saved;
    });

  const expire = async (input: {
    ownerRef: string;
    actor: string;
    reason: string;
  }): Promise<SubscriptionRecord> =>
    asOwner(input.ownerRef, async () => {
      const existing = await requireRecord(input.ownerRef);
      const next = expireSubscription(existing, iso(now()), input.actor);
      const saved = await store.saveSubscription(next, existing.version);
      await notify({
        ownerRef: saved.ownerRef,
        kind: 'expired',
        planId: saved.planId,
        previousPlanId: saved.planId,
        status: saved.status,
        message:
          'Your subscription has ended, so the included allowance applies. Nothing was deleted.',
        actor: input.actor,
        dedupeKey: `expired:${saved.currentPeriodEnd}`,
      });
      await audit({
        ownerRef: saved.ownerRef,
        action: 'subscription-expired',
        actor: input.actor,
        reason: input.reason,
        previousState: existing,
        nextState: saved,
      });
      return saved;
    });

  /**
   * Renews one subscription, one period at a time, until it is current.
   *
   * Each period it consumed is recorded under a unique key *before* the record is
   * written, and a period already recorded stops the loop: that is what makes a
   * re-run of this function do nothing rather than advance a month for free.
   */
  const renew = async (ownerRef: string, actor: string): Promise<{ applied: number }> =>
    asOwner(ownerRef, async () => {
      let applied = 0;
      for (let guard = 0; guard < 36; guard += 1) {
        const existing = await store.readSubscription(ownerRef);
        if (existing === null) break;
        const result = applyRenewal(existing, iso(now()), actor);
        if (!result.applied || result.period === null) {
          // Nothing overdue. Settle the stored status if the clock says it moved
          // (an expired non-renewing subscription, for instance).
          const settledRecord = settled(existing, iso(now()), actor);
          if (settledRecord !== existing) {
            const saved = await store.saveSubscription(settledRecord, existing.version);
            if (saved.status === 'expired') {
              await notify({
                ownerRef: saved.ownerRef,
                kind: 'expired',
                planId: saved.planId,
                previousPlanId: saved.planId,
                status: saved.status,
                message:
                  'Your subscription period ended, so the included allowance applies. Nothing was deleted.',
                actor,
                dedupeKey: `expired:${saved.currentPeriodEnd}`,
              });
            }
          }
          break;
        }
        const plan = await store.readPlan(result.record.planId);
        if (plan === null) break;
        /*
         * The claim is keyed on the period being *granted*, not the one that just
         * ended. The ended period is already recorded - the assignment wrote it
         * when the subscription started - so claiming it would collide with the
         * account's own first row and every renewal would silently do nothing.
         */
        const claim = await store.recordPeriod({
          ownerRef,
          periodStart: result.record.currentPeriodStart,
          periodEnd: result.record.currentPeriodEnd,
          planId: plan.id,
          messageCredits: plan.monthlyMessageCredits,
          integrationCredits: plan.monthlyIntegrationCredits,
          kind: 'renewal',
          processedAt: iso(now()),
          actor,
        });
        if (!claim.created) break;
        const saved = await store.saveSubscription(result.record, existing.version);
        applied += 1;
        await notify({
          ownerRef: saved.ownerRef,
          kind: 'renewed',
          planId: saved.planId,
          previousPlanId: saved.planId,
          status: saved.status,
          message: `Your ${plan.name} plan renewed. This period runs to ${saved.currentPeriodEnd.slice(0, 10)}.`,
          actor,
          dedupeKey: `renewed:${saved.currentPeriodStart}`,
        });
        await audit({
          ownerRef,
          action: 'subscription-renewed',
          actor,
          reason: `Renewed for the period starting ${saved.currentPeriodStart.slice(0, 10)}.`,
          previousState: existing,
          nextState: saved,
        });
        if (result.stillBehind === 0) break;
      }
      return { applied };
    });

  /**
   * The sweep. Reads every subscription, renews what is due and settles rows the
   * clock has moved. Bounded per run so a deployment with thousands of accounts
   * cannot spend a whole request in one pass.
   */
  const sweep = async (
    actor: string,
  ): Promise<{ checked: number; renewed: number; expired: number }> => {
    await ensureCatalogue();
    const all = await store.listSubscriptions({ limit: 500 });
    let renewed = 0;
    let expired = 0;
    for (const record of all) {
      const assessment = assess(record, iso(now()));
      if (!assessment.renewalDue && !assessment.stale) continue;
      const result = await renew(record.ownerRef, actor);
      renewed += result.applied;
      if (!assessment.renewalDue) expired += 1;
    }
    return { checked: all.length, renewed, expired };
  };

  const savePlan = async (input: {
    draft: unknown;
    actor: string;
    reason: string;
  }): Promise<SubscriptionPlanDefinition> => {
    await ensureCatalogue();
    const normalized = normalizePlanDraft(input.draft, { requireId: true });
    if (normalized.id === null) {
      throw new SubscriptionError('INVALID_PLAN', 'id is required.', 400, { field: 'id' });
    }
    const existing = await store.readPlan(normalized.id);
    const saved = await store.savePlan({
      id: normalized.id,
      name: normalized.name,
      description: normalized.description,
      rank: normalized.rank,
      visible: normalized.visible,
      active: normalized.active,
      selfService: normalized.selfService,
      monthlyMessageCredits: normalized.monthlyMessageCredits,
      monthlyIntegrationCredits: normalized.monthlyIntegrationCredits,
      entitlements: normalized.entitlements,
      quotas: normalized.quotas,
      version: existing?.version ?? 1,
      builtIn: existing?.builtIn ?? false,
      createdAt: existing?.createdAt ?? iso(now()),
      updatedAt: iso(now()),
      updatedBy: input.actor,
    });
    invalidate();
    await audit({
      ownerRef: input.actor,
      action: existing === null ? 'plan-created' : 'plan-updated',
      actor: input.actor,
      reason: input.reason,
      previousState: existing,
      nextState: saved,
      scope: 'platform',
    });
    return saved;
  };

  const setPlanActive = async (input: {
    planId: string;
    active: boolean;
    actor: string;
    reason: string;
  }): Promise<SubscriptionPlanDefinition> => {
    await ensureCatalogue();
    const existing = await planFor(input.planId);
    const normalized = normalizePlanDraft(
      {
        ...existing,
        active: input.active,
        // A plan that cannot be assigned cannot be self-selectable either.
        selfService: input.active ? existing.selfService : false,
      },
      { requireId: true },
    );
    if (normalized.id === null) {
      throw new SubscriptionError('INVALID_PLAN', 'id is required.', 400, { field: 'id' });
    }
    const saved = await store.savePlan({
      id: normalized.id,
      name: normalized.name,
      description: normalized.description,
      rank: normalized.rank,
      visible: normalized.visible,
      active: normalized.active,
      selfService: normalized.selfService,
      monthlyMessageCredits: normalized.monthlyMessageCredits,
      monthlyIntegrationCredits: normalized.monthlyIntegrationCredits,
      entitlements: normalized.entitlements,
      quotas: normalized.quotas,
      version: existing.version,
      builtIn: existing.builtIn,
      createdAt: existing.createdAt,
      updatedAt: iso(now()),
      updatedBy: input.actor,
    });
    invalidate();
    await audit({
      ownerRef: input.actor,
      action: input.active ? 'plan-activated' : 'plan-deactivated',
      actor: input.actor,
      reason: input.reason,
      previousState: existing,
      nextState: saved,
      scope: 'platform',
    });
    return saved;
  };

  return {
    durable,
    selfServiceEnabled,
    ensureCatalogue,
    plans: async () => {
      await ensureCatalogue();
      return allPlans(await readPlans());
    },
    catalogue: async () => {
      await ensureCatalogue();
      return catalogueFor(await readPlans());
    },
    access,
    effective,
    overview,
    events: async (ownerRef, limit = 25) => store.listEvents(ownerRef, { limit }),
    audit: async (ownerRef, limit = 25) => store.listAudit(ownerRef, { limit }),
    assign,
    changePlan,
    cancel,
    suspend,
    reactivate,
    expire,
    renew,
    sweep,
    savePlan,
    setPlanActive,
    adminSubscriptions: async (listOptions = {}) => store.listSubscriptions(listOptions),
    adminSubscription: async (ownerRef: string) =>
      asOwner(ownerRef, async () => {
        await ensureCatalogue();
        const [plans, subscription] = await Promise.all([
          readPlans(),
          store.readSubscription(ownerRef),
        ]);
        return {
          subscription,
          effective: resolveEffectivePlan({ plans, subscription, now: iso(now()) }),
          events: await store.listEvents(ownerRef, { limit: 50 }),
          audit: await store.listAudit(ownerRef, { limit: 50 }),
          periods: (await store.listPeriods(ownerRef, 24)).map((entry) => ({
            periodStart: entry.periodStart,
            periodEnd: entry.periodEnd,
            planId: entry.planId,
            kind: entry.kind,
          })),
        };
      }),
    platformAudit: async (limit = 50) => {
      const withPlatform = store as SubscriptionStore & {
        listPlatformAudit?: (count: number) => Promise<readonly SubscriptionAuditRecord[]>;
      };
      if (withPlatform.listPlatformAudit === undefined) return [];
      return withPlatform.listPlatformAudit(limit);
    },
  };
}

/**
 * The plan an account with no database gets, for a wiring that has not built the
 * service. Kept here so the fallback is one object rather than a scattered guess.
 */
export function developmentAllowancePlan(): SubscriptionPlanDefinition {
  return developmentPlan(() => '1970-01-01T00:00:00.000Z');
}

export { findPlan };
