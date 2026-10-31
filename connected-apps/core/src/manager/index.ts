/** ConnectedAppManager: the single authorization point for every connected-app
 *  operation. Providers never decide access; the manager checks the connection,
 *  the granted scope, the declared capability, the rate budget and the timeout
 *  before any provider is called, and attaches provenance to every result. */
import { ConnectedAppError, isConnectedAppError } from '../errors/index.js';
import { ConnectionStore, type CredentialVault } from '../connection/index.js';
import { assertNoSecretShape, bounded } from '../security/index.js';
import { ProviderRegistry } from '../registry/index.js';
import {
  DEFAULT_CONNECTED_APP_LIMITS,
  isConnectedProviderId,
  type AuditSink,
  type ConnectedAccount,
  type ConnectedAppLimits,
  type ConnectedProviderId,
  type ConnectedResource,
  type ConnectionHealth,
  type ProviderCapability,
  type ProviderRequestContext,
  type ResourceContent,
  type ResourcePage,
  type SourceProvenance,
} from '../types/index.js';
import type { ConnectedAppProvider } from '../provider/index.js';

export interface OwnerPrincipal {
  readonly ownerRef: string;
}

export interface ConnectInput {
  readonly grantedScopes: readonly string[];
  /** Authorization code or token obtained by the caller's flow. Never stored
   *  directly: providers exchange it and the manager keeps only a reference. */
  readonly credential?: string | null;
}

export interface ManagerOptions {
  readonly registry: ProviderRegistry;
  readonly vault: CredentialVault;
  readonly audit?: AuditSink;
  readonly limits?: Partial<ConnectedAppLimits>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

interface RateWindow {
  count: number;
  startedAt: number;
}

const TERMINAL_STATUSES = ['revoked', 'expired'] as const;

export class ConnectedAppManager {
  readonly #registry: ProviderRegistry;
  readonly #vault: CredentialVault;
  readonly #audit: AuditSink | undefined;
  readonly #limits: ConnectedAppLimits;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #store = new ConnectionStore();
  readonly #rate = new Map<string, RateWindow>();
  #sequence = 0;

  constructor(options: ManagerOptions) {
    this.#registry = options.registry;
    this.#vault = options.vault;
    this.#audit = options.audit;
    this.#limits = { ...DEFAULT_CONNECTED_APP_LIMITS, ...(options.limits ?? {}) };
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => `conn_${(this.#sequence += 1).toString(36)}`);
  }

  get limits(): ConnectedAppLimits {
    return this.#limits;
  }

  /** Providers the platform offers, with their declared scopes and honest
   *  live-versus-mock status. */
  catalog(): ReturnType<ProviderRegistry['descriptors']> {
    return this.#registry.descriptors();
  }

  async connect(
    principal: OwnerPrincipal,
    providerId: string,
    input: ConnectInput,
  ): Promise<ConnectedAccount> {
    if (!isConnectedProviderId(providerId))
      throw new ConnectedAppError('CONNECTED_PROVIDER_UNKNOWN', 'That provider is not available.');
    const provider = this.#registry.get(providerId);
    const declared = provider.descriptor.scopes.map((scope) => scope.id);
    if (input.grantedScopes.length === 0)
      throw new ConnectedAppError('CONNECTED_INVALID_REQUEST', 'At least one scope is required.');
    for (const scope of input.grantedScopes)
      if (!declared.includes(scope))
        throw new ConnectedAppError(
          'CONNECTED_INSUFFICIENT_SCOPE',
          'A requested scope is not offered by this provider.',
        );
    const ownerConnections = this.#store.list(principal.ownerRef);
    if (!ownerConnections.some((record) => record.account.providerId === providerId)) {
      if (ownerConnections.length >= this.#limits.maxConnectionsPerOwner)
        throw new ConnectedAppError(
          'CONNECTED_LIMIT_EXCEEDED',
          'This account has reached its connection limit.',
        );
    }
    const credential = input.credential ?? null;
    if (provider.descriptor.liveCapable && !credential)
      throw new ConnectedAppError(
        'CONNECTED_INVALID_REQUEST',
        'This provider needs an authorization credential before it can connect.',
      );
    const result = await this.#call(providerId, 'authenticate', () =>
      provider.authenticate({
        grantedScopes: input.grantedScopes,
        credential,
        context: this.#context(),
      }),
    );
    if (result.status !== 'connected')
      throw new ConnectedAppError(
        result.status === 'revoked' ? 'CONNECTED_REVOKED' : 'CONNECTED_EXPIRED',
        'The authorization was not accepted.',
      );
    const credentialRef = result.credentialRef;
    if (credentialRef !== null && credential !== null) this.#vault.put(credentialRef, credential);
    const account: ConnectedAccount = {
      connectionId: this.#newId(),
      providerId,
      providerName: provider.descriptor.name,
      liveCapable: provider.descriptor.liveCapable,
      status: 'connected',
      account: result.account,
      grantedScopes: [...new Set(input.grantedScopes)],
      capabilities: provider.descriptor.capabilities,
      connectedAt: this.#now().toISOString(),
      lastCheckedAt: this.#now().toISOString(),
    };
    this.#store.put(principal.ownerRef, { account, credentialRef });
    this.#auditEvent(
      'connected_app_connected',
      principal.ownerRef,
      providerId,
      account,
      null,
      null,
    );
    return { ...account };
  }

  async disconnect(principal: OwnerPrincipal, providerId: string): Promise<void> {
    const provider = this.#provider(providerId);
    const record = this.#store.get(principal.ownerRef, providerId as ConnectedProviderId);
    if (!record)
      throw new ConnectedAppError('CONNECTED_NOT_CONNECTED', 'That provider is not connected.');
    const credential = record.credentialRef ? this.#vault.get(record.credentialRef) : null;
    await this.#call(providerId, 'revoke', () => provider.revoke({ credential }));
    if (record.credentialRef) this.#vault.delete(record.credentialRef);
    this.#store.remove(principal.ownerRef, providerId as ConnectedProviderId);
    this.#rate.delete(`${principal.ownerRef}:${providerId}`);
    this.#auditEvent(
      'connected_app_disconnected',
      principal.ownerRef,
      providerId,
      record.account,
      null,
      null,
    );
  }

  listConnections(principal: OwnerPrincipal): readonly ConnectedAccount[] {
    return this.#store.list(principal.ownerRef).map((record) => ({ ...record.account }));
  }

  connection(principal: OwnerPrincipal, providerId: string): ConnectedAccount {
    const { record } = this.#requireConnection(principal, providerId);
    return { ...record.account };
  }

  async health(principal: OwnerPrincipal, providerId: string): Promise<ConnectionHealth> {
    const provider = this.#provider(providerId);
    const record = this.#store.get(principal.ownerRef, providerId as ConnectedProviderId);
    if (!record)
      return {
        providerId: providerId as ConnectedProviderId,
        status: 'not_connected',
        healthy: false,
        detail: 'This provider is not connected.',
        checkedAt: this.#now().toISOString(),
      };
    if (TERMINAL_STATUSES.includes(record.account.status as 'revoked' | 'expired'))
      return {
        providerId: providerId as ConnectedProviderId,
        status: record.account.status,
        healthy: false,
        detail:
          record.account.status === 'revoked'
            ? 'This connection was revoked and must be reconnected.'
            : 'This connection expired and must be reconnected.',
        checkedAt: this.#now().toISOString(),
      };
    try {
      const result = await this.#call(providerId, 'health', () =>
        provider.health({
          connection: record.account,
          credential: this.#credential(record.credentialRef),
          context: this.#context(),
        }),
      );
      return {
        providerId: providerId as ConnectedProviderId,
        status: 'connected',
        healthy: result.healthy,
        detail: bounded(result.detail, 300),
        checkedAt: this.#now().toISOString(),
      };
    } catch (error) {
      return {
        providerId: providerId as ConnectedProviderId,
        status: 'connected',
        healthy: false,
        detail: this.#describe(error),
        checkedAt: this.#now().toISOString(),
      };
    }
  }

  async resources(
    principal: OwnerPrincipal,
    providerId: string,
    options: { cursor?: string | null; query?: string | null } = {},
  ): Promise<ResourcePage> {
    const { record, provider } = this.#authorize(principal, providerId, 'list_resources');
    const query = options.query ? bounded(options.query.trim(), 200) : null;
    if (query !== null) assertNoSecretShape(query, 'the query');
    const page = await this.#call(providerId, 'listResources', () =>
      provider.listResources!({
        connection: record.account,
        credential: this.#credential(record.credentialRef),
        context: this.#context(),
        cursor: this.#cursor(options.cursor),
        query,
        maxItems: this.#limits.maxListItems,
      }),
    );
    return this.#provenancePage(record.account, page);
  }

  async search(
    principal: OwnerPrincipal,
    providerId: string,
    query: string,
    options: { cursor?: string | null } = {},
  ): Promise<ResourcePage> {
    const text = bounded((query ?? '').trim(), 200);
    if (text.length === 0)
      throw new ConnectedAppError('CONNECTED_INVALID_REQUEST', 'A search query is required.');
    assertNoSecretShape(text, 'the query');
    const { record, provider } = this.#authorize(principal, providerId, 'search_resources');
    const page = await this.#call(providerId, 'searchResources', () =>
      provider.searchResources!({
        connection: record.account,
        credential: this.#credential(record.credentialRef),
        context: this.#context(),
        query: text,
        cursor: this.#cursor(options.cursor),
        maxItems: this.#limits.maxListItems,
      }),
    );
    return this.#provenancePage(record.account, page);
  }

  async metadata(
    principal: OwnerPrincipal,
    providerId: string,
    resourceId: string,
  ): Promise<ConnectedResource> {
    const { record, provider } = this.#authorize(principal, providerId, 'resource_metadata');
    const resource = await this.#call(providerId, 'getResource', () =>
      provider.getResource!({
        connection: record.account,
        credential: this.#credential(record.credentialRef),
        context: this.#context(),
        resourceId: this.#resourceId(resourceId),
      }),
    );
    return this.#withProvenance(record.account, resource);
  }

  async content(
    principal: OwnerPrincipal,
    providerId: string,
    resourceId: string,
  ): Promise<ResourceContent> {
    const { record, provider } = this.#authorize(principal, providerId, 'resource_content');
    const content = await this.#call(providerId, 'getContent', () =>
      provider.getContent!({
        connection: record.account,
        credential: this.#credential(record.credentialRef),
        context: this.#context(),
        resourceId: this.#resourceId(resourceId),
        maxBytes: this.#limits.maxResourceBytes,
      }),
    );
    if (content.bytes.byteLength > this.#limits.maxResourceBytes)
      throw new ConnectedAppError(
        'CONNECTED_LIMIT_EXCEEDED',
        'That resource is larger than the supported limit.',
      );
    const provenance = this.#provenance(record.account, content.resource, this.#now());
    this.#auditEvent(
      'connected_app_content_read',
      principal.ownerRef,
      providerId,
      record.account,
      content.resource.resourceId,
      `${content.bytes.byteLength} bytes`,
    );
    return {
      ...content,
      resource: this.#withProvenance(record.account, content.resource),
      provenance,
      mimeType: bounded(content.mimeType, 200).toLowerCase(),
    };
  }

  /** Provenance plus a bounded text excerpt, for citing a source without
   *  handing a caller the whole document. */
  async evidence(
    principal: OwnerPrincipal,
    providerId: string,
    resourceId: string,
    quote?: string | null,
  ): Promise<{ provenance: SourceProvenance; excerpt: string; matched: boolean }> {
    const content = await this.content(principal, providerId, resourceId);
    if (content.encoding === 'binary')
      throw new ConnectedAppError(
        'CONNECTED_CONTENT_UNSUPPORTED',
        'That resource is binary and has no text to quote.',
      );
    const text = new TextDecoder().decode(content.bytes);
    const needle = (quote ?? '').trim().slice(0, 200);
    if (needle.length === 0)
      return {
        provenance: content.provenance,
        excerpt: bounded(text.replace(/\s+/g, ' ').trim(), 400),
        matched: false,
      };
    const at = text.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) return { provenance: content.provenance, excerpt: '', matched: false };
    const start = Math.max(0, at - 120);
    return {
      provenance: content.provenance,
      excerpt: bounded(
        text
          .slice(start, at + needle.length + 120)
          .replace(/\s+/g, ' ')
          .trim(),
        400,
      ),
      matched: true,
    };
  }

  // ---------------------------------------------------------------- internals

  #provider(providerId: string): ConnectedAppProvider {
    if (!isConnectedProviderId(providerId))
      throw new ConnectedAppError('CONNECTED_PROVIDER_UNKNOWN', 'That provider is not available.');
    return this.#registry.get(providerId);
  }

  #requireConnection(principal: OwnerPrincipal, providerId: string) {
    const provider = this.#provider(providerId);
    const record = this.#store.get(principal.ownerRef, providerId as ConnectedProviderId);
    if (!record)
      throw new ConnectedAppError(
        'CONNECTED_NOT_CONNECTED',
        'That provider is not connected for this account.',
      );
    if (record.account.status === 'revoked')
      throw new ConnectedAppError(
        'CONNECTED_REVOKED',
        'This connection was revoked and must be reconnected.',
      );
    if (record.account.status === 'expired')
      throw new ConnectedAppError(
        'CONNECTED_EXPIRED',
        'This connection expired and must be reconnected.',
      );
    return { provider, record };
  }

  #authorize(
    principal: OwnerPrincipal,
    providerId: string,
    capability: ProviderCapability,
  ): {
    record: { account: ConnectedAccount; credentialRef: string | null };
    provider: ConnectedAppProvider;
  } {
    const { provider, record } = this.#requireConnection(principal, providerId);
    if (!provider.descriptor.capabilities.includes(capability))
      throw new ConnectedAppError(
        'CONNECTED_CAPABILITY_UNSUPPORTED',
        'This provider does not support that operation.',
      );
    const scope = provider.descriptor.capabilityScopes[capability];
    if (scope && !record.account.grantedScopes.includes(scope))
      throw new ConnectedAppError(
        'CONNECTED_INSUFFICIENT_SCOPE',
        'This connection was not granted the permission that operation needs.',
      );
    this.#spend(principal.ownerRef, providerId);
    return { provider, record };
  }

  #spend(ownerRef: string, providerId: string): void {
    const key = `${ownerRef}:${providerId}`;
    const now = this.#now().getTime();
    const window = this.#rate.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      this.#rate.set(key, { count: 1, startedAt: now });
      return;
    }
    if (window.count >= this.#limits.maxOperationsPerMinute)
      throw new ConnectedAppError(
        'CONNECTED_RATE_LIMITED',
        'Too many requests to this provider. Try again shortly.',
      );
    window.count += 1;
  }

  async #call<T>(providerId: string, operation: string, run: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ConnectedAppError('CONNECTED_TIMEOUT', 'The provider took too long.')),
        this.#limits.requestTimeoutMs,
      );
    });
    try {
      return await Promise.race([run(), timeout]);
    } catch (error) {
      if (isConnectedAppError(error)) throw error;
      const normalized = this.#normalize(error);
      if (process.env.CONNECTED_APP_DEBUG === '1')
        console.error(`connected-app ${providerId}.${operation}:`, this.#describe(normalized));
      throw normalized;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #normalize(error: unknown): ConnectedAppError {
    const message = error instanceof Error ? error.message : '';
    if (/abort/i.test(message))
      return new ConnectedAppError('CONNECTED_TIMEOUT', 'The provider took too long.');
    return new ConnectedAppError(
      'CONNECTED_PROVIDER_ERROR',
      'The provider could not complete that request.',
    );
  }

  #context(): ProviderRequestContext {
    return {
      signal: new AbortController().signal,
      maxBytes: this.#limits.maxResourceBytes,
      maxItems: this.#limits.maxListItems,
      now: this.#now,
    };
  }

  #credential(ref: string | null): string | null {
    return ref ? this.#vault.get(ref) : null;
  }

  #cursor(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const cursor = String(value).trim();
    if (cursor.length === 0) return null;
    if (cursor.length > 512)
      throw new ConnectedAppError('CONNECTED_INVALID_REQUEST', 'That page cursor is invalid.');
    return cursor;
  }

  #resourceId(value: string): string {
    const id = String(value ?? '').trim();
    if (!id || id.length > 512)
      throw new ConnectedAppError('CONNECTED_INVALID_REQUEST', 'A valid resource id is required.');
    assertNoSecretShape(id, 'the resource id');
    return id;
  }

  #describe(error: unknown): string {
    if (isConnectedAppError(error)) return error.message;
    return 'Unexpected provider failure.';
  }

  #provenance(account: ConnectedAccount, resource: ConnectedResource, at: Date): SourceProvenance {
    return {
      providerId: account.providerId,
      providerName: account.providerName,
      accountId: account.account.accountId,
      connectionId: account.connectionId,
      resourceId: resource.resourceId,
      resourceName: resource.name,
      sourceUrl: resource.url,
      retrievedAt: at.toISOString(),
      revision: resource.revision,
    };
  }

  #withProvenance(account: ConnectedAccount, resource: ConnectedResource): ConnectedResource {
    return {
      ...resource,
      name: bounded(resource.name, 300),
      path: resource.path === null ? null : bounded(resource.path, 600),
      provenance: this.#provenance(account, resource, this.#now()),
    };
  }

  #provenancePage(account: ConnectedAccount, page: ResourcePage): ResourcePage {
    return {
      resources: page.resources
        .slice(0, this.#limits.maxListItems)
        .map((resource) => this.#withProvenance(account, resource)),
      nextCursor: page.nextCursor === null ? null : bounded(page.nextCursor, 512),
      truncated: page.truncated,
      rateLimit: page.rateLimit,
    };
  }

  #auditEvent(
    type: string,
    ownerRef: string,
    providerId: string,
    account: ConnectedAccount | null,
    resourceId: string | null,
    detail: string | null,
  ): void {
    this.#audit?.record({
      type,
      ownerRef,
      providerId,
      connectionId: account?.connectionId ?? null,
      resourceId,
      detail,
    });
  }
}
