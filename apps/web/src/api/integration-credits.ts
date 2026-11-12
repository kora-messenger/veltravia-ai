import { apiRequest } from './client';

/**
 * Typed client for integration credits (Step 56).
 *
 * Read-mostly, like the message-credit client: it reports what third-party work
 * costs, what was charged, what is held and where the credit went. Charging
 * happens on the server, during a real operation, and this client never sends a
 * price.
 *
 * The three billing classes are a first-class part of the shape because they are
 * the point: a free integration, a platform-paid one, and a service that bills
 * the user's own account look nothing alike on an invoice, and the dashboard must
 * not blur them.
 */

export type IntegrationChargeState =
  'reserved' | 'committed' | 'released' | 'refunded' | 'failed' | 'exempt';

export type IntegrationBillingClass = 'free' | 'paid' | 'externally-billed';

export interface IntegrationChargeView {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly integrationId: string | null;
  readonly connectorId: string | null;
  readonly operationId: string | null;
  readonly executionId: string | null;
  readonly requestId: string | null;
  readonly connectionId: string | null;
  readonly kind: string;
  readonly billingClass: IntegrationBillingClass;
  readonly planId: string;
  readonly policyId: string;
  readonly credits: number;
  readonly estimatedCredits: number;
  readonly state: IntegrationChargeState;
  readonly basis: string;
  readonly requests: number | null;
  readonly units: Readonly<Record<string, number>>;
  readonly durationMs: number | null;
  readonly limitations: readonly string[];
  readonly measurementSource: string | null;
  readonly byok: boolean;
  readonly reservationId: string | null;
  readonly walletEntryId: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly refundedAt: string | null;
}

export interface IntegrationUsageGroupView {
  readonly key: string;
  readonly charges: number;
  readonly credits: number;
  readonly requests: number;
  readonly units: number;
}

export interface IntegrationCreditSummary {
  readonly wallet: {
    readonly available: number;
    readonly reserved: number;
    readonly spent: number;
    readonly spendable: number;
  };
  readonly month: {
    readonly charges: number;
    readonly credits: number;
    readonly refunded: number;
    readonly exempt: number;
    readonly open: number;
    readonly openCredits: number;
    readonly requests: number;
    readonly units: number;
    readonly byBillingClass: readonly IntegrationUsageGroupView[];
    readonly byIntegration: readonly IntegrationUsageGroupView[];
  };
  readonly openHolds: readonly {
    readonly chargeId: string;
    readonly integrationId: string | null;
    readonly operationId: string | null;
    readonly executionId: string | null;
    readonly estimatedCredits: number;
    readonly createdAt: string;
  }[];
  readonly settings: {
    readonly monthlyLimit: number | null;
    readonly perOperationLimit: number | null;
    readonly updatedAt: string | null;
  };
}

export interface IntegrationCreditPolicyView {
  readonly version: string;
  readonly defaultsOnly: boolean;
  readonly note: string;
  readonly currency: string;
  readonly holdTtlSeconds: number;
  readonly classes: readonly {
    readonly billingClass: IntegrationBillingClass;
    readonly label: string;
    readonly meaning: string;
  }[];
  readonly plans: readonly {
    readonly planId: string;
    readonly label: string;
    readonly billable: boolean;
    readonly policies: readonly {
      readonly id: string;
      readonly label: string;
      readonly kind: string;
      readonly integrationId: string;
      readonly operationId: string;
      readonly billingClass: IntegrationBillingClass;
      readonly perOperation: number;
      readonly perRequest: number;
      readonly rates: readonly { readonly unit: string; readonly creditsPerUnit: number }[];
      readonly chargeExternallyBilled: boolean;
      readonly chargeByok: boolean;
    }[];
  }[];
}

export interface IntegrationClassificationView {
  readonly planId: string;
  readonly policyId: string;
  readonly billingClass: IntegrationBillingClass;
  readonly billable: boolean;
  readonly reason: string;
  readonly limitations: readonly string[];
}

export interface IntegrationEstimateView {
  readonly credits: number;
  readonly basis: string;
  readonly exempt: boolean;
  readonly lowerBound: boolean;
  readonly policyId: string;
}

export interface IntegrationClassifyResult {
  readonly classification: IntegrationClassificationView;
  readonly estimate: IntegrationEstimateView;
  readonly walletAvailable: number;
  readonly affordable: boolean;
  readonly shortfall: number;
}

export interface IntegrationCreditIntegrity {
  readonly consistent: boolean;
  readonly chargesWithoutEntry: number;
  readonly wallet: { readonly consistent: boolean; readonly discrepancies: readonly string[] };
}

export type IntegrationUsageDimension =
  'integration' | 'connector' | 'operation' | 'project' | 'billingClass';

const base = '/api/integration-credits';

export const getIntegrationCreditSummary = () => apiRequest<IntegrationCreditSummary>(base);

export const getIntegrationCreditPolicy = () =>
  apiRequest<IntegrationCreditPolicyView>(`${base}/policy`);

export const listIntegrationCharges = (
  query: { limit?: number; state?: string; billingClass?: string } = {},
) => {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.state !== undefined && query.state !== '') params.set('state', query.state);
  if (query.billingClass !== undefined && query.billingClass !== '') {
    params.set('billingClass', query.billingClass);
  }
  const suffix = params.toString();
  return apiRequest<{ charges: readonly IntegrationChargeView[]; total: number }>(
    `${base}/charges${suffix === '' ? '' : `?${suffix}`}`,
  );
};

export const getIntegrationUsage = (dimension: IntegrationUsageDimension) =>
  apiRequest<{ dimension: string; groups: readonly IntegrationUsageGroupView[] }>(
    `${base}/usage?dimension=${dimension}`,
  );

export const getIntegrationCreditIntegrity = () =>
  apiRequest<IntegrationCreditIntegrity>(`${base}/integrity`);

/** What an operation would cost, and who pays. Writes nothing. */
export const classifyIntegrationOperation = (body: {
  kind: string;
  integrationId?: string;
  operationId: string;
  expectedRequests?: number;
  byok?: boolean;
}) =>
  apiRequest<IntegrationClassifyResult>(`${base}/classify`, {
    method: 'POST',
    body,
  });

export const updateIntegrationCreditSettings = (body: {
  monthlyLimit: number | null;
  perOperationLimit: number | null;
}) =>
  apiRequest<IntegrationCreditSummary['settings']>(`${base}/settings`, {
    method: 'PUT',
    body,
  });
