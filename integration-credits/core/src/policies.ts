/**
 * What an external operation costs in credits (Step 56).
 *
 * Every number in the shipped table is a **configurable default**, not a market
 * price: it is labelled as such wherever it surfaces, it can be replaced wholesale
 * from the environment, and nothing here reads a provider's invoice. Credits
 * price this platform's work; the external invoice is a separate bill, and for a
 * BYOK caller it is theirs.
 *
 * Three shapes exist because external work is priced three ways:
 *
 *  - `perOperation`: a flat price for doing the thing at all;
 *  - `perRequest`: a price for each outbound request the operation made;
 *  - `rates`: a price per measured unit (records, bytes, pages, tokens, seconds).
 *
 * A policy may use any combination. A policy with none, or a `free` class, charges
 * nothing and says so.
 */

import type { BillingClass, IntegrationOperationKind, MeasurementUnit } from './types.js';

export interface IntegrationRate {
  readonly unit: MeasurementUnit;
  /** Credits charged per single unit. */
  readonly creditsPerUnit: number;
}

export interface IntegrationBillingPolicy {
  readonly id: string;
  readonly label: string;
  readonly kind: IntegrationOperationKind;
  /** An integration id, or `*` for every integration of this kind. */
  readonly integrationId: string;
  /** An operation id, or `*` for every operation the integration declares. */
  readonly operationId: string;
  readonly billingClass: BillingClass;
  /** Credits charged once per operation. */
  readonly perOperation: number;
  /** Credits charged per outbound request. */
  readonly perRequest: number;
  /** Credits charged per measured unit. */
  readonly rates: readonly IntegrationRate[];
  /**
   * An explicit authorisation to charge Veltravia credits for a service that
   * already bills the user's own external account. False everywhere in the
   * shipped table: charging twice is not a default anyone should inherit.
   */
  readonly chargeExternallyBilled: boolean;
  /**
   * Whether an operation made with the caller's own credential is charged.
   * False everywhere in the shipped table for usage: the external account paid.
   */
  readonly chargeByok: boolean;
}

export interface PlanIntegrationBilling {
  readonly planId: string;
  readonly label: string;
  /** When false, nothing on this plan is charged and every charge is `exempt`. */
  readonly billable: boolean;
  readonly policies: readonly IntegrationBillingPolicy[];
}

export interface IntegrationBillingCatalog {
  /** Bumped by hand whenever the defaults change, so old charges stay explainable. */
  readonly version: string;
  /** True for the shipped table: defaults, not market prices. */
  readonly defaultsOnly: boolean;
  readonly plans: readonly PlanIntegrationBilling[];
  readonly currency: 'credits';
}

const policy = (
  input: Partial<IntegrationBillingPolicy> &
    Pick<IntegrationBillingPolicy, 'id' | 'label' | 'kind'>,
): IntegrationBillingPolicy => ({
  integrationId: '*',
  operationId: '*',
  billingClass: 'paid',
  perOperation: 0,
  perRequest: 0,
  rates: [],
  chargeExternallyBilled: false,
  chargeByok: false,
  ...input,
});

/**
 * The shipped default table.
 *
 * Read the numbers as placeholders a deployment can replace: asking an
 * integration for something once, and the requests it took to answer. The mock
 * integrations are `free` because they run offline and cost nothing; GitHub is
 * `paid` because the platform holds the operator token and pays for those calls
 * itself. Nothing here claims to know what any provider charges in dollars.
 */
export function defaultIntegrationBillingCatalog(): IntegrationBillingCatalog {
  return {
    version: 'integration-credits/2026-11-default',
    defaultsOnly: true,
    currency: 'credits',
    plans: [
      {
        planId: 'development',
        label: 'Development (charges recorded, never enforced)',
        billable: false,
        policies: [
          policy({
            id: 'dev.integration',
            label: 'Integration operation',
            kind: 'integration.operation',
            billingClass: 'free',
          }),
          policy({
            id: 'dev.connector',
            label: 'Connector operation',
            kind: 'connector.operation',
            billingClass: 'free',
          }),
          policy({
            id: 'dev.plugin',
            label: 'Plugin operation',
            kind: 'plugin.operation',
            billingClass: 'free',
          }),
          policy({
            id: 'dev.external',
            label: 'External service',
            kind: 'external.service',
            billingClass: 'externally-billed',
          }),
        ],
      },
      {
        planId: 'paid',
        label: 'Paid',
        billable: true,
        policies: [
          // Offline integrations cost the platform nothing, so they are not priced.
          policy({
            id: 'paid.integration.free',
            label: 'Offline integration (free)',
            kind: 'integration.operation',
            integrationId: 'mock-storage',
            billingClass: 'free',
          }),
          policy({
            id: 'paid.integration.free-db',
            label: 'Offline integration (free)',
            kind: 'integration.operation',
            integrationId: 'mock-database',
            billingClass: 'free',
          }),
          // GitHub runs on the deployment's own token: priced, and small.
          policy({
            id: 'paid.integration.github',
            label: 'GitHub operation',
            kind: 'integration.operation',
            integrationId: 'github',
            perOperation: 0.4,
            perRequest: 0.04,
          }),
          policy({
            id: 'paid.integration',
            label: 'Integration operation',
            kind: 'integration.operation',
            perOperation: 0.5,
            perRequest: 0.05,
            rates: [{ unit: 'record', creditsPerUnit: 0.001 }],
          }),
          policy({
            id: 'paid.connector',
            label: 'Connector operation',
            kind: 'connector.operation',
            perOperation: 0.25,
            perRequest: 0.02,
            rates: [{ unit: 'record', creditsPerUnit: 0.001 }],
          }),
          policy({
            id: 'paid.plugin',
            label: 'Plugin operation',
            kind: 'plugin.operation',
            perOperation: 0.2,
            perRequest: 0.01,
          }),
          // A service that bills the user's own account is not charged here
          // unless a deployment replaces this row with `chargeExternallyBilled`.
          policy({
            id: 'paid.external',
            label: 'Externally billed service',
            kind: 'external.service',
            billingClass: 'externally-billed',
          }),
        ],
      },
    ],
  };
}

const nonNegative = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Reads a deployment's own table: `VELTRAVIA_INTEGRATION_CHARGES` as JSON in the
 * shape of `IntegrationBillingCatalog`. A malformed table is refused rather than
 * half-applied, because a half-applied price table is a billing incident.
 */
export function parseIntegrationBillingCatalog(raw: string | undefined): IntegrationBillingCatalog {
  const fallback = defaultIntegrationBillingCatalog();
  if (raw === undefined || raw.trim() === '') return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'VELTRAVIA_INTEGRATION_CHARGES is not valid JSON; refusing to guess a price table.',
    );
  }
  const table = parsed as Partial<IntegrationBillingCatalog>;
  if (table === null || typeof table !== 'object' || !Array.isArray(table.plans)) {
    throw new Error('VELTRAVIA_INTEGRATION_CHARGES must be an object with a plans array.');
  }
  const plans: PlanIntegrationBilling[] = table.plans.map((plan) => {
    const candidate = plan as unknown as PlanIntegrationBilling;
    const policies = Array.isArray(candidate.policies) ? candidate.policies : [];
    return {
      planId: String(candidate.planId),
      label: String(candidate.label ?? candidate.planId),
      billable: candidate.billable !== false,
      policies: policies.map((row) =>
        policy({
          id: String(row.id),
          label: String(row.label ?? row.id),
          kind: row.kind,
          integrationId: String(row.integrationId ?? '*'),
          operationId: String(row.operationId ?? '*'),
          billingClass: row.billingClass ?? 'paid',
          perOperation: nonNegative(row.perOperation, 0),
          perRequest: nonNegative(row.perRequest, 0),
          rates: Array.isArray(row.rates)
            ? row.rates.map((rate: IntegrationRate) => ({
                unit: rate.unit,
                creditsPerUnit: nonNegative(rate.creditsPerUnit, 0),
              }))
            : [],
          chargeExternallyBilled: row.chargeExternallyBilled === true,
          chargeByok: row.chargeByok === true,
        }),
      ),
    };
  });
  return {
    version: String(table.version ?? 'custom'),
    defaultsOnly: false,
    currency: 'credits',
    plans,
  };
}

/** The plan's row, falling back to the development row rather than inventing one. */
export function planBilling(
  catalog: IntegrationBillingCatalog,
  planId: string,
): PlanIntegrationBilling {
  return (
    catalog.plans.find((plan) => plan.planId === planId) ??
    catalog.plans.find((plan) => plan.planId === 'development') ?? {
      planId,
      label: planId,
      billable: false,
      policies: [],
    }
  );
}

export interface PolicyLookup {
  readonly kind: IntegrationOperationKind;
  readonly integrationId?: string | null;
  readonly operationId?: string | null;
}

/**
 * The policy that applies to one operation.
 *
 * Most specific wins: the same integration and the same operation beats the same
 * integration and any operation, which beats any integration of that kind. Ties
 * are impossible to construct because each (integration, operation) pair is one
 * address; the fallback order is fixed so the answer is stable.
 */
export function resolveIntegrationPolicy(
  plan: PlanIntegrationBilling,
  lookup: PolicyLookup,
): IntegrationBillingPolicy | null {
  const integrationId = lookup.integrationId ?? null;
  const operationId = lookup.operationId ?? null;
  let best: IntegrationBillingPolicy | null = null;
  let bestScore = -1;
  for (const candidate of plan.policies) {
    if (candidate.kind !== lookup.kind) continue;
    const integrationMatch =
      candidate.integrationId === '*'
        ? 0
        : integrationId !== null && candidate.integrationId === integrationId
          ? 2
          : -1;
    if (integrationMatch < 0) continue;
    const operationMatch =
      candidate.operationId === '*'
        ? 0
        : operationId !== null && candidate.operationId === operationId
          ? 1
          : -1;
    if (operationMatch < 0) continue;
    const score = integrationMatch + operationMatch;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** The billing class for an operation, taken from its policy or assumed free. */
export function billingClassFor(policy: IntegrationBillingPolicy | null): BillingClass {
  return policy?.billingClass ?? 'free';
}
