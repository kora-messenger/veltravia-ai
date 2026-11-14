import { apiRequest } from './client';

/**
 * Typed client for subscription plans (Step 60).
 *
 * A read-only mirror of what the server decides. Two display rules come from the
 * shape of this data:
 *
 *  - an entitlement that is absent is not "off with a default", it is denied, so
 *    the page lists what the plan states and treats the rest as unavailable;
 *  - a plan states no price here because none exists yet: there is no checkout in
 *    this build, so a price field would be an invention.
 */

export type SubscriptionStatus =
  'trialing' | 'active' | 'past_due' | 'canceled' | 'suspended' | 'expired';

export interface PlanView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rank: number;
  readonly active: boolean;
  readonly visible: boolean;
  readonly selfService: boolean;
  readonly builtIn: boolean;
  readonly monthlyMessageCredits: number;
  readonly monthlyIntegrationCredits: number;
  readonly entitlements: Readonly<Record<string, boolean | number | null>>;
  readonly quotas: Readonly<Record<string, number | null>>;
}

export interface SubscriptionRecordView {
  readonly id: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly startedAt: string;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly renews: boolean;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: string | null;
  readonly suspendedAt: string | null;
  readonly suspensionReason: string | null;
  readonly expiredAt: string | null;
  readonly version: number;
}

export interface PlanEventView {
  readonly id: string;
  readonly kind: string;
  readonly planId: string;
  readonly previousPlanId: string | null;
  readonly status: SubscriptionStatus;
  readonly message: string;
  readonly occurredAt: string;
}

export interface PeriodView {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly planId: string;
  readonly messageCredits: number;
  readonly integrationCredits: number;
  readonly kind: string;
}

export interface SubscriptionOverview {
  readonly status: SubscriptionStatus | 'none';
  readonly subscription: SubscriptionRecordView | null;
  readonly effective: {
    readonly source: 'subscription' | 'development-allowance' | 'lapsed' | 'suspended';
    readonly plan: PlanView;
    readonly status: SubscriptionStatus | 'none';
    readonly entitled: boolean;
    readonly reason: string | null;
    readonly daysRemaining: number;
    readonly renewalDue: boolean;
  };
  readonly plans: readonly PlanView[];
  readonly periods: readonly PeriodView[];
  readonly events: readonly PlanEventView[];
  readonly allowances: {
    readonly messageCredits: number;
    readonly integrationCredits: number;
  };
  readonly entitlements: Readonly<Record<string, boolean | number | null>>;
  readonly quotas: Readonly<Record<string, number | null>>;
  readonly durable: boolean;
  readonly selfService: { readonly enabled: boolean; readonly note: string | null };
  /** The other lanes, so an allowance can be read beside what has been used. */
  readonly message: { month?: { credits?: number; openCredits?: number } } | null;
  readonly integrations: {
    month?: { credits?: number; heldCredits?: number };
  } | null;
  readonly wallet: { wallet?: { available?: number; reserved?: number; spent?: number } } | null;
}

export interface PlanPermissions {
  readonly planId: string;
  readonly planName: string;
  readonly status: SubscriptionStatus | 'none';
  readonly source: string;
  readonly entitled: boolean;
  readonly reason: string | null;
  readonly features: {
    readonly managedProviders: boolean;
    readonly byokProviders: boolean;
  };
}

export function getSubscriptionOverview(): Promise<SubscriptionOverview> {
  return apiRequest<SubscriptionOverview>('/api/subscriptions');
}

export function listPlans(): Promise<{ plans: readonly PlanView[] }> {
  return apiRequest<{ plans: readonly PlanView[] }>('/api/subscriptions/plans');
}

export function listSubscriptionEvents(limit = 25): Promise<{ events: readonly PlanEventView[] }> {
  return apiRequest<{ events: readonly PlanEventView[] }>(
    `/api/subscriptions/events?limit=${limit}`,
  );
}

export function getPlanPermissions(): Promise<PlanPermissions> {
  return apiRequest<PlanPermissions>('/api/subscriptions/permissions');
}

export function changeMyPlan(
  planId: string,
  expectedVersion?: number,
): Promise<{ subscription: SubscriptionRecordView; direction: string }> {
  return apiRequest<{ subscription: SubscriptionRecordView; direction: string }>(
    '/api/subscriptions/me/change-plan',
    {
      method: 'POST',
      body: {
        planId,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      },
    },
  );
}

export function cancelMySubscription(
  reason: string,
): Promise<{ subscription: SubscriptionRecordView }> {
  return apiRequest<{ subscription: SubscriptionRecordView }>('/api/subscriptions/me/cancel', {
    method: 'POST',
    body: { reason },
  });
}
