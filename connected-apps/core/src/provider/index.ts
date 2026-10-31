/** The provider boundary. Provider-specific logic lives behind this interface
 *  so the agent layer only ever speaks in resources, provenance and typed
 *  errors. Every operation is read-only and receives the manager's bounded
 *  request context. */
import type {
  ConnectionStatus,
  ConnectedAccount,
  ConnectedProviderId,
  ConnectedResource,
  ProviderAccount,
  ProviderAuthResult,
  ProviderCapability,
  ProviderDescriptor,
  ProviderRequestContext,
  RateLimitInfo,
  ResourceContent,
  ResourcePage,
} from '../types/index.js';

export interface ProviderOperationInput {
  readonly connection: ConnectedAccount;
  /** Resolved credential for this operation. Never logged, never stored. */
  readonly credential: string | null;
  readonly context: ProviderRequestContext;
}

export interface ListResourcesInput extends ProviderOperationInput {
  readonly cursor: string | null;
  readonly query: string | null;
  readonly maxItems: number;
}

export interface SearchResourcesInput extends ProviderOperationInput {
  readonly query: string;
  readonly cursor: string | null;
  readonly maxItems: number;
}

export interface ResourceRefInput extends ProviderOperationInput {
  readonly resourceId: string;
}

export interface ContentInput extends ProviderOperationInput {
  readonly resourceId: string;
  readonly maxBytes: number;
}

export interface ProviderHealth {
  readonly healthy: boolean;
  readonly detail: string;
  readonly status: ConnectionStatus | 'not_connected';
  readonly rateLimit: RateLimitInfo | null;
}

export interface ConnectedAppProvider {
  readonly descriptor: ProviderDescriptor;
  /** Exchanges an authorization result for an account identity. The provider
   *  never receives the browser; it validates scopes and returns metadata. */
  authenticate(input: {
    readonly grantedScopes: readonly string[];
    readonly credential: string | null;
    readonly context: ProviderRequestContext;
  }): Promise<ProviderAuthResult>;
  revoke(input: { readonly credential: string | null }): Promise<void>;
  health(input: ProviderOperationInput): Promise<ProviderHealth>;
  listResources?(input: ListResourcesInput): Promise<ResourcePage>;
  searchResources?(input: SearchResourcesInput): Promise<ResourcePage>;
  getResource?(input: ResourceRefInput): Promise<ConnectedResource>;
  getContent?(input: ContentInput): Promise<ResourceContent>;
}

/** What a provider must be able to do to declare a capability. */
export const CAPABILITY_METHODS: Readonly<Record<ProviderCapability, string>> = {
  list_resources: 'listResources',
  search_resources: 'searchResources',
  resource_metadata: 'getResource',
  resource_content: 'getContent',
  repository_tree: 'listResources',
  repository_search: 'searchResources',
};

export function providerImplements(
  provider: ConnectedAppProvider,
  capability: ProviderCapability,
): boolean {
  const method = CAPABILITY_METHODS[capability] as keyof ConnectedAppProvider;
  return typeof provider[method] === 'function';
}

export function descriptorFor(
  id: ConnectedProviderId,
  value: ProviderDescriptor,
): ProviderDescriptor {
  if (value.id !== id) throw new Error('Provider descriptor id does not match its registry key.');
  if (value.capabilities.length === 0) throw new Error('A provider must declare a capability.');
  if (value.scopes.length === 0) throw new Error('A provider must declare at least one scope.');
  return {
    ...value,
    capabilities: [...new Set(value.capabilities)],
    scopes: [...value.scopes],
  };
}

export function accountOf(account: ProviderAccount): ProviderAccount {
  return {
    accountId: account.accountId.slice(0, 200),
    displayName: account.displayName.slice(0, 200),
    email: account.email === null ? null : account.email.slice(0, 320),
  };
}
