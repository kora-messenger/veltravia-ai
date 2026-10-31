import { apiRequest } from './client';

const base = '/api/connections';
const providerPath = (providerId: string) => `${base}/${encodeURIComponent(providerId)}`;
const resourcePath = (providerId: string, resourceId: string) =>
  `${providerPath(providerId)}/resources/${encodeURIComponent(resourceId)}`;

export interface ProviderScope {
  readonly id: string;
  readonly description: string;
  readonly risk: 'low' | 'medium' | 'high';
}

export interface ProviderCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly liveCapable: boolean;
  readonly mode: 'live' | 'mock';
  readonly capabilities: readonly string[];
  readonly scopes: readonly ProviderScope[];
  readonly connected: boolean;
}

export interface ConnectedAccountView {
  readonly providerId: string;
  readonly providerName: string;
  readonly status: 'connected' | 'expired' | 'revoked';
  readonly account: { accountId: string; displayName: string; email: string | null };
  readonly grantedScopes: readonly string[];
  readonly capabilities: readonly string[];
  readonly connectedAt: string;
  readonly lastCheckedAt: string | null;
  readonly liveCapable: boolean;
}

export interface ConnectionsOverview {
  readonly providers: readonly ProviderCard[];
  readonly connections: readonly ConnectedAccountView[];
  readonly githubAllowedRepositories: readonly string[];
}

export interface Provenance {
  readonly providerId: string;
  readonly providerName: string;
  readonly accountId: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly sourceUrl: string | null;
  readonly retrievedAt: string;
  readonly revision: string | null;
}

export interface ConnectedResourceView {
  readonly providerId: string;
  readonly resourceId: string;
  readonly kind: string;
  readonly name: string;
  readonly path: string | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly modifiedAt: string | null;
  readonly revision: string | null;
  readonly url: string | null;
  readonly provenance: Provenance;
}

export interface ResourcePage {
  readonly resources: readonly ConnectedResourceView[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface ConnectionHealth {
  readonly providerId: string;
  readonly status: string;
  readonly healthy: boolean;
  readonly detail: string;
  readonly checkedAt: string;
}

export interface ResourceContent {
  readonly text: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly provenance: Provenance;
  readonly fromCache: boolean;
  readonly ageSeconds: number | null;
  readonly trustTag: string;
}

export interface ResourceAnalysis {
  readonly provenance: Provenance;
  readonly format: string;
  readonly byteSize: number;
  readonly elementCount: number;
  readonly tableCount: number;
  readonly headings: readonly string[];
  readonly textPreview: string;
  readonly truncated: boolean;
}

export interface ConnectionSession {
  readonly providerId: string;
  readonly mode: 'live' | 'mock';
  readonly authorization: { readonly kind: string; readonly reason: string };
  readonly scopes: readonly ProviderScope[];
}

export function getConnections(): Promise<ConnectionsOverview> {
  return apiRequest<ConnectionsOverview>(base);
}

export function getConnectionHealth(providerId: string): Promise<ConnectionHealth> {
  return apiRequest<ConnectionHealth>(`${providerPath(providerId)}/health`);
}

export function createSession(providerId: string): Promise<ConnectionSession> {
  return apiRequest<ConnectionSession>(`${providerPath(providerId)}/session`, {
    method: 'POST',
    body: {},
  });
}

export function completeConnection(
  providerId: string,
  scopes: readonly string[],
  credential?: string,
): Promise<{ connection: ConnectedAccountView }> {
  return apiRequest<{ connection: ConnectedAccountView }>(`${providerPath(providerId)}/complete`, {
    method: 'POST',
    body: credential ? { scopes, credential } : { scopes },
  });
}

export function disconnect(providerId: string): Promise<{ disconnected: boolean }> {
  return apiRequest<{ disconnected: boolean }>(providerPath(providerId), { method: 'DELETE' });
}

export function listResources(
  providerId: string,
  cursor?: string | null,
  query?: string,
): Promise<ResourcePage> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (query) params.set('q', query);
  const suffix = params.toString();
  return apiRequest<ResourcePage>(
    `${providerPath(providerId)}/resources${suffix ? `?${suffix}` : ''}`,
  );
}

export function searchResources(
  providerId: string,
  query: string,
  cursor?: string | null,
): Promise<ResourcePage> {
  const params = new URLSearchParams({ q: query });
  if (cursor) params.set('cursor', cursor);
  return apiRequest<ResourcePage>(`${providerPath(providerId)}/search?${params.toString()}`);
}

export function getContent(providerId: string, resourceId: string): Promise<ResourceContent> {
  return apiRequest<ResourceContent>(`${resourcePath(providerId, resourceId)}/content`);
}

export function getAnalysis(providerId: string, resourceId: string): Promise<ResourceAnalysis> {
  return apiRequest<ResourceAnalysis>(`${resourcePath(providerId, resourceId)}/analysis`);
}
