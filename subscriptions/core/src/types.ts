/**
 * Subscription vocabulary (Step 60).
 *
 * A subscription is a *record of which plan an account is on*, and a plan is a
 * *statement of what that account may do*. Neither is a price and neither is a
 * ledger: this package writes no charge, no credit and no balance. It decides
 * what the account is entitled to, and the existing lanes (Step 52 usage, Step
 * 53 wallet, Step 54 messages, Step 56 integrations, Step 59 limits) keep doing
 * their own jobs.
 *
 * Three distinctions are load bearing:
 *
 *  1. **A plan is a ceiling, not a grant.** `monthlyMessageCredits` and
 *     `monthlyIntegrationCredits` bound a period. They are not deposited into a
 *     wallet, because a balance must always be something that was actually put
 *     there. Step 60 therefore has no "grant" to duplicate: what it must do
 *     exactly once per period is *advance the period*, which `subscriptions`
 *     does under a unique key.
 *  2. **A missing entitlement is a refusal.** An entitlement that a plan does
 *     not state is not "inherit from somewhere": it is absent, and absent means
 *     no. That is what makes the catalogue extensible in one direction only -
 *     a new key never silently grants access to existing plans.
 *  3. **Status is derived, not hoped for.** A record whose period has run out is
 *     expired whether or not anybody ran the sweep, and a suspended record is
 *     suspended. Nothing has to remember to change a row for the refusal to
 *     happen.
 */

import type { QuotaLimitKey } from '@veltravia/usage-core';

/** The stored lifecycle states. `none` is a resolution, never a stored status. */
export const SUBSCRIPTION_STATUSES = [
  /** Paid for (or granted) and inside its current period. */
  'active',
  /** Inside a trial period. Entitlements are the plan's, the price is not yet due. */
  'trialing',
  /** The period ended while renewal is on. Access continues, renewal is outstanding. */
  'past_due',
  /** Held by an operator. Entitlements are withdrawn until reactivated. */
  'suspended',
  /** Cancelled. Runs to the end of the period it was paid for, then expires. */
  'canceled',
  /** The period ran out. Falls back to the development allowance. */
  'expired',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const isSubscriptionStatus = (value: string): value is SubscriptionStatus =>
  (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);

/** States in which the plan's entitlements are actually in force. */
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

export const isEntitledStatus = (status: SubscriptionStatus): boolean =>
  ENTITLED_STATUSES.includes(status);

/** An account may only be suspended from a live state, and only be resumed into one. */
export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = {
  active: ['suspended', 'canceled', 'past_due', 'expired'],
  trialing: ['active', 'suspended', 'canceled', 'expired'],
  past_due: ['active', 'suspended', 'canceled', 'expired'],
  suspended: ['active', 'canceled', 'expired'],
  canceled: ['active', 'expired'],
  expired: ['active'],
};

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/**
 * How an entitlement is checked.
 *
 *  - `flag`: allowed or not.
 *  - `quantity`: a ceiling (`null` = unlimited, absent = zero). The caller says
 *    how much it needs, so a limit is enforced at intake rather than after.
 */
export type EntitlementKind = 'flag' | 'quantity';

export interface EntitlementDefinition {
  /** Stable key. Changing one is a migration, so they are named as data. */
  readonly key: string;
  readonly kind: EntitlementKind;
  readonly group: string;
  readonly label: string;
  readonly description: string;
}

/**
 * Every entitlement this build understands.
 *
 * The registry is the *vocabulary*, not the policy: which plan grants what is
 * data in the plan row. Adding a feature means adding one entry here (so it can
 * be labelled and validated) and one check at the place the feature starts.
 * Adding a key never grants it to anybody, which is the safe direction.
 */
export const ENTITLEMENTS: readonly EntitlementDefinition[] = [
  {
    key: 'models.managed',
    kind: 'flag',
    group: 'AI',
    label: 'Managed model keys',
    description: 'Use Veltravia’s own provider credentials instead of your own.',
  },
  {
    key: 'models.byok',
    kind: 'flag',
    group: 'AI',
    label: 'Your own model keys',
    description: 'Use a provider key you supplied yourself (BYOK). Free, and never billed twice.',
  },
  {
    key: 'models.advanced',
    kind: 'flag',
    group: 'AI',
    label: 'Advanced AI features',
    description: 'Vision, long-context reasoning and the larger model catalogue.',
  },
  {
    key: 'features.reasoning',
    kind: 'flag',
    group: 'Features',
    label: 'Reasoning workspace',
    description: 'Run multi-step reasoning tasks with the model router.',
  },
  {
    key: 'features.coding_agent',
    kind: 'flag',
    group: 'Features',
    label: 'Coding agent',
    description: 'Plan, generate and revise source changes through the coding agent.',
  },
  {
    key: 'features.superagent',
    kind: 'flag',
    group: 'Features',
    label: 'Superagent workers',
    description: 'Delegate scoped work to bounded background workers and orchestrations.',
  },
  {
    key: 'features.app_builder',
    kind: 'flag',
    group: 'Features',
    label: 'Application builder',
    description: 'Scaffold and extend applications with the app builder.',
  },
  {
    key: 'features.testing',
    kind: 'flag',
    group: 'Features',
    label: 'Application testing',
    description: 'Run the testing agent and record its evidence.',
  },
  {
    key: 'features.integrations',
    kind: 'flag',
    group: 'Features',
    label: 'Third-party integrations',
    description: 'Connect external services and run their operations.',
  },
  {
    key: 'features.deployment',
    kind: 'flag',
    group: 'Features',
    label: 'Export and deployment',
    description: 'Export source, sync to a repository and publish a build.',
  },
  {
    key: 'features.collaboration',
    kind: 'flag',
    group: 'Features',
    label: 'Collaboration',
    description: 'Share workspaces and work in them with other people.',
  },
  {
    key: 'api.access',
    kind: 'flag',
    group: 'Platform',
    label: 'API access',
    description: 'Call the platform from your own scripts and services.',
  },
  {
    key: 'limits.projects',
    kind: 'quantity',
    group: 'Limits',
    label: 'Projects',
    description: 'How many projects the account may hold. Unlimited when blank.',
  },
  {
    key: 'limits.workspaces_per_project',
    kind: 'quantity',
    group: 'Limits',
    label: 'Workspaces per project',
    description: 'How many workspaces one project may hold. Unlimited when blank.',
  },
  {
    key: 'limits.members',
    kind: 'quantity',
    group: 'Limits',
    label: 'People per workspace',
    description: 'How many people may share a workspace. Unlimited when blank.',
  },
];

export type EntitlementKey = string;

const BY_KEY = new Map(ENTITLEMENTS.map((entry) => [entry.key, entry]));

export function entitlementDefinition(key: string): EntitlementDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** `null` means unlimited for a quantity, and "on" for a flag. */
export type EntitlementValue = boolean | number | null;

export type PlanEntitlements = Readonly<Record<EntitlementKey, EntitlementValue>>;

/**
 * The infrastructure quotas a plan sets. Same keys as Step 52, one algebra.
 *
 * Partial on purpose: a plan that says nothing about a quota inherits whatever
 * the deployment already does for it, so adding a quota tomorrow does not
 * silently zero somebody's storage. `null` is still an explicit "unlimited".
 */
export type PlanQuotaLimits = Readonly<Partial<Record<QuotaLimitKey, number | null>>>;

export interface SubscriptionPlanDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Ordering. A higher rank is the more capable plan, so a change is a compare. */
  readonly rank: number;
  /** Listed on the plan screen. An unlisted plan can still be assigned. */
  readonly visible: boolean;
  /** Assignable at all. Deactivating a plan keeps its subscribers on it. */
  readonly active: boolean;
  /** May be chosen by the customer rather than an operator. */
  readonly selfService: boolean;
  /**
   * Monthly ceilings bundled with the plan. Configurable defaults, not prices:
   * nothing here is a currency amount and nothing here can be bought.
   */
  readonly monthlyMessageCredits: number;
  readonly monthlyIntegrationCredits: number;
  readonly entitlements: PlanEntitlements;
  readonly quotas: PlanQuotaLimits;
  /** Compare-and-set token for edits. */
  readonly version: number;
  readonly builtIn: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  /** When this subscription began, which is when the first period began. */
  readonly startedAt: string;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  /** Renewal is on unless the subscription was cancelled. */
  readonly renews: boolean;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: string | null;
  readonly suspendedAt: string | null;
  readonly suspensionReason: string | null;
  /** Set when a status was reached by the clock rather than by an operator. */
  readonly expiredAt: string | null;
  readonly lastChangedAt: string;
  readonly lastChangedBy: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const SUBSCRIPTION_EVENT_KINDS = [
  'assigned',
  'upgraded',
  'downgraded',
  'renewed',
  'canceled',
  'suspended',
  'reactivated',
  'expired',
  'entitlements-changed',
  'plan-changed',
] as const;

export type SubscriptionEventKind = (typeof SUBSCRIPTION_EVENT_KINDS)[number];

export const isSubscriptionEventKind = (value: string): value is SubscriptionEventKind =>
  (SUBSCRIPTION_EVENT_KINDS as readonly string[]).includes(value);

/**
 * One thing that happened to a subscription. `dedupeKey` is unique per owner, so
 * a retried job writes the event once and the notification is sent once.
 */
export interface SubscriptionEvent {
  readonly id: string;
  readonly ownerRef: string;
  readonly kind: SubscriptionEventKind;
  readonly planId: string;
  readonly previousPlanId: string | null;
  readonly status: SubscriptionStatus;
  readonly message: string;
  readonly actor: string;
  readonly dedupeKey: string;
  readonly occurredAt: string;
}

export const SUBSCRIPTION_AUDIT_ACTIONS = [
  'plan-created',
  'plan-updated',
  'plan-activated',
  'plan-deactivated',
  'subscription-assigned',
  'subscription-plan-changed',
  'subscription-suspended',
  'subscription-reactivated',
  'subscription-canceled',
  'subscription-expired',
  'subscription-renewed',
] as const;

export type SubscriptionAuditAction = (typeof SUBSCRIPTION_AUDIT_ACTIONS)[number];

/** Who changed what, from what, to what, and why. Never editable, never deleted. */
export interface SubscriptionAuditRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly action: SubscriptionAuditAction;
  readonly actor: string;
  readonly reason: string;
  readonly previousState: unknown;
  readonly nextState: unknown;
  readonly occurredAt: string;
}

/** Why a plan is or is not in force. */
export type PlanSource =
  /** The account has a live subscription and its plan applies. */
  | 'subscription'
  /** No subscription row: the included development allowance applies. */
  | 'development-allowance'
  /** The subscription lapsed and the development allowance applies instead. */
  | 'lapsed'
  /** Suspended: no plan entitlements at all until an operator acts. */
  | 'suspended';

export interface EffectivePlan {
  readonly plan: SubscriptionPlanDefinition;
  readonly source: PlanSource;
  readonly status: SubscriptionStatus | 'none';
  /** True when the plan's entitlements are in force. */
  readonly entitled: boolean;
  /** Set when the plan is not in force, in words a screen can print. */
  readonly reason: string | null;
  readonly subscription: SubscriptionRecord | null;
  /** True when the clock says the period ended, whatever the stored status says. */
  readonly periodEnded: boolean;
  readonly renewalDue: boolean;
}

export class SubscriptionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Keys a caller may ask about; anything else is a programming error, not a 500. */
export function assertEntitlementKey(key: string): EntitlementDefinition {
  const definition = entitlementDefinition(key);
  if (definition === null) {
    throw new SubscriptionError(
      'UNKNOWN_ENTITLEMENT',
      `"${key}" is not an entitlement this build knows about.`,
      400,
      { key },
    );
  }
  return definition;
}

export function isQuotaKey(value: string): value is QuotaLimitKey {
  return (
    [
      'databaseStorageBytes',
      'fileStorageBytes',
      'bandwidthBytes',
      'backendExecutionMs',
      'backendExecutionCalls',
      'backgroundJobs',
      'concurrentJobs',
      'realtimeConnections',
      'providerTokens',
    ] as readonly string[]
  ).includes(value);
}
