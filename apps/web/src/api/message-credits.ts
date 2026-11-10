import { apiRequest } from './client';

/**
 * Typed client for message credits (Step 54).
 *
 * Read-mostly: the dashboard shows what a message costs, what has been charged,
 * and what is currently held. Charging itself happens on the server, during a
 * real request, and this client never sends a price.
 */

export type ChargeState = 'reserved' | 'committed' | 'released' | 'refunded' | 'failed' | 'exempt';

export interface MessageChargeView {
  readonly id: string;
  readonly kind: string;
  readonly state: ChargeState;
  readonly credits: number;
  readonly estimatedCredits: number;
  readonly basis: string;
  readonly planId: string;
  readonly policyId: string;
  readonly modelId: string | null;
  readonly providerId: string | null;
  readonly projectId: string | null;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly durationMs: number | null;
  readonly toolCalls: number | null;
  readonly byok: boolean;
  readonly limitations: readonly string[];
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly refundedAt: string | null;
  readonly failureReason: string | null;
}

export interface MessageCreditSummary {
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
    readonly open: number;
    readonly openCredits: number;
    readonly tokens: {
      readonly input: number;
      readonly output: number;
      readonly cached: number;
      readonly uncached: number;
    };
    readonly byKind: readonly { key: string; charges: number; credits: number }[];
  };
  readonly openReservations: readonly {
    readonly chargeId: string;
    readonly kind: string;
    readonly estimatedCredits: number;
    readonly conversationId: string | null;
    readonly createdAt: string;
  }[];
  readonly settings: {
    readonly monthlyLimit: number | null;
    readonly perRequestLimit: number | null;
  };
}

export interface UsageGroupView {
  readonly key: string;
  readonly charges: number;
  readonly credits: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface MessageCreditPolicyView {
  readonly version: string;
  readonly currency: string;
  readonly defaultsOnly: boolean;
  readonly note: string;
  readonly plans: readonly {
    readonly planId: string;
    readonly billable: boolean;
    readonly interactions: readonly {
      readonly kind: string;
      readonly policyId: string;
      readonly flatCredits: number;
      readonly per1kInput: number;
      readonly per1kOutput: number;
      readonly per1kCached: number;
      readonly perToolCall: number;
      readonly chargeByok: boolean;
      readonly enabled: boolean;
    }[];
  }[];
}

export interface MessageCreditEstimate {
  readonly estimate: {
    readonly credits: number;
    readonly basis: string;
    readonly lowerBound: boolean;
    readonly exempt: boolean;
    readonly policyId: string;
  };
  readonly planId: string;
  readonly walletAvailable: number;
  readonly affordable: boolean;
  readonly shortfall: number;
}

export interface MessageCreditIntegrity {
  readonly consistent: boolean;
  readonly walletDiscrepancies: readonly string[];
  readonly chargesWithoutEntry: readonly string[];
}

const base = '/api/message-credits';

export const getMessageCreditSummary = () => apiRequest<MessageCreditSummary>(base);

export const getMessageCreditPolicy = () => apiRequest<MessageCreditPolicyView>(`${base}/policy`);

export const listMessageCharges = (query: { limit?: number; state?: string } = {}) => {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.state !== undefined && query.state !== '') params.set('state', query.state);
  const suffix = params.toString();
  return apiRequest<{ charges: readonly MessageChargeView[]; total: number }>(
    `${base}/charges${suffix === '' ? '' : `?${suffix}`}`,
  );
};

export const getMessageUsage = (dimension: 'model' | 'project' | 'conversation') =>
  apiRequest<{ dimension: string; groups: readonly UsageGroupView[] }>(
    `${base}/usage?dimension=${dimension}`,
  );

export const getMessageCreditIntegrity = () =>
  apiRequest<MessageCreditIntegrity>(`${base}/integrity`);

export const estimateMessage = (body: { kind: string; modelId?: string }) =>
  apiRequest<MessageCreditEstimate>(`${base}/estimate`, {
    method: 'POST',
    body,
  });
