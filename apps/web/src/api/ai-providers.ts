import { apiRequest } from './client';

const base = '/api/ai/providers';

/**
 * Typed client for the Step 26 provider gateway. The browser NEVER sees a
 * credential: the API returns a masked hint only, and keys travel one way
 * (browser → server) on create/replace.
 */

export interface CatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly modelCapabilities: readonly string[];
  readonly allowsCustomBaseUrl: boolean;
  readonly supportsDiscovery: boolean;
  readonly docsUrl: string | null;
  readonly authFormat: string;
}

export interface ProviderModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly available: boolean;
  readonly source: 'discovery' | 'manual';
}

export interface ProviderConnection {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
  readonly modelIds: readonly string[];
  readonly defaultModelId: string | null;
  readonly credentialHint: string;
  readonly baseUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastValidatedAt: string | null;
  readonly lastErrorCategory: string | null;
  readonly models: readonly ProviderModel[];
  readonly isDefault: boolean;
  readonly healthy: boolean | null;
}

export interface ProviderPreferences {
  readonly defaultConnectionId: string | null;
  readonly defaultModelId: string | null;
  readonly projects: Readonly<Record<string, { connectionId: string; modelId: string }>>;
}

export interface ProvidersOverview {
  readonly ready: boolean;
  readonly blockedReason: string | null;
  readonly encryption: { algorithm: string | null; keyVersions: readonly number[] };
  readonly providers: readonly ProviderConnection[];
  readonly preferences: ProviderPreferences;
  readonly catalog: readonly CatalogEntry[];
}

export interface UsageRecordView {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedAt: string;
  readonly status: 'success' | 'failure';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly latencyMs: number;
  readonly errorCategory?: string;
  readonly live: boolean;
}

export interface CreateConnectionInput {
  readonly providerId: string;
  readonly apiKey: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly modelIds?: readonly string[];
  readonly authFormat?: 'bearer' | 'x-api-key' | 'query-key';
  readonly skipDiscovery?: boolean;
}

export const getProviders = () => apiRequest<ProvidersOverview>(base);

export const createConnection = (input: CreateConnectionInput) =>
  apiRequest<{ connection: ProviderConnection }>(`${base}/connections`, {
    method: 'POST',
    body: input,
  });

export const validateConnection = (id: string) =>
  apiRequest<{ valid: boolean; message: string }>(
    `${base}/connections/${encodeURIComponent(id)}/validate`,
    { method: 'POST', body: {} },
  );

export const listModels = (id: string, refresh = false) =>
  apiRequest<{ models: readonly ProviderModel[] }>(
    `${base}/connections/${encodeURIComponent(id)}/models${refresh ? '?refresh=true' : ''}`,
  );

export const updateConnection = (
  id: string,
  patch: {
    displayName?: string;
    defaultModelId?: string | null;
    modelIds?: readonly string[];
    status?: 'active' | 'disabled';
  },
) =>
  apiRequest<{ connection: ProviderConnection }>(`${base}/connections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });

export const replaceCredential = (id: string, apiKey: string) =>
  apiRequest<{ connection: ProviderConnection }>(
    `${base}/connections/${encodeURIComponent(id)}/credential`,
    { method: 'POST', body: { apiKey } },
  );

export const deleteConnection = (id: string) =>
  apiRequest<void>(`${base}/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const savePreferences = (input: {
  defaultConnectionId?: string | null;
  defaultModelId?: string | null;
}) => apiRequest<ProviderPreferences>(`${base}/preferences`, { method: 'PUT', body: input });

export const getUsage = (limit = 20) =>
  apiRequest<{ usage: readonly UsageRecordView[]; costAvailable: boolean }>(
    `${base}/usage?limit=${limit}`,
  );
