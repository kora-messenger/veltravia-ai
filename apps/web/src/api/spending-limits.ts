import { apiRequest } from './client';

/**
 * Typed client for spending limits (Step 59).
 *
 * Writes here change what the platform will refuse, so every write carries the
 * version the screen was looking at and the server answers 409 when somebody
 * else moved first. Nothing on this page can move credits: limits bound a
 * balance, they never add to or take from it.
 */

export type SpendCategory =
  | 'ai_messages'
  | 'coding'
  | 'agents'
  | 'reasoning'
  | 'tools'
  | 'background'
  | 'integrations'
  | 'infrastructure';

export type LimitScope = 'user' | 'workspace' | 'project';
export type LimitPeriod = 'daily' | 'weekly' | 'monthly' | 'custom';
export type LimitMode = 'hard' | 'soft';
export type LimitRuleTarget = SpendCategory | 'all';

export interface LimitRuleDraft {
  readonly id?: string;
  readonly target: LimitRuleTarget;
  readonly period: LimitPeriod;
  readonly limit: number;
  readonly mode: LimitMode;
  readonly warnAt: number[];
  readonly periodDays?: number | null;
}

export interface LimitRuleView extends LimitRuleDraft {
  readonly id: string;
}

export interface SpendingPolicyView {
  readonly id: string;
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly version: number;
  readonly rules: readonly LimitRuleView[];
  readonly perOperationLimit: number | null;
  readonly maxReservedCredits: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LimitStatusView {
  readonly ruleId: string;
  readonly scope: LimitScope;
  readonly label: string;
  readonly target: LimitRuleTarget;
  readonly targetLabel: string;
  readonly period: LimitPeriod;
  readonly mode: LimitMode;
  readonly limit: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly state: 'clear' | 'warning' | 'reached';
  readonly resetsAt: string | null;
  readonly warnAt: readonly number[];
}

export interface CategoryUsageView {
  readonly category: SpendCategory;
  readonly label: string;
  readonly committed: number;
  readonly reserved: number;
  readonly refunded: number;
  readonly charges: number;
  readonly priced: boolean;
}

export interface LimitEventView {
  readonly id: string;
  readonly kind: 'warning' | 'limit-reached' | 'operation-refused' | 'override' | 'reset';
  readonly scope: LimitScope;
  readonly ruleId: string | null;
  readonly message: string;
  readonly occurredAt: string;
}

export interface SpendingLimitsOverview {
  readonly scopes: readonly {
    readonly scope: LimitScope;
    readonly workspaceId: string | null;
    readonly projectId: string | null;
    readonly policy: SpendingPolicyView | null;
    readonly inherited: boolean;
  }[];
  readonly limits: readonly LimitStatusView[];
  readonly windows: readonly {
    readonly period: string;
    readonly start: string;
    readonly end: string;
  }[];
  readonly usage: {
    readonly today: readonly CategoryUsageView[];
    readonly week: readonly CategoryUsageView[];
    readonly month: readonly CategoryUsageView[];
  };
  readonly heldCredits: number;
  readonly perOperationLimit: number | null;
  readonly maxReservedCredits: number | null;
  readonly enforcement: 'enforced' | 'disabled' | 'unconfigured';
  readonly platform: {
    readonly maxLimitPerRule: number | null;
    readonly enforcementDisabled: boolean;
    readonly note?: string;
  };
  readonly wallet: {
    readonly available: number;
    readonly reserved: number;
    readonly spent: number;
  } | null;
  readonly events: readonly LimitEventView[];
  readonly generatedAt: string;
}

export interface LimitDecision {
  readonly allowed: boolean;
  readonly violation: {
    readonly reason: string;
    readonly message: string;
    readonly ruleId: string | null;
    readonly limit: number | null;
    readonly requested: number;
    readonly consumed: number | null;
    readonly remaining: number | null;
    readonly window: { readonly end: string } | null;
  } | null;
}

export interface SavePolicyInput {
  readonly scope: LimitScope;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly rules: readonly LimitRuleDraft[];
  readonly perOperationLimit?: number | null;
  readonly maxReservedCredits?: number | null;
  /** The version the screen read; null creates the policy. */
  readonly expectedVersion: number | null;
  readonly reason?: string;
}

export const getSpendingLimits = (): Promise<SpendingLimitsOverview> =>
  apiRequest<SpendingLimitsOverview>('/spending-limits');

export const saveSpendingPolicy = (input: SavePolicyInput): Promise<SpendingPolicyView> =>
  apiRequest<{ policy: SpendingPolicyView }>('/spending-limits/policy', {
    method: 'PUT',
    body: input,
  }).then((body) => body.policy);

export const resetSpendingPolicy = (input: {
  readonly scope: LimitScope;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly expectedVersion: number;
  readonly reason?: string;
}): Promise<void> => apiRequest<void>('/spending-limits/policy', { method: 'DELETE', body: input });

export const checkSpending = (input: {
  readonly category: SpendCategory;
  readonly requested: number;
}): Promise<LimitDecision> => {
  const query = `?category=${encodeURIComponent(input.category)}&requested=${input.requested}`;
  return apiRequest<LimitDecision>(`/spending-limits/check${query}`);
};
