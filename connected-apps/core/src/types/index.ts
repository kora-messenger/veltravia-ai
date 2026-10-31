/** Connected-app domain types. Provider-neutral: nothing here names a vendor
 *  API, a token, or a browser concern. Results are always read-only. */

export const CONNECTED_PROVIDER_IDS = ['github', 'google_drive', 'notion'] as const;
export type ConnectedProviderId = (typeof CONNECTED_PROVIDER_IDS)[number];

export function isConnectedProviderId(value: unknown): value is ConnectedProviderId {
  return typeof value === 'string' && (CONNECTED_PROVIDER_IDS as readonly string[]).includes(value);
}

/** What a provider can do. A closed union: a provider cannot silently gain an
 *  ability it did not declare, and the manager refuses undeclared operations. */
export const PROVIDER_CAPABILITIES = [
  'list_resources',
  'search_resources',
  'resource_metadata',
  'resource_content',
  'repository_tree',
  'repository_search',
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const RESOURCE_KINDS = [
  'file',
  'document',
  'page',
  'database',
  'directory',
  'repository',
  'issue',
  'pull_request',
  'commit',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** A scope a connection may be granted. Declared by the provider, granted
 *  explicitly, and checked on every operation. */
export interface ConnectedScope {
  readonly id: string;
  readonly description: string;
  readonly risk: 'low' | 'medium' | 'high';
}

export interface ProviderDescriptor {
  readonly id: ConnectedProviderId;
  readonly name: string;
  readonly description: string;
  /** True only when a real vendor API is implemented for this provider. */
  readonly liveCapable: boolean;
  readonly capabilities: readonly ProviderCapability[];
  readonly scopes: readonly ConnectedScope[];
  /** The scope that must be granted before a capability may be used. */
  readonly capabilityScopes: Readonly<Partial<Record<ProviderCapability, string>>>;
}

export interface ProviderAccount {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string | null;
}

export const CONNECTION_STATUSES = ['connected', 'expired', 'revoked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** The safe, browser-facing view of a connection. It structurally cannot
 *  carry a credential: there is no field for one. */
export interface ConnectedAccount {
  readonly connectionId: string;
  readonly providerId: ConnectedProviderId;
  readonly providerName: string;
  readonly liveCapable: boolean;
  readonly status: ConnectionStatus;
  readonly account: ProviderAccount;
  readonly grantedScopes: readonly string[];
  readonly capabilities: readonly ProviderCapability[];
  readonly connectedAt: string;
  readonly lastCheckedAt: string | null;
}

export interface ConnectionHealth {
  readonly providerId: ConnectedProviderId;
  readonly status: ConnectionStatus | 'not_connected';
  readonly healthy: boolean;
  readonly detail: string;
  readonly checkedAt: string;
}

/** Where a resource came from. Always attached, never inferred later. */
export interface SourceProvenance {
  readonly providerId: ConnectedProviderId;
  readonly providerName: string;
  readonly accountId: string;
  readonly connectionId: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly sourceUrl: string | null;
  /** ISO timestamp of the moment the content was fetched. */
  readonly retrievedAt: string;
  /** Provider-reported revision/version/etag when one exists. */
  readonly revision: string | null;
}

export interface ConnectedResource {
  readonly providerId: ConnectedProviderId;
  readonly resourceId: string;
  readonly kind: ResourceKind;
  readonly name: string;
  readonly path: string | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly modifiedAt: string | null;
  readonly revision: string | null;
  readonly url: string | null;
  readonly provenance: SourceProvenance;
}

export interface RateLimitInfo {
  /** Calls remaining in the provider's window, when the provider reports it. */
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly resetAt: string | null;
}

export interface ResourcePage {
  readonly resources: readonly ConnectedResource[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly rateLimit: RateLimitInfo | null;
}

export interface ResourceContent {
  readonly resource: ConnectedResource;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly encoding: 'text' | 'binary';
  readonly provenance: SourceProvenance;
  /** True when the provider served a cached copy. Age is always reported. */
  readonly fromCache: boolean;
  readonly ageSeconds: number | null;
}

/** Request context handed to every provider operation: the manager owns
 *  limits and cancellation, so providers cannot opt out of them. */
export interface ProviderRequestContext {
  readonly signal: AbortSignal;
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly now: () => Date;
}

export interface ProviderAuthResult {
  readonly status: ConnectionStatus;
  readonly account: ProviderAccount;
  /** Opaque reference to a stored secret. NEVER a secret value. */
  readonly credentialRef: string | null;
}

export interface ConnectedAppLimits {
  readonly maxResourceBytes: number;
  readonly maxListItems: number;
  readonly requestTimeoutMs: number;
  readonly maxOperationsPerMinute: number;
  readonly maxConnectionsPerOwner: number;
}

export const DEFAULT_CONNECTED_APP_LIMITS: ConnectedAppLimits = {
  maxResourceBytes: 8 * 1024 * 1024,
  maxListItems: 100,
  requestTimeoutMs: 8000,
  maxOperationsPerMinute: 120,
  maxConnectionsPerOwner: 12,
};

export interface AuditSink {
  record(event: {
    readonly type: string;
    readonly ownerRef: string;
    readonly providerId: string;
    readonly connectionId: string | null;
    readonly resourceId: string | null;
    readonly detail: string | null;
  }): void;
}

/** A resource plus the parsed view produced by Document Intelligence. */
export interface AnalyzedResource {
  readonly provenance: SourceProvenance;
  readonly format: string;
  readonly byteSize: number;
  readonly elementCount: number;
  readonly tableCount: number;
  readonly headings: readonly string[];
  readonly textPreview: string;
  readonly truncated: boolean;
  readonly fromCache: boolean;
  readonly ageSeconds: number | null;
}
