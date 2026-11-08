import { apiRequest } from './client';

/**
 * Typed client for usage and quotas (Step 52).
 *
 * The server decides what is enforceced; this client only asks. That matters for
 * one display rule the panel depends on: a limit whose `used` is null is a limit
 * nothing measures, and the page has to say that instead of drawing a full bar.
 */

export type UsageCategory =
  | 'database_storage'
  | 'backend_execution'
  | 'file_storage'
  | 'bandwidth'
  | 'hosting'
  | 'background_jobs'
  | 'realtime'
  | 'ai_provider';

export type QuotaLimitKey =
  | 'databaseStorageBytes'
  | 'fileStorageBytes'
  | 'bandwidthBytes'
  | 'backendExecutionMs'
  | 'backendExecutionCalls'
  | 'backgroundJobs'
  | 'concurrentJobs'
  | 'realtimeConnections'
  | 'providerTokens';

export type LimitEnforcement = 'hard' | 'best_effort' | 'not_enforced';

export interface UsageLimitView {
  readonly key: QuotaLimitKey;
  readonly category: UsageCategory | null;
  readonly label: string;
  readonly unit: string;
  readonly value: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly scope: 'plan' | 'owner' | 'project';
  readonly enforcement: LimitEnforcement;
  readonly note: string | null;
}

export interface UsageEntitlement {
  readonly planId: 'development' | 'paid';
  readonly label: string;
  readonly source: 'default' | 'operator';
  readonly developmentMode: boolean;
  readonly managedProviders: boolean;
  readonly byokProviders: boolean;
  readonly note: string;
}

export interface UsageSnapshot {
  readonly durable: boolean;
  readonly developmentMode: boolean;
  readonly entitlement: UsageEntitlement;
  readonly period: { readonly from: string; readonly to: string };
  readonly projectId: string | null;
  readonly counters: Readonly<Record<UsageCategory, number>>;
  readonly gauges: { readonly fileBytes: number | null; readonly openJobs: number | null };
  readonly cost: {
    readonly infrastructureUsd: number;
    readonly managedProviderUsd: number;
    readonly byokProviderUsd: number;
    readonly unpricedCalls: number;
  };
  readonly limits: readonly UsageLimitView[];
  readonly records: number;
}

export interface UsageRecordView {
  readonly id: string;
  readonly category: UsageCategory;
  readonly operation: string;
  readonly resource: string;
  readonly quantity: number;
  readonly unit: string;
  readonly occurredAt: string;
  readonly projectId: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly allowance: string | null;
  readonly costBearer: string | null;
  readonly costUsd: number | null;
  readonly source: string;
}

export interface UsageCapabilities {
  readonly durable: boolean;
  readonly developmentMode: boolean;
  readonly enforcement: 'enforced' | 'partial';
  readonly notes: readonly string[];
  readonly categories: readonly {
    readonly category: UsageCategory;
    readonly status: string;
    readonly note: string;
    readonly limit: QuotaLimitKey | null;
  }[];
}

const query = (projectId?: string | null): string =>
  projectId === undefined || projectId === null || projectId === ''
    ? ''
    : `?projectId=${encodeURIComponent(projectId)}`;

export async function getUsageSnapshot(projectId?: string | null): Promise<UsageSnapshot> {
  return apiRequest<UsageSnapshot>(`/api/usage${query(projectId)}`);
}

export async function getUsageLimits(
  projectId?: string | null,
): Promise<readonly UsageLimitView[]> {
  const body = await apiRequest<{ limits: readonly UsageLimitView[] }>(
    `/api/usage/limits${query(projectId)}`,
  );
  return body.limits;
}

export async function listUsageRecords(
  projectId?: string | null,
  limit = 25,
): Promise<readonly UsageRecordView[]> {
  const suffix = projectId
    ? `?projectId=${encodeURIComponent(projectId)}&limit=${limit}`
    : `?limit=${limit}`;
  const body = await apiRequest<{ records: readonly UsageRecordView[] }>(
    `/api/usage/records${suffix}`,
  );
  return body.records;
}

export async function getUsageCapabilities(): Promise<UsageCapabilities> {
  return apiRequest<UsageCapabilities>('/api/usage/capabilities');
}
