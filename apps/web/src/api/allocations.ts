import { apiRequest } from './client';

/**
 * Typed client for workspace credit allocation and the account agent (Step 62).
 *
 * Two lanes, one file, because on screen they answer the same question: what has
 * this workspace set aside, and what has the assistant done with it. Neither
 * client can move money: an allocation is a ceiling over the workspace wallet,
 * and every number here comes from the server.
 */

export type CreditCategory = 'ai_tokens' | 'integration_credits';
export type AllocationTargetKind = 'member' | 'project' | 'agent' | 'environment';
export type AllocationPolicyName =
  'manual' | 'equal' | 'project' | 'member' | 'priority' | 'restricted' | 'temporary' | 'automatic';

export interface AllocationPoolView {
  readonly set: boolean;
  readonly total: number;
  readonly allocated: number;
  readonly available: number;
  readonly note: string;
}

export interface AllocationView {
  readonly id: string;
  readonly workspaceId: string;
  readonly category: CreditCategory;
  readonly targetKind: AllocationTargetKind;
  readonly targetRef: string;
  readonly allocated: number;
  readonly reserved: number;
  readonly consumed: number;
  /** Credit this allocation can still promise, which the server computes. */
  readonly available: number;
  readonly limit: number | null;
  readonly priority: number;
  readonly policy: AllocationPolicyName;
  readonly state: 'active' | 'revoked' | 'expired';
  readonly allowedOperations: readonly string[];
  readonly expiresAt: string | null;
  readonly version: number;
}

export interface AllocationCategorySummary {
  readonly category: CreditCategory;
  readonly pool: AllocationPoolView;
  readonly totals: {
    readonly allocated: number;
    readonly reserved: number;
    readonly consumed: number;
    readonly available: number;
  };
  readonly allocations: readonly AllocationView[];
}

export interface AllocationSummary {
  readonly workspaceId: string;
  readonly categories: readonly AllocationCategorySummary[];
  readonly note: string;
}

export interface AllocationEventView {
  readonly id: string;
  readonly kind: string;
  readonly allocationId: string | null;
  readonly category: CreditCategory;
  readonly amount: number;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

export interface AllocationCapabilities {
  readonly durable: boolean;
  readonly categories: readonly CreditCategory[];
  readonly targets: readonly AllocationTargetKind[];
  readonly policies: readonly AllocationPolicyName[];
  readonly note: string;
}

export interface AccountActivityEntry {
  readonly id: string;
  readonly tool: string;
  readonly status: string;
  readonly resultSummary: string;
  readonly args: Record<string, unknown>;
  readonly occurredAt: string;
}

export interface AccountCatalogTool {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly risk: number;
  readonly mutates: boolean;
  readonly availability: { readonly available: boolean; readonly reason?: string };
}

export function getAllocations(workspaceId: string): Promise<AllocationSummary> {
  return apiRequest<AllocationSummary>(
    `/api/allocations?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
}

export function getAllocationHistory(
  workspaceId: string,
  limit = 20,
): Promise<{ events: readonly AllocationEventView[] }> {
  return apiRequest<{ events: readonly AllocationEventView[] }>(
    `/api/allocations/history?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`,
  );
}

export function getAllocationCapabilities(): Promise<AllocationCapabilities> {
  return apiRequest<AllocationCapabilities>('/api/allocations/capabilities');
}

export function setAllocationPool(input: {
  workspaceId: string;
  category: CreditCategory;
  total: number;
}): Promise<{ pool: AllocationPoolView }> {
  return apiRequest<{ pool: AllocationPoolView }>('/api/allocations/pool', {
    method: 'PUT',
    body: { ...input, reason: 'Workspace pool set from the allocation panel' },
  });
}

export function createAllocation(input: {
  workspaceId: string;
  category: CreditCategory;
  targetKind: AllocationTargetKind;
  targetRef: string;
  amount: number;
}): Promise<{ allocation: AllocationView }> {
  return apiRequest<{ allocation: AllocationView }>('/api/allocations', {
    method: 'POST',
    body: { ...input, reason: 'Allocation created from the allocation panel' },
  });
}

export function adjustAllocation(input: {
  allocationId: string;
  action: 'increase' | 'reduce' | 'reclaim' | 'revoke';
  amount?: number;
}): Promise<{ allocation: AllocationView }> {
  const { allocationId, action, amount } = input;
  return apiRequest<{ allocation: AllocationView }>(
    `/api/allocations/${encodeURIComponent(allocationId)}/${action}`,
    { method: 'POST', body: amount === undefined ? {} : { amount } },
  );
}

export function getAccountActivity(
  limit = 15,
): Promise<{ entries: readonly AccountActivityEntry[] }> {
  return apiRequest<{ entries: readonly AccountActivityEntry[] }>(
    `/api/account/activity?limit=${limit}`,
  );
}

export function getAccountCatalog(): Promise<{ tools: readonly AccountCatalogTool[] }> {
  return apiRequest<{ tools: readonly AccountCatalogTool[] }>('/api/account/catalog');
}
