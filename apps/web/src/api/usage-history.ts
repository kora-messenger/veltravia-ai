import { apiRequest } from './client';

/**
 * Typed client for the usage history dashboard (Step 58).
 *
 * Read-only, and deliberately so: nothing here can charge, refund or adjust a
 * balance. Every number the page shows was computed by the server from the
 * wallet ledger and the charge records; the browser only formats it.
 *
 * Two shapes are worth knowing before reading a component:
 *
 *  - `UsageHistoryOverview` carries the wallet's balance verbatim plus the
 *    totals for a period, each with a `completeness` flag. When `complete` is
 *    false the total is a partial sum and the page has to say so.
 *  - `UsageHistoryPage` is one page of events, with an opaque `nextCursor`. The
 *    cursor is a server boundary, not an offset, so paging stays correct while
 *    new charges arrive.
 */

export type UsageHistoryCategory =
  | 'ai_messages'
  | 'coding'
  | 'agents'
  | 'reasoning'
  | 'tools'
  | 'background'
  | 'integrations'
  | 'infrastructure';

export type UsageEventStatus =
  'reserved' | 'committed' | 'released' | 'refunded' | 'exempt' | 'measured';

export type UsageMovement =
  'deduction' | 'reservation' | 'release' | 'refund' | 'no-charge' | 'measurement';

export type UsageBreakdownDimension =
  'category' | 'project' | 'model' | 'provider' | 'day' | 'month' | 'activity';

export interface UsageEventMeasurement {
  readonly unit: string;
  readonly quantity: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly requests: number | null;
  readonly durationMs: number | null;
}

export interface UsageEventView {
  readonly id: string;
  readonly occurredAt: string;
  readonly settledAt: string | null;
  readonly source: 'message' | 'integration' | 'infrastructure';
  readonly category: UsageHistoryCategory;
  readonly categoryLabel: string;
  readonly activity: string;
  readonly detail: string;
  readonly movement: UsageMovement;
  readonly status: UsageEventStatus;
  readonly credits: number;
  readonly estimatedCredits: number;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly modelId: string | null;
  readonly providerId: string | null;
  readonly providerCharge: 'user' | 'veltravia' | 'none';
  readonly measurement: UsageEventMeasurement | null;
  readonly limitations: readonly string[];
  readonly pricing: {
    readonly policyId: string;
    readonly basis: string;
    readonly byok: boolean;
    readonly note: string;
  };
}

export interface UsageHistoryCompleteness {
  readonly complete: boolean;
  readonly scanned: number;
  readonly cap: number;
  readonly note: string;
}

export interface UsageHistoryGroup {
  readonly key: string;
  readonly label: string;
  readonly events: number;
  readonly credits: number;
  readonly share: number;
  readonly measured: number;
}

export interface UsageRange {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly days: number;
}

export interface UsageHistoryOverview {
  readonly ownerRef: string;
  readonly at: string;
  readonly range: UsageRange;
  readonly wallet: {
    readonly available: number;
    readonly reserved: number;
    readonly spent: number;
    readonly spendable: number;
    readonly currency: string;
    readonly durable: boolean;
    readonly updatedAt: string;
  };
  readonly period: {
    readonly from: string;
    readonly to: string;
    readonly charges: number;
    readonly credits: number;
    readonly refunded: number;
    readonly openCharges: number;
    readonly openCredits: number;
    readonly tokens: {
      readonly input: number;
      readonly output: number;
      readonly cached: number;
      readonly uncached: number;
    };
    readonly integration: { readonly charges: number; readonly credits: number };
    readonly completeness: UsageHistoryCompleteness;
  };
  readonly selected: {
    readonly charges: number;
    readonly credits: number;
    readonly refunded: number;
    readonly released: number;
    readonly byCategory: readonly UsageHistoryGroup[];
    readonly completeness: UsageHistoryCompleteness;
  };
  readonly recent: readonly UsageEventView[];
  readonly infrastructure: {
    readonly measured: readonly {
      readonly category: string;
      readonly label: string;
      readonly quantity: number | null;
      readonly unit: string;
      readonly status: string;
    }[];
    readonly note: string;
  };
  readonly ledger: {
    readonly creditsAdded: number;
    readonly creditsRefunded: number;
    readonly entries: readonly {
      readonly id: string;
      readonly kind: string;
      readonly amount: number;
      readonly reason: string;
      readonly occurredAt: string;
      readonly balanceAfter: number;
    }[];
    readonly completeness: UsageHistoryCompleteness;
  };
  readonly pricing: {
    readonly catalogVersion: string;
    readonly defaultsOnly: boolean;
    readonly note: string;
    readonly currency: string;
  };
}

export interface UsageHistoryPageView {
  readonly ownerRef: string;
  readonly range: UsageRange;
  readonly events: readonly UsageEventView[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly total: number | null;
  readonly completeness: UsageHistoryCompleteness;
  readonly filters: {
    readonly categories: readonly UsageHistoryCategory[];
    readonly status: readonly UsageEventStatus[];
    readonly projectId: string | null;
    readonly workspaceId: string | null;
    readonly modelId: string | null;
    readonly providerId: string | null;
    readonly query: string | null;
  };
}

export interface UsageBreakdownView {
  readonly ownerRef: string;
  readonly dimension: UsageBreakdownDimension;
  readonly range: UsageRange;
  readonly groups: readonly UsageHistoryGroup[];
  readonly largest: readonly UsageEventView[];
  readonly totals: { readonly events: number; readonly credits: number; readonly measured: number };
  readonly completeness: UsageHistoryCompleteness;
  readonly note: string;
}

/** What a caller may ask for. Dates are `YYYY-MM-DD` in UTC. */
export interface UsageHistoryQuery {
  readonly from?: string;
  readonly to?: string;
  readonly categories?: readonly UsageHistoryCategory[];
  readonly status?: readonly UsageEventStatus[];
  readonly projectId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly query?: string;
  readonly workspaceId?: string | null;
  readonly limit?: number;
  readonly cursor?: string;
}

/** A URL the browser can be sent to for the CSV download. */
export function usageExportUrl(query: UsageHistoryQuery = {}): string {
  const params = queryParams(query);
  const suffix = params.toString();
  return `/api/usage-history/export.csv${suffix === '' ? '' : `?${suffix}`}`;
}

function queryParams(query: UsageHistoryQuery, includePaging = false): URLSearchParams {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.categories && query.categories.length > 0) {
    params.set('category', query.categories.join(','));
  }
  if (query.status && query.status.length > 0) params.set('status', query.status.join(','));
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.modelId) params.set('modelId', query.modelId);
  if (query.providerId) params.set('providerId', query.providerId);
  if (query.query) params.set('q', query.query);
  if (query.workspaceId) params.set('workspaceId', query.workspaceId);
  if (includePaging) {
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
  }
  return params;
}

function withQuery(path: string, query: UsageHistoryQuery, includePaging = false): string {
  const params = queryParams(query, includePaging);
  const suffix = params.toString();
  return suffix === '' ? path : `${path}?${suffix}`;
}

export const getUsageOverview = (workspaceId?: string | null) =>
  apiRequest<UsageHistoryOverview>(withQuery('/api/usage-history/overview', { workspaceId }));

export const listUsageHistory = (query: UsageHistoryQuery = {}) =>
  apiRequest<UsageHistoryPageView>(withQuery('/api/usage-history', query, true));

export const getUsageBreakdown = (
  dimension: UsageBreakdownDimension,
  query: UsageHistoryQuery = {},
) => {
  const params = queryParams(query);
  params.set('dimension', dimension);
  return apiRequest<UsageBreakdownView>(`/api/usage-history/breakdown?${params.toString()}`);
};

export const getUsageCapabilities = () =>
  apiRequest<{
    readonly categories: readonly {
      readonly key: UsageHistoryCategory;
      readonly label: string;
      readonly source: string;
      readonly note: string | null;
    }[];
    readonly dimensions: readonly UsageBreakdownDimension[];
    readonly scanCap: number;
    readonly notes: readonly string[];
  }>('/api/usage-history/capabilities');
