/**
 * What each subscription plan bundles (Step 56 follow-up).
 *
 * The monetisation model this mirrors is Base44's: a plan is not only a set of
 * infrastructure limits, it also bundles a monthly allowance of *message* credits
 * and *integration* credits. Four paid tiers carry those bundles, and the free
 * development allowance sits below them.
 *
 * Two rules keep this table honest:
 *
 *  1. **These are configurable defaults, not prices.** Nothing here is a currency
 *     amount, nothing here is an offer, and nothing here can be bought: Veltravia
 *     has no checkout. The API publishes the table so a screen can say what a plan
 *     includes, and says in the same payload that these are defaults.
 *  2. **A plan is a ceiling, not a grant.** The allowance bounds a month; it does
 *     not deposit credits into a wallet. Credits still arrive through the wallet
 *     (Step 53) so a balance is always something that was actually put there.
 *
 * An account's plan comes from the entitlement already in Step 52 (`planOf`), so
 * this table adds a name and a bundle to a plan id the platform already records
 * rather than inventing a second source of truth.
 */

export const SUBSCRIPTION_PLAN_IDS = ['development', 'starter', 'builder', 'pro', 'elite'] as const;

export type SubscriptionPlanId = (typeof SUBSCRIPTION_PLAN_IDS)[number];

export interface IntegrationPlanDefinition {
  readonly id: SubscriptionPlanId;
  readonly label: string;
  /** Monthly ceiling for integration charges. Configurable default, not a price. */
  readonly monthlyIntegrationCredits: number;
  /** What the same plan bundles for model work in Step 54. Informational here. */
  readonly monthlyMessageCredits: number;
  readonly note: string;
}

/**
 * The four paid tiers and the development allowance.
 *
 * The shape of the bundles follows the tiered model (a free allowance, then four
 * increasing paid tiers); the numbers are placeholders this deployment ships with
 * and any operator is expected to change them. They are deliberately *not* paired
 * with any money figure anywhere in the product.
 */
export const INTEGRATION_PLANS: Readonly<Record<SubscriptionPlanId, IntegrationPlanDefinition>> = {
  development: {
    id: 'development',
    label: 'Development allowance',
    monthlyIntegrationCredits: 500,
    monthlyMessageCredits: 25,
    note: 'Included while there is no subscription. Small by design and separate from the paid tiers.',
  },
  starter: {
    id: 'starter',
    label: 'Starter',
    monthlyIntegrationCredits: 2_000,
    monthlyMessageCredits: 100,
    note: 'Entry tier bundle. Configurable default.',
  },
  builder: {
    id: 'builder',
    label: 'Builder',
    monthlyIntegrationCredits: 10_000,
    monthlyMessageCredits: 250,
    note: 'Middle tier bundle. Configurable default.',
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    monthlyIntegrationCredits: 20_000,
    monthlyMessageCredits: 500,
    note: 'Upper tier bundle. Configurable default.',
  },
  elite: {
    id: 'elite',
    label: 'Elite',
    monthlyIntegrationCredits: 50_000,
    monthlyMessageCredits: 1_200,
    note: 'Top tier bundle. Configurable default.',
  },
};

/** Said wherever the table is published, so no screen can present it as pricing. */
export const PLAN_DEFAULTS_NOTE =
  'Configurable defaults shipped with Veltravia. Not prices, and not an offer: there is no checkout.';

/**
 * The tier a deployment maps its subscribed accounts to.
 *
 * Veltravia's entitlement records a plan of `development` or `paid`; four paid
 * tiers need one of them to be the deployment's default. `builder` is the middle
 * of the four, and an operator overrides it with `VELTRAVIA_PAID_PLAN`.
 */
export const DEFAULT_PAID_PLAN: SubscriptionPlanId = 'builder';

export const isSubscriptionPlanId = (value: string): value is SubscriptionPlanId =>
  (SUBSCRIPTION_PLAN_IDS as readonly string[]).includes(value);

export function planById(id: string): IntegrationPlanDefinition | null {
  return isSubscriptionPlanId(id) ? INTEGRATION_PLANS[id] : null;
}

/**
 * The plan an account is on, from the entitlement this platform already keeps.
 *
 * A paid account without a named tier gets the deployment's default tier rather
 * than an invented one, and an unrecognised value is treated as the development
 * allowance: unknown never means "the most generous plan".
 */
export function planForEntitlement(
  planId: string | null | undefined,
  paidPlanId: SubscriptionPlanId = DEFAULT_PAID_PLAN,
): IntegrationPlanDefinition {
  if (planId === 'paid') return INTEGRATION_PLANS[paidPlanId];
  const named = planId === null || planId === undefined ? null : planById(planId);
  return named ?? INTEGRATION_PLANS.development;
}

/** The catalog with the note attached, for a route that publishes it. */
export function publishablePlans(paidPlanId: SubscriptionPlanId = DEFAULT_PAID_PLAN): {
  readonly note: string;
  readonly defaultPaidPlan: SubscriptionPlanId;
  readonly plans: readonly IntegrationPlanDefinition[];
} {
  return {
    note: PLAN_DEFAULTS_NOTE,
    defaultPaidPlan: paidPlanId,
    plans: SUBSCRIPTION_PLAN_IDS.map((id) => INTEGRATION_PLANS[id]),
  };
}
