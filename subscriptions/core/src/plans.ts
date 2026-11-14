/**
 * The plan catalogue that ships with this deployment.
 *
 * These are **configurable defaults, not prices**. Nothing here is a currency
 * amount, nothing here is an offer, and nothing here can be bought - there is no
 * checkout in this build. The numbers are the placeholders Steps 56 and 59
 * already shipped (2,000 / 10,000 / 20,000 / 50,000 integration credits, and
 * their message-credit bundles), plus the quota set Step 52 already had for the
 * paid plan. A test asserts that this table and
 * `@veltravia/integration-credits-core`'s tier table agree, so the two cannot
 * drift while both exist.
 *
 * The development allowance is the plan an account is on when it has no
 * subscription. It deliberately grants every feature this product currently
 * ships, because Step 60 must not quietly take working functionality away from
 * existing accounts; what a lapsed or suspended subscription loses is the *paid*
 * quota set and the managed provider keys, which is exactly the difference the
 * product already draws between the included allowance and a paid plan.
 */

import type { QuotaLimitKey } from '@veltravia/usage-core';

import type { PlanEntitlements, PlanQuotaLimits, SubscriptionPlanDefinition } from './types.js';

/** Said wherever the catalogue is published, so no screen can present it as pricing. */
export const PLAN_DEFAULTS_NOTE =
  'Configurable defaults for this deployment. Not prices and not an offer: there is no checkout in this build.';

/** The plan an account without a subscription is on. */
export const DEVELOPMENT_PLAN_ID = 'development';

/** The ids the paid tiers use. A deployment may add more; these ship. */
export const PAID_PLAN_IDS = ['starter', 'builder', 'pro', 'elite'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Step 52's development quota set, unchanged, so existing accounts see no difference. */
export const DEVELOPMENT_QUOTAS: PlanQuotaLimits = {
  databaseStorageBytes: 64 * MB,
  fileStorageBytes: 512 * MB,
  bandwidthBytes: 2 * GB,
  backendExecutionMs: 60 * 60 * 1000,
  backendExecutionCalls: 5_000,
  backgroundJobs: 500,
  concurrentJobs: 3,
  realtimeConnections: 5,
  providerTokens: 250_000,
};

/** Step 52's paid quota set, as the entry tier's, with larger tiers around it. */
function paidQuotas(
  factor: number,
  concurrentJobs: number,
  providerTokens: number,
): PlanQuotaLimits {
  return {
    databaseStorageBytes: 2 * GB * factor,
    fileStorageBytes: 20 * GB * factor,
    bandwidthBytes: 50 * GB * factor,
    backendExecutionMs: 40 * 60 * 60 * 1000 * factor,
    backendExecutionCalls: 200_000 * factor,
    backgroundJobs: 20_000 * factor,
    concurrentJobs,
    realtimeConnections: 25 * Math.min(factor, 4),
    providerTokens,
  };
}

/**
 * The governed features every plan in this build grants, keyed off the
 * development allowance. A plan row states them explicitly rather than
 * inheriting, so an operator can turn one off for one plan without touching
 * another - and so "absent" never has to mean "inherit".
 */
const GRANTED_FEATURES: PlanEntitlements = {
  'models.managed': true,
  'models.byok': true,
  'models.advanced': true,
  'features.reasoning': true,
  'features.coding_agent': true,
  'features.superagent': true,
  'features.app_builder': true,
  'features.testing': true,
  'features.integrations': true,
  'features.deployment': true,
  'features.collaboration': true,
  'api.access': true,
  // No project count is imposed on any shipped plan: this product has never had
  // one, and inventing a ceiling would break working accounts. The key exists so
  // an operator can impose one, and the gate that enforces it is real and tested.
  'limits.projects': null,
  'limits.workspaces_per_project': null,
  'limits.members': null,
};

interface SeedPlan {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rank: number;
  readonly message: number;
  readonly integration: number;
  readonly quotas: Readonly<Partial<Record<QuotaLimitKey, number | null>>>;
}

const SEEDS: readonly SeedPlan[] = [
  {
    id: DEVELOPMENT_PLAN_ID,
    name: 'Included allowance',
    description:
      'What an account has without a subscription: the included development allowance, every feature this build ships, and modest infrastructure quotas.',
    rank: 0,
    message: 25,
    integration: 500,
    quotas: DEVELOPMENT_QUOTAS,
  },
  {
    id: 'starter',
    name: 'Starter',
    description:
      'Entry tier. A monthly ceiling of 2,000 integration credits and 100 message credits, with the paid infrastructure quota set.',
    rank: 10,
    message: 100,
    integration: 2_000,
    quotas: paidQuotas(1, 6, 5_000_000),
  },
  {
    id: 'builder',
    name: 'Builder',
    description:
      'Middle tier. A monthly ceiling of 10,000 integration credits and 250 message credits, with twice the entry quota.',
    rank: 20,
    message: 250,
    integration: 10_000,
    quotas: paidQuotas(2, 10, 12_000_000),
  },
  {
    id: 'pro',
    name: 'Pro',
    description:
      'Upper tier. A monthly ceiling of 20,000 integration credits and 500 message credits, with four times the entry quota.',
    rank: 30,
    message: 500,
    integration: 20_000,
    quotas: paidQuotas(4, 16, 30_000_000),
  },
  {
    id: 'elite',
    name: 'Elite',
    description:
      'Top tier. A monthly ceiling of 50,000 integration credits and 1,200 message credits, with the largest quota set this build ships.',
    rank: 40,
    message: 1_200,
    integration: 50_000,
    quotas: paidQuotas(8, 32, 80_000_000),
  },
];

const SEED_TIME = '1970-01-01T00:00:00.000Z';

/**
 * The catalogue as data. `now` is injected so seeding a fresh database writes a
 * timestamp that means something; the default is honest about being a seed.
 */
export function seedPlans(
  now: () => string = () => SEED_TIME,
): readonly SubscriptionPlanDefinition[] {
  const at = now();
  return SEEDS.map((seed) => ({
    id: seed.id,
    name: seed.name,
    description: seed.description,
    rank: seed.rank,
    visible: true,
    active: true,
    // Nobody can move themselves onto a paid tier in this build: there is no
    // payment step to make the change real. The development allowance is the only
    // self-selectable plan, and it is what "cancel" returns an account to.
    selfService: seed.id === DEVELOPMENT_PLAN_ID,
    monthlyMessageCredits: seed.message,
    monthlyIntegrationCredits: seed.integration,
    entitlements: { ...GRANTED_FEATURES },
    quotas: { ...seed.quotas },
    version: 1,
    builtIn: true,
    createdAt: at,
    updatedAt: at,
    updatedBy: 'system',
  }));
}

/** The development allowance, for a caller that needs one without a catalogue read. */
export function developmentPlan(now: () => string = () => SEED_TIME): SubscriptionPlanDefinition {
  const found = seedPlans(now).find((plan) => plan.id === DEVELOPMENT_PLAN_ID);
  if (found === undefined) throw new Error('the development allowance is missing from the seeds');
  return found;
}

/** Visible and active, in rank order: what a customer-facing screen may show. */
export function catalogueFor(
  plans: readonly SubscriptionPlanDefinition[],
): readonly SubscriptionPlanDefinition[] {
  return plans
    .filter((plan) => plan.visible && plan.active)
    .slice()
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

/** Every plan an operator may see, including unlisted and deactivated ones. */
export function allPlans(
  plans: readonly SubscriptionPlanDefinition[],
): readonly SubscriptionPlanDefinition[] {
  return plans.slice().sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

export function findPlan(
  plans: readonly SubscriptionPlanDefinition[],
  planId: string,
): SubscriptionPlanDefinition | null {
  return plans.find((plan) => plan.id === planId) ?? null;
}

/** The highest-ranked plan, used when a deployment needs a default paid tier. */
export function highestPlan(
  plans: readonly SubscriptionPlanDefinition[],
): SubscriptionPlanDefinition | null {
  const active = plans.filter((plan) => plan.active);
  return active.slice().sort((a, b) => b.rank - a.rank || b.id.localeCompare(a.id))[0] ?? null;
}
