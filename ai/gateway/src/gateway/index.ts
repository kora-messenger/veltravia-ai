import { createHash, randomUUID } from 'node:crypto';

import type {
  AICapability,
  AIModelInfo,
  AIProvider,
  AIRequest,
  AIResponse,
} from '@veltravia/ai-core';
import { AICore, AIProviderError, ModelRegistry } from '@veltravia/ai-core';

import { GatewayError, errorCategoryOf, isGatewayError } from '../errors/index.js';
import {
  type ConnectionKey,
  findKey,
  keyView,
  markKeyCooling,
  markKeyHealthy,
  markKeyInvalid,
  markKeyUsed,
  replaceKey,
  selectKeyOrder,
  usableKeys,
} from './keypool.js';
import type { CredentialVault } from '../vault/index.js';
import { bounded, credentialHint, looksSecretShaped } from '../security/index.js';
import { assertSafeEndpoint } from '../ssrf/index.js';
import type { ConnectionStore, PreferenceStore } from '../store/index.js';
import { ModelPricingTable } from '../providers/pricing.js';
import type { UsageStore } from '../usage/index.js';
import { newUsageRecordId } from '../usage/index.js';
import { RateLimiter, type RateLimitAction } from '../ratelimit/index.js';
import { ProviderAdapterRegistry } from '../providers/registry.js';
import { catalogView, type ProviderCatalogEntry } from '../providers/catalog.js';
import type {
  AdapterContext,
  AdapterResult,
  CredentialValidationResult,
} from '../providers/adapter.js';
import type { ProviderTransport } from '../providers/transport.js';
import type {
  ConnectionView,
  CostSource,
  GatewayModel,
  GatewayStreamChunk,
  ProjectPreference,
  ProviderConnection,
  ProviderPreferences,
  ResolvedRoute,
  RouteSelector,
  UsageRecord,
  UsageSource,
} from '../types/index.js';

/**
 * The AI provider gateway (Step 26).
 *
 * One owner-scoped entry point that every reasoning service goes through:
 * resolve the route (project preference, then the owner's default), decrypt the
 * credential for this request only, check the capability actually needed,
 * execute through the provider adapter, normalize the result and record usage
 * metadata.
 *
 * Three rules are enforced here rather than trusted to callers:
 *   - a connection is only usable by its owner;
 *   - nothing that leaves this class contains a credential;
 *   - a response is only reported as `live` when a real provider answered.
 */

export interface GatewayScope {
  readonly ownerRef: string;
  readonly projectId?: string;
}

export interface GatewayOptions {
  readonly vault: CredentialVault;
  readonly connections: ConnectionStore;
  readonly preferences: PreferenceStore;
  readonly usage: UsageStore;
  readonly transport: ProviderTransport;
  readonly registry?: ProviderAdapterRegistry;
  readonly limiter?: RateLimiter;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Tests only: allows plain-HTTP custom endpoints. */
  readonly allowInsecureEndpoints?: boolean;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly maxConnectionsPerOwner?: number;
  /** How many keys one connection may pool (default 8). */
  readonly maxKeysPerConnection?: number;
  readonly maxModelsPerConnection?: number;
  /**
   * The model-selection port (Step 28 router). When present the gateway NEVER
   * picks a model by itself: it asks once, uses exactly that answer, and
   * refuses when the selector refuses.
   */
  readonly selector?: RouteSelector;
  /**
   * How many model calls one owner may make per UTC day. Zero or absent means
   * no ceiling. The platform holds the provider keys, so the platform also holds
   * the budget: without this one person could spend the whole account.
   */
  readonly dailyRequestCeiling?: number;
  /** Operator-declared prices. Absent means no cost estimates are produced. */
  readonly pricing?: ModelPricingTable;
  /** Bounded retry policy for retryable provider failures. */
  readonly retry?: RetryPolicy;
  /** Shortest wait before retrying a 429 that stated no wait (default 5s). */
  readonly rateLimitFloorMs?: number;
  /** Injectable delay, so retry timing is testable without real waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries apply only to failures that are safe to repeat BEFORE any answer was
 * produced: rate limits, timeouts, 5xx and unreachable hosts. Auth errors,
 * invalid requests and unsupported capabilities are never retried.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  // Long enough to honour a provider's own retry hint (Gemini asks for 15-30s
  // on a 429), short enough that a run never appears hung.
  maxDelayMs: 20_000,
};

/** Shortest wait between retries of a rate-limited call, when none was stated. */
const DEFAULT_RATE_LIMIT_FLOOR_MS = 5_000;

/** A key the provider refused as unauthenticated never becomes usable again. */
function isAuthFailure(error: unknown): boolean {
  return isGatewayError(error) && error.code === 'GATEWAY_AUTH_FAILED';
}

function isRateLimit(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'GATEWAY_RATE_LIMITED';
}

/** The provider's own wait suggestion, when it gave one. */
function retryHintOf(error: unknown): number | null {
  const details = (error as { details?: Record<string, unknown> } | null)?.details;
  const hint = details?.retryAfterMs;
  if (typeof hint !== 'number' || !Number.isFinite(hint) || hint <= 0) return null;
  return hint;
}

const RETRYABLE_CODES = new Set([
  'GATEWAY_RATE_LIMITED',
  'GATEWAY_TIMEOUT',
  'GATEWAY_PROVIDER_UNAVAILABLE',
]);

function isRetryable(error: unknown): boolean {
  return isGatewayError(error) && RETRYABLE_CODES.has(error.code);
}

/**
 * A key that authenticates but cannot pay. It is not a rate limit: waiting will
 * not help until someone tops the account up, so it rests for an hour and the
 * pool moves on to a key that can actually serve the request.
 */
const OUT_OF_CREDIT_COOLDOWN_MS = 60 * 60 * 1000;

function isOutOfCredit(error: unknown): boolean {
  return isGatewayError(error) && error.code === 'GATEWAY_LIMIT_EXCEEDED';
}

export interface CreateConnectionInput {
  readonly providerId: string;
  readonly apiKey: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  /** Explicit model ids, used when discovery is unavailable or not run. */
  readonly modelIds?: readonly string[];
  readonly defaultModelId?: string;
  /** Custom endpoints only: override the declared auth format. */
  readonly authFormat?: 'bearer' | 'x-api-key' | 'query-key';
  /** Skip discovery and trust the supplied model ids. */
  readonly skipDiscovery?: boolean;
}

export interface UpdateConnectionInput {
  readonly displayName?: string;
  readonly modelIds?: readonly string[];
  readonly defaultModelId?: string | null;
  readonly baseUrl?: string;
  readonly status?: 'active' | 'disabled';
}

export interface GenerationRequest {
  readonly messages: AIRequest['messages'];
  readonly system?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly structuredOutput?: AIRequest['structuredOutput'];
  readonly requiredCapabilities?: readonly AICapability[];
  /** Explicit connection; otherwise the project/user preference decides. */
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly projectId?: string;
  /** Router task category. Required when the caller wants router selection. */
  readonly category?: string;
  /** Cancellation for streaming and long non-streamed calls. */
  readonly signal?: AbortSignal;
  /** Correlates every call that belongs to one run. */
  readonly runId?: string;
  /** Estimated prompt size, passed to the selector for window checks. */
  readonly estimatedInputTokens?: number;
}

export interface GenerationOutcome {
  readonly content: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly connectionId: string;
  readonly finishReason: AdapterResult['finishReason'];
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cachedInputTokens?: number | null;
  };
  /** True only when a real provider answered over the network. */
  readonly live: boolean;
  readonly latencyMs: number;
  readonly requestedAt: string;
  /** Router decision id, when the selector chose this model. */
  readonly decisionId?: string;
  readonly attempts: number;
}

export interface ConnectionListEntry {
  readonly connection: ConnectionView;
  readonly providerName: string;
  readonly models: readonly GatewayModel[];
  readonly isDefault: boolean;
  readonly healthy: boolean;
}

const MAX_NAME = 120;
const MAX_MODELS = 500;
const MAX_MODEL_ID = 200;
const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * A one-way, owner-scoped digest of a credential. Used ONLY to stop the same
 * key being connected twice; the hint alone is lossy (many keys end the same
 * way), and storing the secret to compare it is never an option.
 */
function credentialFingerprint(ownerRef: string, secret: string): string {
  return createHash('sha256').update(`${ownerRef}\u0000${secret}`).digest('hex').slice(0, 32);
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function requireOwner(scope: GatewayScope): string {
  if (!scope || typeof scope.ownerRef !== 'string' || scope.ownerRef.trim().length === 0) {
    throw new GatewayError('GATEWAY_INVALID_REQUEST', 'An owner reference is required.');
  }
  return scope.ownerRef.slice(0, 256);
}

/**
 * Picks the model a connection uses when the caller did not choose one.
 *
 * Providers list their newest preview/experimental models first, and those are
 * exactly the ones a live account may reject. Taking `modelIds[0]` therefore
 * turned "connected successfully" into a guaranteed failed first request (live
 * QA: Gemini's catalog starts with `antigravity-preview-*`). Preference order:
 * a general-purpose stable id, then any id without a preview/experimental/lab
 * marker, then the first entry as a last resort.
 */
const DEFAULT_MODEL_PREFERENCE: readonly RegExp[] = [
  /^(?:gemini-[\d.]+-flash|gpt-[\d.]+(?:-mini)?|claude-[a-z]+-[\d.]+|deepseek-[a-z\d.]+)$/i,
];
const UNSTABLE_MODEL_MARKER =
  /(preview|experimental|exp\b|alpha|beta|lab|test|deprecated|latest|-0\d{3,})/i;

/** Highest version number in an id, so 3.8 beats 2.5 rather than losing on order. */
function modelVersion(id: string): number {
  const versions = [...id.matchAll(/(\d+(?:\.\d+)*)/g)].map((match) => Number(match[1]));
  const usable = versions.filter((value) => Number.isFinite(value));
  return usable.length === 0 ? 0 : Math.max(...usable);
}

function pickDefaultModelId(
  modelIds: readonly string[],
  providerDefault?: string,
): string | undefined {
  if (modelIds.length === 0) return undefined;
  // A provider's declared model beats any heuristic: discovery lists retired
  // ids next to current ones, so "newest" can be a model the key cannot call.
  if (providerDefault !== undefined && modelIds.includes(providerDefault)) return providerDefault;
  const preferred = modelIds.filter((id) =>
    DEFAULT_MODEL_PREFERENCE.some((pattern) => pattern.test(id)),
  );
  const stable = modelIds.filter((id) => !UNSTABLE_MODEL_MARKER.test(id));
  // Rank: preferred-and-stable, then stable, then everything, each by highest
  // version. Providers list deprecated models alongside current ones (Gemini
  // still advertises 2.5 after retiring it for new accounts), so the newest
  // general-purpose id is the only sane guess.
  const rank = (id: string): number[] => {
    const preferredScore = DEFAULT_MODEL_PREFERENCE.some((pattern) => pattern.test(id)) ? 2 : 0;
    const stableScore = UNSTABLE_MODEL_MARKER.test(id) ? 0 : 1;
    return [preferredScore + stableScore, modelVersion(id)];
  };
  const pool = preferred.length > 0 ? [...preferred] : [...stable];
  const candidates = pool.length > 0 ? pool : [...modelIds];
  return candidates.sort((a, b) => {
    const [ra, va] = rank(a) as [number, number];
    const [rb, vb] = rank(b) as [number, number];
    return rb - ra || vb - va;
  })[0];
}

export class AIProviderGateway {
  private readonly vault: CredentialVault;
  private readonly connections: ConnectionStore;
  private readonly preferences: PreferenceStore;
  private readonly usage: UsageStore;
  private readonly transport: ProviderTransport;
  private readonly registry: ProviderAdapterRegistry;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly allowInsecureEndpoints: boolean;
  private readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  private readonly maxConnectionsPerOwner: number;
  private readonly maxKeysPerConnection: number;
  private readonly maxModelsPerConnection: number;
  private selector?: RouteSelector;
  private readonly pricing: ModelPricingTable;
  private readonly retry: RetryPolicy;
  private readonly rateLimitFloorMs: number;
  private readonly dailyRequestCeiling: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GatewayOptions) {
    this.vault = options.vault;
    this.connections = options.connections;
    this.preferences = options.preferences;
    this.usage = options.usage;
    this.transport = options.transport;
    this.registry = options.registry ?? new ProviderAdapterRegistry();
    this.limiter = options.limiter ?? new RateLimiter();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.allowInsecureEndpoints = options.allowInsecureEndpoints ?? false;
    if (options.resolveHost) this.resolveHost = options.resolveHost;
    this.maxConnectionsPerOwner = options.maxConnectionsPerOwner ?? 12;
    this.maxKeysPerConnection = options.maxKeysPerConnection ?? 8;
    this.maxModelsPerConnection = options.maxModelsPerConnection ?? MAX_MODELS;
    this.selector = options.selector;
    this.pricing = options.pricing ?? new ModelPricingTable();
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.rateLimitFloorMs = options.rateLimitFloorMs ?? DEFAULT_RATE_LIMIT_FLOOR_MS;
    this.dailyRequestCeiling = options.dailyRequestCeiling ?? 0;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Attaches the model router after construction.
   *
   * The router reads its connection facts FROM this gateway, so the two cannot
   * be built in one expression: the gateway is created first, then told who
   * decides. Until then it falls back to the owner's own preferences.
   */
  attachSelector(selector: RouteSelector): void {
    this.selector = selector;
  }

  /** Whether the vault can encrypt at all. The API reports this to the UI so a
   *  deployment without a key fails closed instead of appearing to work. */
  get encryptionReady(): true {
    return true;
  }

  catalog(): readonly ProviderCatalogEntry[] {
    return catalogView();
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  async createConnection(
    scope: GatewayScope,
    input: CreateConnectionInput,
  ): Promise<ConnectionView> {
    const ownerRef = requireOwner(scope);
    const definition = this.registry.definition(input.providerId);
    if (typeof input.apiKey !== 'string' || input.apiKey.trim().length === 0) {
      throw new GatewayError('GATEWAY_INVALID_REQUEST', 'An API key is required.');
    }
    const existing = await this.connections.listByOwner(ownerRef);
    if (existing.length >= this.maxConnectionsPerOwner) {
      throw new GatewayError(
        'GATEWAY_LIMIT_EXCEEDED',
        `You can keep at most ${this.maxConnectionsPerOwner} provider connections.`,
      );
    }

    const baseUrl = await this.resolveBaseUrl(definition, input.baseUrl);
    const hint = credentialHint(input.apiKey.trim());
    const fingerprint = credentialFingerprint(ownerRef, input.apiKey.trim());
    const duplicate = existing.find(
      (connection) =>
        connection.providerId === definition.id &&
        (connection.baseUrl ?? '') === (baseUrl ?? '') &&
        connection.credentialFingerprint === fingerprint,
    );
    if (duplicate) {
      throw new GatewayError(
        'GATEWAY_CONNECTION_DUPLICATE',
        'That provider and key are already connected.',
        { details: { connectionId: duplicate.id } },
      );
    }

    const adapter = this.registry.adapter(definition.id);
    const context: AdapterContext = {
      apiKey: input.apiKey.trim(),
      baseUrl: baseUrl ?? definition.baseUrl,
      timeoutMs: this.timeoutMs,
      transport: this.transport,
      ...(input.authFormat ? { authFormatOverride: input.authFormat } : {}),
    };

    const suppliedModels = this.normalizeModelIds(input.modelIds ?? []);
    const validation = input.skipDiscovery
      ? ({ valid: true } as CredentialValidationResult)
      : await adapter.validateCredential(context);

    const discovered = validation.models ?? [];
    const modelIds = this.normalizeModelIds([
      ...suppliedModels,
      ...discovered.map((model) => model.modelId),
    ]);
    if (modelIds.length === 0) {
      throw new GatewayError(
        'GATEWAY_INVALID_REQUEST',
        validation.valid
          ? 'No models were discovered. Add at least one model id to continue.'
          : 'The key could not be validated and no models were discovered.',
        { details: { errorCategory: validation.errorCategory ?? 'validation' } },
      );
    }

    const defaultModelId =
      input.defaultModelId && modelIds.includes(input.defaultModelId)
        ? input.defaultModelId
        : (pickDefaultModelId(modelIds, definition.defaultModelId) as string);

    const stored = await this.vault.put(ownerRef, input.apiKey.trim());
    const timestamp = nowIso(this.now);
    const connection: ProviderConnection = {
      id: `conn_${randomUUID()}`,
      ownerRef,
      providerId: definition.id,
      displayName: this.displayName(input.displayName, definition.displayName),
      credentialRef: stored.ref,
      status: validation.valid ? 'active' : 'invalid',
      modelIds,
      defaultModelId,
      ...(baseUrl ? { baseUrl } : {}),
      credentialHint: hint,
      credentialFingerprint: fingerprint,
      // The first key is an explicit pool of one, so rotation has a real list
      // to work with from the moment a connection exists.
      keys: [
        {
          id: `key_${randomUUID()}`,
          ref: stored.ref,
          hint,
          fingerprint,
          status: validation.valid ? 'active' : 'invalid',
          createdAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(validation.valid ? { lastValidatedAt: timestamp } : {}),
      ...(validation.valid ? {} : { lastErrorCategory: validation.errorCategory ?? 'unknown' }),
    };
    await this.connections.put(connection);

    const preferences = await this.preferences.get(ownerRef);
    if (!preferences?.defaultConnectionId) {
      await this.preferences.put({
        ownerRef,
        defaultConnectionId: connection.id,
        defaultModelId,
        projects: preferences?.projects ?? {},
        updatedAt: timestamp,
      });
    }

    return this.toView(connection);
  }

  async listConnections(scope: GatewayScope): Promise<readonly ConnectionListEntry[]> {
    const ownerRef = requireOwner(scope);
    const [stored, preferences] = await Promise.all([
      this.connections.listByOwner(ownerRef),
      this.preferences.get(ownerRef),
    ]);
    const entries: ConnectionListEntry[] = [];
    for (const connection of stored) {
      const definition = this.registry.definition(connection.providerId);
      entries.push({
        connection: this.toView(connection),
        providerName: definition.displayName,
        models: this.modelsFor(connection),
        isDefault: preferences?.defaultConnectionId === connection.id,
        healthy: connection.status === 'active',
      });
    }
    return entries.sort((a, b) => a.connection.createdAt.localeCompare(b.connection.createdAt));
  }

  async getConnection(
    scope: GatewayScope,
    connectionId: string,
  ): Promise<ProviderConnection | undefined> {
    const ownerRef = requireOwner(scope);
    const connection = await this.connections.get(connectionId);
    if (!connection) return undefined;
    return connection.ownerRef === ownerRef ? connection : undefined;
  }

  /** Validates the stored credential and refreshes discovery when supported. */
  async validateConnection(
    scope: GatewayScope,
    connectionId: string,
  ): Promise<CredentialValidationResult> {
    const ownerRef = requireOwner(scope);
    this.limiter.consume(ownerRef, 'validate');
    const connection = await this.requireOwnedConnection(ownerRef, connectionId);
    const adapter = this.registry.adapter(connection.providerId);
    let context: AdapterContext;
    try {
      context = await this.adapterContext(ownerRef, connection);
    } catch (error) {
      await this.markValidation(connection, false, errorCategoryOf(error));
      throw error;
    }
    let result: CredentialValidationResult;
    try {
      result = await adapter.validateCredential(context);
    } catch (error) {
      const category = errorCategoryOf(error);
      await this.markValidation(connection, false, category);
      return { valid: false, errorCategory: category };
    }
    if (!result.valid) {
      await this.markValidation(connection, false, result.errorCategory ?? 'unknown');
      return result;
    }
    const discovered = result.models ?? [];
    const modelIds = this.normalizeModelIds([
      ...connection.modelIds,
      ...discovered.map((model) => model.modelId),
    ]);
    const definition = this.registry.definition(connection.providerId);
    const defaultModelId =
      connection.defaultModelId && modelIds.includes(connection.defaultModelId)
        ? connection.defaultModelId
        : pickDefaultModelId(modelIds, definition.defaultModelId);
    await this.connections.put({
      ...connection,
      status: 'active',
      modelIds,
      ...(defaultModelId ? { defaultModelId } : {}),
      lastValidatedAt: nowIso(this.now),
      updatedAt: nowIso(this.now),
      lastErrorCategory: undefined,
      displayName: connection.displayName,
    } as ProviderConnection);
    return { ...result, models: this.modelsFor({ ...connection, modelIds }) };
  }

  async discoverModels(
    scope: GatewayScope,
    connectionId: string,
  ): Promise<readonly GatewayModel[]> {
    const ownerRef = requireOwner(scope);
    this.limiter.consume(ownerRef, 'discover');
    const connection = await this.requireOwnedConnection(ownerRef, connectionId);
    const adapter = this.registry.adapter(connection.providerId);
    const context = await this.adapterContext(ownerRef, connection);
    const discovered = await adapter.discoverModels(context);
    const modelIds = this.normalizeModelIds([
      ...connection.modelIds,
      ...discovered.map((model) => model.modelId),
    ]);
    await this.connections.put({
      ...connection,
      modelIds,
      updatedAt: nowIso(this.now),
    });
    return this.modelsFor({ ...connection, modelIds });
  }

  async updateConnection(
    scope: GatewayScope,
    connectionId: string,
    patch: UpdateConnectionInput,
  ): Promise<ConnectionView> {
    const ownerRef = requireOwner(scope);
    const connection = await this.requireOwnedConnection(ownerRef, connectionId);
    const definition = this.registry.definition(connection.providerId);

    const baseUrl =
      patch.baseUrl === undefined
        ? connection.baseUrl
        : await this.resolveBaseUrl(definition, patch.baseUrl);
    const modelIds =
      patch.modelIds === undefined ? connection.modelIds : this.normalizeModelIds(patch.modelIds);
    if (modelIds.length === 0) {
      throw new GatewayError('GATEWAY_INVALID_REQUEST', 'A connection needs at least one model.');
    }
    const requestedDefault =
      patch.defaultModelId === undefined
        ? connection.defaultModelId
        : (patch.defaultModelId ?? undefined);
    if (requestedDefault && !modelIds.includes(requestedDefault)) {
      throw new GatewayError(
        'GATEWAY_INVALID_REQUEST',
        'The default model must be one of the connection models.',
      );
    }
    const status = patch.status ?? (connection.status === 'invalid' ? 'invalid' : 'active');
    const updated: ProviderConnection = {
      ...connection,
      displayName: patch.displayName
        ? this.displayName(patch.displayName, connection.displayName)
        : connection.displayName,
      modelIds,
      ...(requestedDefault ? { defaultModelId: requestedDefault } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      status,
      updatedAt: nowIso(this.now),
    };
    await this.connections.put(updated);
    return this.toView(updated);
  }

  /** Replaces the secret in place. The connection id and preferences survive. */
  async replaceCredential(
    scope: GatewayScope,
    connectionId: string,
    apiKey: string,
  ): Promise<ConnectionView> {
    const ownerRef = requireOwner(scope);
    const connection = await this.requireOwnedConnection(ownerRef, connectionId);
    const adapter = this.registry.adapter(connection.providerId);
    await this.vault.replace(ownerRef, connection.credentialRef, apiKey.trim());
    const hint = credentialHint(apiKey.trim());
    const fingerprint = credentialFingerprint(ownerRef, apiKey.trim());
    const context = await this.adapterContext(ownerRef, { ...connection, credentialHint: hint });
    const validation = await adapter.validateCredential(context);
    const discovered = validation.models ?? [];
    const modelIds = this.normalizeModelIds([
      ...connection.modelIds,
      ...discovered.map((model) => model.modelId),
    ]);
    const updated: ProviderConnection = {
      ...connection,
      credentialHint: hint,
      credentialFingerprint: fingerprint,
      modelIds,
      status: validation.valid ? 'active' : 'invalid',
      updatedAt: nowIso(this.now),
      ...(validation.valid
        ? { lastValidatedAt: nowIso(this.now), lastErrorCategory: undefined }
        : { lastErrorCategory: validation.errorCategory ?? 'unknown' }),
      displayName: connection.displayName,
    } as ProviderConnection;
    await this.connections.put(updated);
    return this.toView(updated);
  }

  async deleteConnection(scope: GatewayScope, connectionId: string): Promise<void> {
    const ownerRef = requireOwner(scope);
    const connection = await this.requireOwnedConnection(ownerRef, connectionId);
    // Every pooled key's ciphertext goes with the connection.
    for (const key of this.keysOf(connection)) {
      await this.vault.delete(ownerRef, key.ref);
    }
    await this.connections.delete(connection.id);

    const preferences = await this.preferences.get(ownerRef);
    if (preferences) {
      const projects: Record<string, ProjectPreference> = {};
      for (const [projectId, preference] of Object.entries(preferences.projects)) {
        if (preference.connectionId !== connection.id) projects[projectId] = preference;
      }
      const remaining = (await this.connections.listByOwner(ownerRef))[0];
      await this.preferences.put({
        ownerRef,
        ...(preferences.defaultConnectionId === connection.id
          ? remaining
            ? {
                defaultConnectionId: remaining.id,
                defaultModelId: remaining.defaultModelId ?? remaining.modelIds[0],
              }
            : {}
          : {
              ...(preferences.defaultConnectionId
                ? { defaultConnectionId: preferences.defaultConnectionId }
                : {}),
              ...(preferences.defaultModelId ? { defaultModelId: preferences.defaultModelId } : {}),
            }),
        projects,
        updatedAt: nowIso(this.now),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  async getPreferences(scope: GatewayScope): Promise<ProviderPreferences> {
    const ownerRef = requireOwner(scope);
    const stored = await this.preferences.get(ownerRef);
    return (
      stored ?? {
        ownerRef,
        projects: {},
        updatedAt: nowIso(this.now),
      }
    );
  }

  async setPreferences(
    scope: GatewayScope,
    input: {
      readonly defaultConnectionId?: string | null;
      readonly defaultModelId?: string | null;
      readonly projects?: Readonly<Record<string, ProjectPreference | null>>;
    },
  ): Promise<ProviderPreferences> {
    const ownerRef = requireOwner(scope);
    const current = await this.getPreferences(scope);
    let defaultConnectionId: string | undefined = current.defaultConnectionId;
    let defaultModelId: string | undefined = current.defaultModelId;

    if (input.defaultConnectionId !== undefined) {
      if (input.defaultConnectionId === null) {
        defaultConnectionId = undefined;
        defaultModelId = undefined;
      } else {
        const connection = await this.requireOwnedConnection(ownerRef, input.defaultConnectionId);
        defaultConnectionId = connection.id;
        defaultModelId =
          input.defaultModelId && connection.modelIds.includes(input.defaultModelId)
            ? input.defaultModelId
            : connection.defaultModelId && connection.modelIds.includes(connection.defaultModelId)
              ? connection.defaultModelId
              : connection.modelIds[0];
      }
    } else if (input.defaultModelId !== undefined && input.defaultModelId !== null) {
      if (!defaultConnectionId) {
        throw new GatewayError('GATEWAY_INVALID_REQUEST', 'Choose a default connection first.');
      }
      const connection = await this.requireOwnedConnection(ownerRef, defaultConnectionId);
      if (!connection.modelIds.includes(input.defaultModelId)) {
        throw new GatewayError(
          'GATEWAY_INVALID_REQUEST',
          'That model is not available on the default connection.',
        );
      }
      defaultModelId = input.defaultModelId;
    }

    const projects: Record<string, ProjectPreference> = { ...current.projects };
    for (const [projectId, preference] of Object.entries(input.projects ?? {})) {
      const key = bounded(projectId.trim(), 128);
      if (key.length === 0) continue;
      if (preference === null) {
        delete projects[key];
        continue;
      }
      const connection = await this.requireOwnedConnection(ownerRef, preference.connectionId);
      if (!connection.modelIds.includes(preference.modelId)) {
        throw new GatewayError(
          'GATEWAY_INVALID_REQUEST',
          'The project model must be available on the chosen connection.',
        );
      }
      projects[key] = { connectionId: connection.id, modelId: preference.modelId };
    }

    const next: ProviderPreferences = {
      ownerRef,
      ...(defaultConnectionId ? { defaultConnectionId } : {}),
      ...(defaultModelId ? { defaultModelId } : {}),
      projects,
      updatedAt: nowIso(this.now),
    };
    await this.preferences.put(next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Routing and generation
  // -------------------------------------------------------------------------

  async resolveRoute(
    scope: GatewayScope,
    options: {
      readonly projectId?: string;
      readonly connectionId?: string;
      readonly modelId?: string;
      readonly category?: string;
      readonly needsStreaming?: boolean;
      readonly estimatedInputTokens?: number;
      readonly purpose?: string;
    } = {},
  ): Promise<ResolvedRoute> {
    const ownerRef = requireOwner(scope);
    if (options.connectionId) {
      const connection = await this.requireOwnedConnection(ownerRef, options.connectionId);
      const modelId = this.pickModel(connection, options.modelId);
      return {
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId,
        source: 'explicit',
      };
    }
    // A model named without a connection still has to exist on the connection
    // the owner's own preference selects; it is never moved to another one.
    if (options.modelId === undefined && this.selector !== undefined && options.category) {
      return this.resolveSelectorRoute(ownerRef, options);
    }
    const route = await this.resolvePreferenceRoute(ownerRef, options);
    // An explicitly requested model is never silently swapped for another one.
    if (options.modelId && route.modelId !== options.modelId) {
      throw new GatewayError(
        'GATEWAY_MODEL_UNKNOWN',
        'That model is not available on the connection this request would use.',
        { details: { modelId: options.modelId } },
      );
    }
    return route;
  }

  /**
   * Asks the platform's model router, once, and uses its answer verbatim.
   *
   * There is no second choice here: if the router refuses, or names something
   * this owner cannot use, the request fails with a readable reason. Falling
   * back to "some other model" is exactly the behaviour this method refuses.
   */
  private async resolveSelectorRoute(
    ownerRef: string,
    options: {
      readonly projectId?: string;
      readonly category?: string;
      readonly needsStreaming?: boolean;
      readonly estimatedInputTokens?: number;
      readonly purpose?: string;
    },
  ): Promise<ResolvedRoute> {
    if (this.selector === undefined) {
      throw new GatewayError('GATEWAY_ROUTE_UNAVAILABLE', 'No model router is configured.');
    }
    const selection = await this.selector.select({
      ownerRef,
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      category: options.category ?? 'general-conversation',
      ...(options.needsStreaming !== undefined ? { needsStreaming: options.needsStreaming } : {}),
      ...(options.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: options.estimatedInputTokens }
        : {}),
      ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
    });
    if (selection.outcome !== 'routed') {
      throw new GatewayError('GATEWAY_ROUTE_UNAVAILABLE', selection.summary, {
        details: selection.decisionId === undefined ? {} : { decisionId: selection.decisionId },
      });
    }
    const connection = await this.connections.get(selection.connectionId);
    if (!connection || connection.ownerRef !== ownerRef) {
      throw new GatewayError(
        'GATEWAY_ROUTE_UNAVAILABLE',
        'The provider the router selected is no longer available to you. Nothing was sent.',
      );
    }
    if (connection.status === 'disabled') {
      throw new GatewayError(
        'GATEWAY_ROUTE_UNAVAILABLE',
        'The provider the router selected is disabled. Nothing was sent.',
      );
    }
    if (!connection.modelIds.includes(selection.modelId)) {
      throw new GatewayError(
        'GATEWAY_ROUTE_UNAVAILABLE',
        'The model the router selected is not offered by that connection. Nothing was sent.',
      );
    }
    return {
      connectionId: connection.id,
      providerId: connection.providerId,
      modelId: selection.modelId,
      source: 'router',
      ...(selection.decisionId !== undefined ? { decisionId: selection.decisionId } : {}),
      summary: selection.summary,
    };
  }

  private async resolvePreferenceRoute(
    ownerRef: string,
    options: {
      readonly projectId?: string;
      readonly connectionId?: string;
      readonly modelId?: string;
    },
  ): Promise<ResolvedRoute> {
    const preferences = await this.preferences.get(ownerRef);
    const projectId = options.projectId;
    if (projectId && preferences?.projects[projectId]) {
      const preference = preferences.projects[projectId] as ProjectPreference;
      const connection = await this.connections.get(preference.connectionId);
      if (connection && connection.ownerRef === ownerRef && connection.status !== 'disabled') {
        if (connection.modelIds.includes(preference.modelId)) {
          return {
            connectionId: connection.id,
            providerId: connection.providerId,
            modelId: preference.modelId,
            source: 'project',
          };
        }
      }
    }
    if (preferences?.defaultConnectionId) {
      const connection = await this.connections.get(preferences.defaultConnectionId);
      if (connection && connection.ownerRef === ownerRef && connection.status !== 'disabled') {
        const modelId =
          options.modelId && connection.modelIds.includes(options.modelId)
            ? options.modelId
            : preferences.defaultModelId && connection.modelIds.includes(preferences.defaultModelId)
              ? preferences.defaultModelId
              : this.pickModel(connection, undefined);
        return {
          connectionId: connection.id,
          providerId: connection.providerId,
          modelId,
          source: 'default',
        };
      }
    }
    throw new GatewayError(
      'GATEWAY_NO_PROVIDER_CONFIGURED',
      'No AI provider is connected yet. Add one in Settings → AI providers.',
    );
  }

  /**
   * How much of today's allowance this owner has used.
   *
   * Counted from the usage rows the gateway already writes, so the number shown
   * to a person and the number enforced are the same number. A record is today's
   * when its timestamp falls on or after UTC midnight.
   */
  async usageToday(scope: GatewayScope): Promise<{ used: number; ceiling: number | null }> {
    const ownerRef = requireOwner(scope);
    if (this.dailyRequestCeiling <= 0) return { used: 0, ceiling: null };
    const since = new Date(this.now());
    since.setUTCHours(0, 0, 0, 0);
    const rows = await this.usage.listByOwner(ownerRef, this.dailyRequestCeiling + 50);
    const used = rows.filter((row) => Date.parse(row.requestedAt) >= since.getTime()).length;
    return { used, ceiling: this.dailyRequestCeiling };
  }

  private async assertWithinDailyCeiling(ownerRef: string): Promise<void> {
    if (this.dailyRequestCeiling <= 0) return;
    const { used } = await this.usageToday({ ownerRef } as GatewayScope);
    if (used < this.dailyRequestCeiling) return;
    throw new GatewayError(
      'GATEWAY_DAILY_CEILING_REACHED',
      `This account has used its ${this.dailyRequestCeiling} answers for today. It resets at midnight UTC.`,
      { details: { used, ceiling: this.dailyRequestCeiling } },
    );
  }

  /** True when the owner has at least one usable connection. */
  async isConfigured(scope: GatewayScope): Promise<boolean> {
    const ownerRef = requireOwner(scope);
    const stored = await this.connections.listByOwner(ownerRef);
    return stored.some((connection) => connection.status !== 'disabled');
  }

  async generate(scope: GatewayScope, request: GenerationRequest): Promise<GenerationOutcome> {
    const ownerRef = requireOwner(scope);
    await this.assertWithinDailyCeiling(ownerRef);
    const projectId = request.projectId ?? scope.projectId;
    throwIfAborted(request.signal);
    const route = await this.resolveRoute(scope, {
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      ...(request.modelId ? { modelId: request.modelId } : {}),
      ...(request.category ? { category: request.category } : {}),
      ...(request.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: request.estimatedInputTokens }
        : {}),
      purpose: request.category === undefined ? undefined : 'generation',
    } as Parameters<AIProviderGateway['resolveRoute']>[1]);
    this.limiter.consume(ownerRef, 'generate');

    const connection = await this.requireOwnedConnection(ownerRef, route.connectionId);
    const definition = this.registry.definition(connection.providerId);
    const adapter = this.registry.adapter(connection.providerId);
    this.assertCapabilities(
      definition.id,
      connection,
      route.modelId,
      request.requiredCapabilities ?? [],
    );

    const startedAt = Date.now();
    const requestedAt = nowIso(this.now);
    let keys = this.keysOf(connection);
    // A rate-limited key is a spent bucket, not a broken provider. Rotating to
    // another key can serve the request immediately, so candidates are ordered
    // least-recently-used first and an attempt is not wasted waiting when a
    // fresh key is available.
    const candidates = usableKeys(keys, this.now());
    if (candidates.length === 0) {
      throw this.allKeysCooling(keys);
    }
    const maxAttempts = Math.max(
      1,
      Math.min(Math.max(this.retry.maxAttempts, candidates.length), 8),
    );
    let attempts = 0;
    let result: AdapterResult | undefined;
    let failure: unknown;

    // Bounded retries, applied ONLY to failures that are safe to repeat: nothing
    // has been produced yet, so a retry cannot double-charge for an answer.
    while (attempts < maxAttempts) {
      const key = candidates[attempts % candidates.length] as ConnectionKey;
      attempts += 1;
      throwIfAborted(request.signal);
      try {
        const context = await this.adapterContext(ownerRef, connection, request.signal, key.ref);
        result = await adapter.generate(context, {
          modelId: route.modelId,
          messages: request.messages,
          ...(request.system !== undefined ? { system: request.system } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined
            ? { maxOutputTokens: request.maxOutputTokens }
            : {}),
          ...(request.structuredOutput !== undefined
            ? { structuredOutput: request.structuredOutput }
            : {}),
          ...(request.requiredCapabilities
            ? { requiredCapabilities: request.requiredCapabilities }
            : {}),
        });
        failure = undefined;
        keys = replaceKey(keys, markKeyHealthy(key, this.now()));
        break;
      } catch (error) {
        failure = error;
        keys = replaceKey(keys, this.keyAfterFailure(key, error));
        if (attempts >= maxAttempts) break;
        // A rejected key is retired, so moving on is safe: the next key has
        // not been tried yet.
        // Only a key-shaped failure is worth another key. A malformed request
        // or an unknown model would fail the same way on every key in the pool.
        const keySpecific = isRateLimit(error) || isAuthFailure(error) || isOutOfCredit(error);
        const unspentKeyRemains = keySpecific && key !== candidates[candidates.length - 1];
        // Another key is a different bucket: spend it before waiting on this
        // one. Waiting is what the LAST candidate does, never the first.
        if (unspentKeyRemains) continue;
        if (!keySpecific) break;
        // A pool never sleeps. With more than one key the caller gets an
        // immediate honest refusal naming the soonest reset, because sitting on
        // a cooldown is exactly the slowness the pool exists to remove. A
        // single key may still wait: that is the only way it can recover.
        if (candidates.length > 1) break;
        if (!isRetryable(error)) break;
        // A provider that says how long to wait is obeyed, within the ceiling
        // this server sets: a live 429 from Gemini asks for 15-30s, and three
        // 250ms retries would all be rejected the same way.
        const hint = retryHintOf(error);
        // A 429 with no stated wait still needs room: free tiers meter per
        // minute, and 250ms/500ms retries spend the whole budget failing.
        const floor = isRateLimit(error) ? this.rateLimitFloorMs : 0;
        const delay = Math.min(
          Math.max(hint ?? this.retry.baseDelayMs * 2 ** (attempts - 1), floor),
          this.retry.maxDelayMs,
        );
        await this.sleep(delay);
      }
    }
    const latencyMs = Date.now() - startedAt;
    if (keys !== this.keysOf(connection)) await this.writeKeys(connection, keys);
    // Every key now needs a wait: say so plainly, with the soonest reset,
    // instead of passing along the last provider refusal as if the vendor were
    // down. A caller can then act on the real reason.
    if (
      result === undefined &&
      (isRateLimit(failure) || isOutOfCredit(failure)) &&
      usableKeys(keys, this.now()).length === 0
    ) {
      failure = this.allKeysCooling(keys);
    }

    if (result === undefined) {
      const aborted = isGatewayError(failure) && failure.code === 'GATEWAY_ABORTED';
      await this.recordUsage(
        this.usageFor({
          ownerRef,
          ...(projectId ? { projectId } : {}),
          ...(request.category ? { taskType: request.category } : {}),
          providerId: connection.providerId,
          modelId: route.modelId,
          connectionId: connection.id,
          ...(request.runId ? { runId: request.runId } : {}),
          requestedAt,
          status: aborted ? 'cancelled' : 'failure',
          inputTokens: null,
          outputTokens: null,
          latencyMs,
          attempts,
          streamed: false,
          errorCategory: errorCategoryOf(failure),
        }),
      );
      if (isGatewayError(failure)) throw failure;
      throw new GatewayError('GATEWAY_PROVIDER_ERROR', 'The provider failed to answer.');
    }

    await this.recordUsage(
      this.usageFor({
        ownerRef,
        ...(projectId ? { projectId } : {}),
        ...(request.category ? { taskType: request.category } : {}),
        providerId: connection.providerId,
        modelId: route.modelId,
        connectionId: connection.id,
        ...(request.runId ? { runId: request.runId } : {}),
        requestedAt,
        status: 'success',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs,
        attempts,
        streamed: false,
      }),
    );
    return {
      content: result.content,
      providerId: connection.providerId,
      modelId: route.modelId,
      connectionId: connection.id,
      finishReason: result.finishReason,
      usage: result.usage,
      live: true,
      latencyMs,
      requestedAt,
      attempts,
      ...(route.decisionId !== undefined ? { decisionId: route.decisionId } : {}),
    };
  }

  /**
   * Streams an answer through the same route resolution as `generate`.
   *
   * Usage is recorded exactly once, on whichever way the stream ends: completed,
   * failed, or cancelled. A cancelled stream is reported as cancelled - never as
   * a success, and never as a silent truncation.
   */
  async *stream(
    scope: GatewayScope,
    request: GenerationRequest,
  ): AsyncIterable<GatewayStreamChunk> {
    const ownerRef = requireOwner(scope);
    const projectId = request.projectId ?? scope.projectId;
    await this.assertWithinDailyCeiling(ownerRef);
    throwIfAborted(request.signal);
    const route = await this.resolveRoute(scope, {
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      ...(request.modelId ? { modelId: request.modelId } : {}),
      ...(request.category ? { category: request.category } : {}),
      needsStreaming: true,
      ...(request.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: request.estimatedInputTokens }
        : {}),
      purpose: request.category === undefined ? undefined : 'streamed generation',
    } as Parameters<AIProviderGateway['resolveRoute']>[1]);
    this.limiter.consume(ownerRef, 'generate');

    const connection = await this.requireOwnedConnection(ownerRef, route.connectionId);
    const definition = this.registry.definition(connection.providerId);
    const adapter = this.registry.adapter(connection.providerId);
    if (!definition.capabilities.includes('streaming') || !adapter.stream) {
      throw new GatewayError(
        'GATEWAY_CAPABILITY_UNSUPPORTED',
        `${definition.displayName} does not support streaming through this gateway.`,
      );
    }
    this.assertCapabilities(
      definition.id,
      connection,
      route.modelId,
      request.requiredCapabilities ?? [],
    );

    const startedAt = Date.now();
    const requestedAt = nowIso(this.now);
    let usage: { inputTokens: number | null; outputTokens: number | null } | undefined;
    let finishReason: string | undefined;

    // Streaming rotates too: a spent key is tried once, then the next one
    // serves the same request. Fragments already yielded mean the attempt
    // cannot be repeated, so rotation only happens before the first fragment.
    const keys = this.keysOf(connection);
    const candidates = usableKeys(keys, this.now());
    if (candidates.length === 0) {
      await this.recordUsage(
        this.usageFor({
          ownerRef,
          ...(projectId ? { projectId } : {}),
          ...(request.category ? { taskType: request.category } : {}),
          providerId: connection.providerId,
          modelId: route.modelId,
          connectionId: connection.id,
          ...(request.runId ? { runId: request.runId } : {}),
          requestedAt,
          status: 'failure',
          inputTokens: null,
          outputTokens: null,
          latencyMs: Date.now() - startedAt,
          attempts: 0,
          streamed: true,
          errorCategory: 'rate-limit',
        }),
      );
      throw this.allKeysCooling(keys);
    }

    try {
      let lastStreamError: unknown;
      let started = false;
      for (let index = 0; index < candidates.length; index += 1) {
        const key = candidates[index] as ConnectionKey;
        try {
          const context = await this.adapterContext(ownerRef, connection, request.signal, key.ref);
          for await (const chunk of adapter.stream(context, {
            modelId: route.modelId,
            messages: request.messages,
            ...(request.system !== undefined ? { system: request.system } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxOutputTokens !== undefined
              ? { maxOutputTokens: request.maxOutputTokens }
              : {}),
          })) {
            // An abort ends the stream as a cancellation, even when the transport
            // merely stops producing fragments instead of throwing.
            throwIfAborted(request.signal);
            if (chunk.usage !== undefined) usage = chunk.usage;
            if (chunk.finishReason !== undefined) finishReason = chunk.finishReason;
            if (chunk.delta.length > 0) {
              started = true;
              yield { delta: chunk.delta, done: false };
            }
            if (chunk.done) break;
          }
          await this.writeKeys(connection, replaceKey(keys, markKeyHealthy(key, this.now())));
          lastStreamError = undefined;
          break;
        } catch (error) {
          lastStreamError = error;
          await this.writeKeys(connection, replaceKey(keys, this.keyAfterFailure(key, error)));
          // Once a fragment has reached the caller the answer cannot be
          // restarted on another key without duplicating text.
          if (started) throw error;
          if (!isRateLimit(error) && !isAuthFailure(error) && !isOutOfCredit(error)) throw error;
          if (index === candidates.length - 1) throw error;
        }
      }
      if (lastStreamError !== undefined) throw lastStreamError;
    } catch (error) {
      const cancelled = isGatewayError(error) && error.code === 'GATEWAY_ABORTED';
      await this.recordUsage(
        this.usageFor({
          ownerRef,
          ...(projectId ? { projectId } : {}),
          ...(request.category ? { taskType: request.category } : {}),
          providerId: connection.providerId,
          modelId: route.modelId,
          connectionId: connection.id,
          ...(request.runId ? { runId: request.runId } : {}),
          requestedAt,
          status: cancelled ? 'cancelled' : 'failure',
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          latencyMs: Date.now() - startedAt,
          attempts: 1,
          streamed: true,
          errorCategory: errorCategoryOf(error),
        }),
      );
      throw error;
    }

    const latencyMs = Date.now() - startedAt;
    await this.recordUsage(
      this.usageFor({
        ownerRef,
        ...(projectId ? { projectId } : {}),
        ...(request.category ? { taskType: request.category } : {}),
        providerId: connection.providerId,
        modelId: route.modelId,
        connectionId: connection.id,
        ...(request.runId ? { runId: request.runId } : {}),
        requestedAt,
        status: 'success',
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        latencyMs,
        attempts: 1,
        streamed: true,
      }),
    );
    yield {
      delta: '',
      done: true,
      usage: usage ?? { inputTokens: null, outputTokens: null },
      ...(finishReason !== undefined ? { finishReason } : {}),
      latencyMs,
    };
  }

  async listUsage(scope: GatewayScope, limit = 50): Promise<readonly UsageRecord[]> {
    const ownerRef = requireOwner(scope);
    return this.usage.listByOwner(ownerRef, Math.min(Math.max(limit, 1), 100));
  }

  /**
   * A scope-bound AICore. Any service that already speaks the AI Core interface
   * (agents, coding agent, generation, document/media reasoning) can take this
   * and start routing the owner's own provider without changing its own code.
   */
  async createCore(scope: GatewayScope, projectId?: string): Promise<AICore> {
    const ownerRef = requireOwner(scope);
    const stored = await this.connections.listByOwner(ownerRef);
    const usable = stored.filter((connection) => connection.status !== 'disabled');
    if (usable.length === 0) {
      throw new GatewayError('GATEWAY_NO_PROVIDER_CONFIGURED', 'No AI provider is connected yet.');
    }
    const preferences = await this.preferences.get(ownerRef);
    const projectPreference = projectId ? preferences?.projects[projectId] : undefined;
    const preferredConnection =
      (projectPreference
        ? usable.find((connection) => connection.id === projectPreference.connectionId)
        : undefined) ??
      (preferences?.defaultConnectionId
        ? usable.find((connection) => connection.id === preferences.defaultConnectionId)
        : undefined) ??
      usable[0];
    // The preferred connection is registered first so its models win any id
    // collision (two connections to the same vendor can expose the same model).
    const ordered = preferredConnection
      ? [
          preferredConnection,
          ...usable.filter((connection) => connection.id !== preferredConnection.id),
        ]
      : usable;

    const providers: AIProvider[] = [];
    const registry = new ModelRegistry();
    let defaultModel: string | undefined;
    for (const connection of ordered) {
      const definition = this.registry.definition(connection.providerId);
      const providerId = `gw_${connection.id}`;
      providers.push(
        new GatewayScopedProvider({
          id: providerId,
          displayName: `${definition.displayName} (${connection.displayName})`,
          gateway: this,
          ownerRef,
          connection,
          ...(projectId ? { projectId } : {}),
        }),
      );
      for (const modelId of connection.modelIds) {
        if (registry.hasModel(modelId)) continue;
        registry.registerModel({
          providerId,
          modelId,
          displayName: modelId,
          capabilities: [...definition.modelCapabilities],
          available: true,
        });
        if (connection.id === preferredConnection?.id && defaultModel === undefined) {
          defaultModel = modelId;
        }
      }
    }
    const preferredModel =
      projectPreference?.modelId ??
      (preferences?.defaultModelId && registry.hasModel(preferences.defaultModelId)
        ? preferences.defaultModelId
        : defaultModel);
    return new AICore({
      providers,
      registry,
      config: {
        ...(preferredModel ? { defaultModel: preferredModel } : {}),
        ...(preferredConnection ? { defaultProvider: `gw_${preferredConnection.id}` } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private modelsFor(connection: ProviderConnection): readonly GatewayModel[] {
    const definition = this.registry.definition(connection.providerId);
    return connection.modelIds.map((modelId) => ({
      providerId: connection.providerId,
      modelId,
      displayName: modelId,
      capabilities: [...definition.modelCapabilities],
      available: connection.status === 'active',
      source: connection.lastValidatedAt ? ('discovery' as const) : ('manual' as const),
    }));
  }

  private pickModel(connection: ProviderConnection, requested: string | undefined): string {
    if (requested) {
      if (!connection.modelIds.includes(requested)) {
        throw new GatewayError(
          'GATEWAY_MODEL_UNKNOWN',
          'That model is not available on this connection.',
        );
      }
      return requested;
    }
    if (connection.defaultModelId && connection.modelIds.includes(connection.defaultModelId)) {
      return connection.defaultModelId;
    }
    const first = connection.modelIds[0];
    if (!first) {
      throw new GatewayError('GATEWAY_MODEL_UNKNOWN', 'This connection has no models.');
    }
    return first;
  }

  private assertCapabilities(
    providerId: string,
    connection: ProviderConnection,
    modelId: string,
    required: readonly AICapability[],
  ): void {
    if (required.length === 0) return;
    const definition = this.registry.definition(providerId);
    const supported = new Set<string>([
      ...definition.capabilities,
      ...definition.modelCapabilities,
    ]);
    const missing = required.filter((capability) => !supported.has(capability));
    if (missing.length > 0) {
      throw new GatewayError(
        'GATEWAY_CAPABILITY_UNSUPPORTED',
        `${definition.displayName} cannot do ${missing.join(', ')} through this gateway.`,
        { details: { providerId, modelId, missing: missing.join(',') } },
      );
    }
    if (!connection.modelIds.includes(modelId)) {
      throw new GatewayError(
        'GATEWAY_MODEL_UNKNOWN',
        'That model is not available on this connection.',
      );
    }
  }

  private async adapterContext(
    ownerRef: string,
    connection: ProviderConnection,
    signal?: AbortSignal,
    keyRef?: string,
  ): Promise<AdapterContext> {
    const definition = this.registry.definition(connection.providerId);
    // Only the attempt that is about to run decrypts its key, so the plaintext
    // window stays as narrow with eight keys as it was with one.
    const apiKey = await this.vault.read(ownerRef, keyRef ?? connection.credentialRef);
    const rawBase = connection.baseUrl ?? definition.baseUrl;
    if (!rawBase) {
      throw new GatewayError('GATEWAY_UNSAFE_ENDPOINT', 'This provider needs an endpoint URL.');
    }
    const baseUrl = definition.allowsCustomBaseUrl
      ? (
          await assertSafeEndpoint(rawBase, {
            ...(this.allowInsecureEndpoints ? { allowInsecure: true } : {}),
            ...(this.resolveHost ? { resolve: this.resolveHost } : {}),
          })
        ).toString()
      : rawBase;
    return {
      apiKey,
      baseUrl,
      timeoutMs: this.timeoutMs,
      transport: this.transport,
      ...(signal ? { signal } : {}),
    };
  }

  private async resolveBaseUrl(
    definition: ReturnType<ProviderAdapterRegistry['definition']>,
    requested: string | undefined,
  ): Promise<string | undefined> {
    if (requested === undefined || requested === '') {
      if (definition.allowsCustomBaseUrl) {
        throw new GatewayError(
          'GATEWAY_INVALID_REQUEST',
          'This provider requires an endpoint URL.',
        );
      }
      return undefined;
    }
    if (!definition.allowsCustomBaseUrl) {
      throw new GatewayError(
        'GATEWAY_INVALID_REQUEST',
        `${definition.displayName} does not allow a custom endpoint.`,
      );
    }
    const url = await assertSafeEndpoint(requested, {
      ...(this.allowInsecureEndpoints ? { allowInsecure: true } : {}),
      ...(this.resolveHost ? { resolve: this.resolveHost } : {}),
    });
    return url.toString().replace(/\/$/, '');
  }

  private async requireOwnedConnection(
    ownerRef: string,
    connectionId: string,
  ): Promise<ProviderConnection> {
    const connection = await this.connections.get(connectionId);
    if (!connection || connection.ownerRef !== ownerRef) {
      // Same error either way: existence is owner-private.
      throw new GatewayError(
        'GATEWAY_CONNECTION_NOT_FOUND',
        'That provider connection does not exist.',
      );
    }
    return connection;
  }

  private async markValidation(
    connection: ProviderConnection,
    valid: boolean,
    category: string | undefined,
  ): Promise<void> {
    await this.connections.put({
      ...connection,
      status: valid ? 'active' : 'invalid',
      updatedAt: nowIso(this.now),
      ...(valid
        ? { lastValidatedAt: nowIso(this.now), lastErrorCategory: undefined }
        : { lastErrorCategory: category ?? 'unknown' }),
      displayName: connection.displayName,
    } as ProviderConnection);
  }

  /**
   * Builds a usage record from what actually happened.
   *
   * Token counts and costs are only ever copied from provider-confirmed numbers
   * plus an operator-declared price; anything else stays null and is labelled
   * `unavailable` rather than estimated.
   */
  private usageFor(input: {
    readonly ownerRef: string;
    readonly projectId?: string;
    readonly taskType?: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly connectionId?: string;
    readonly runId?: string;
    readonly requestedAt: string;
    readonly status: 'success' | 'failure' | 'cancelled';
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly latencyMs: number;
    readonly attempts: number;
    readonly streamed: boolean;
    readonly errorCategory?: string;
  }): Omit<UsageRecord, 'id'> {
    const confirmed =
      input.status === 'success' && input.inputTokens !== null && input.outputTokens !== null;
    const totalTokens = confirmed
      ? (input.inputTokens as number) + (input.outputTokens as number)
      : null;
    const cost = this.pricing.estimate({
      providerId: input.providerId,
      modelId: input.modelId,
      inputTokens: confirmed ? input.inputTokens : null,
      outputTokens: confirmed ? input.outputTokens : null,
    });
    const usageSource: UsageSource = confirmed ? 'provider-confirmed' : 'unavailable';
    const costSource: CostSource = cost.costSource;
    return {
      ownerRef: input.ownerRef,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      requestedAt: input.requestedAt,
      status: input.status,
      inputTokens: confirmed ? input.inputTokens : null,
      outputTokens: confirmed ? input.outputTokens : null,
      totalTokens,
      usageSource,
      estimatedCostUsd: cost.estimatedCostUsd,
      costSource,
      latencyMs: input.latencyMs,
      attempts: input.attempts,
      streamed: input.streamed,
      ...(input.errorCategory !== undefined ? { errorCategory: input.errorCategory } : {}),
      live: true,
    };
  }

  private async recordUsage(record: Omit<UsageRecord, 'id'>): Promise<void> {
    await this.usage.record({ ...record, id: newUsageRecordId() });
  }

  private normalizeModelIds(ids: readonly string[]): string[] {
    const unique = new Set<string>();
    for (const raw of ids) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_MODEL_ID) continue;
      unique.add(trimmed);
      if (unique.size >= this.maxModelsPerConnection) break;
    }
    return [...unique];
  }

  private displayName(requested: string | undefined, fallback: string): string {
    const trimmed = (requested ?? '').trim();
    if (trimmed.length === 0) return bounded(fallback, MAX_NAME);
    if (looksSecretShaped(trimmed)) {
      throw new GatewayError(
        'GATEWAY_INVALID_REQUEST',
        'That name looks like a credential and was rejected.',
      );
    }
    return bounded(trimmed, MAX_NAME);
  }

  /**
   * A record stored before keys became a pool reads as a one-key pool, so
   * nothing has to be migrated and no caller sees two shapes.
   */
  private keysOf(connection: ProviderConnection): readonly ConnectionKey[] {
    if (connection.keys && connection.keys.length > 0) return connection.keys;
    return [
      {
        id: `key_${connection.id}`,
        ref: connection.credentialRef,
        hint: connection.credentialHint,
        fingerprint: connection.credentialFingerprint,
        status: connection.status === 'invalid' ? 'invalid' : 'active',
        createdAt: connection.createdAt,
      },
    ];
  }

  /**
   * What one failed attempt means for its key: a rate limit cools it for the
   * wait the provider stated, a rejection retires it, anything else (timeout,
   * outage) leaves it usable because the key was not at fault.
   */
  private keyAfterFailure(key: ConnectionKey, error: unknown): ConnectionKey {
    if (isOutOfCredit(error)) {
      return markKeyCooling(key, this.now(), {
        retryAfterMs: OUT_OF_CREDIT_COOLDOWN_MS,
        errorCategory: 'credit',
      });
    }
    if (isRateLimit(error)) {
      return markKeyCooling(key, this.now(), {
        retryAfterMs: retryHintOf(error),
        errorCategory: errorCategoryOf(error),
      });
    }
    if (isAuthFailure(error)) return markKeyInvalid(key, 'authentication');
    return markKeyUsed(key, this.now());
  }

  /** Honest refusal when every key on a connection is spent. */
  private allKeysCooling(keys: readonly ConnectionKey[]): GatewayError {
    const ordered = selectKeyOrder(keys, this.now());
    const next = ordered[0];
    const until = next?.cooldownUntil ? Date.parse(next.cooldownUntil) : Number.NaN;
    const waitMs = Number.isFinite(until) ? Math.max(0, until - this.now().getTime()) : null;
    const live = keys.filter((key) => key.status !== 'invalid');
    if (live.length > 0 && live.every((key) => key.lastErrorCategory === 'credit')) {
      return new GatewayError(
        'GATEWAY_LIMIT_EXCEEDED',
        'Every key on this connection is out of credit. Top one up or add another key.',
        { details: { reason: 'all-keys-out-of-credit', keyCount: live.length } },
      );
    }
    if (keys.every((key) => key.status === 'invalid')) {
      return new GatewayError(
        'GATEWAY_AUTH_FAILED',
        'Every key on this connection was rejected by the provider. Add or replace one to continue.',
        { details: { reason: 'all-keys-invalid' } },
      );
    }
    return new GatewayError(
      'GATEWAY_RATE_LIMITED',
      waitMs === null
        ? 'Every key on this connection is rate limited right now.'
        : `Every key on this connection is rate limited. The soonest frees up in ${Math.max(1, Math.ceil(waitMs / 1000))}s.`,
      {
        details: {
          ...(waitMs === null ? {} : { retryAfterMs: waitMs }),
          reason: 'all-keys-cooling',
          keyCount: keys.length,
        },
      },
    );
  }

  /** Persists a key-state change without touching anything else. */
  private async writeKeys(
    connection: ProviderConnection,
    keys: readonly ConnectionKey[],
  ): Promise<void> {
    const live = keys.filter((key) => key.status !== 'invalid');
    const healthy = live.some((key) => key.status === 'active');
    await this.connections.put({
      ...connection,
      keys,
      status: live.length === 0 ? 'invalid' : healthy ? 'active' : connection.status,
      updatedAt: nowIso(this.now),
    } as ProviderConnection);
  }

  /**
   * Adds a key to an existing connection so one exhausted key no longer fails
   * the run. The key is validated first: a key that cannot authenticate would
   * only sit in the pool pretending to be capacity.
   */
  async addKey(
    scope: GatewayScope,
    connectionId: string,
    input: { apiKey: string; label?: string },
  ): Promise<ConnectionView> {
    const ownerRef = requireOwner(scope);
    const connection = await this.requireOwnedConnection(ownerRef, connectionId);
    const keys = this.keysOf(connection);
    if (keys.length >= this.maxKeysPerConnection) {
      throw new GatewayError(
        'GATEWAY_LIMIT_EXCEEDED',
        `A connection can hold at most ${this.maxKeysPerConnection} keys.`,
      );
    }
    const secret = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (secret.length === 0) {
      throw new GatewayError('GATEWAY_INVALID_REQUEST', 'An API key is required.');
    }
    const fingerprint = credentialFingerprint(ownerRef, secret);
    if (keys.some((key) => key.fingerprint === fingerprint)) {
      throw new GatewayError(
        'GATEWAY_CONNECTION_DUPLICATE',
        'That key is already on this connection.',
      );
    }
    const definition = this.registry.definition(connection.providerId);
    const adapter = this.registry.adapter(connection.providerId);
    const validation = await adapter.validateCredential({
      apiKey: secret,
      baseUrl: connection.baseUrl ?? definition.baseUrl,
      timeoutMs: this.timeoutMs,
      transport: this.transport,
    });
    if (!validation.valid) {
      throw new GatewayError(
        'GATEWAY_CREDENTIAL_INVALID',
        validation.errorCategory === 'rate-limit'
          ? 'That key is rate limited right now, so it could not be checked. Try again shortly.'
          : 'That key was refused by the provider, so it was not added.',
        { details: { errorCategory: validation.errorCategory ?? 'validation' } },
      );
    }
    const stored = await this.vault.put(ownerRef, secret);
    const timestamp = nowIso(this.now);
    const next: ConnectionKey = {
      id: `key_${randomUUID()}`,
      ref: stored.ref,
      hint: credentialHint(secret),
      fingerprint,
      ...(input.label ? { label: bounded(input.label, 60) } : {}),
      status: 'active',
      createdAt: timestamp,
    };
    await this.writeKeys(connection, [...keys, next]);
    return this.toView(
      (await this.requireOwnedConnection(ownerRef, connectionId)) as ProviderConnection,
    );
  }

  /** Removes one key. The last key cannot be removed; delete the connection. */
  async removeKey(
    scope: GatewayScope,
    connectionId: string,
    keyId: string,
  ): Promise<ConnectionView> {
    const ownerRef = requireOwner(scope);
    const connection = await this.requireOwnedConnection(ownerRef, connectionId);
    const keys = this.keysOf(connection);
    const target = findKey(keys, keyId);
    if (!target) {
      throw new GatewayError('GATEWAY_CREDENTIAL_MISSING', 'That key is not on this connection.');
    }
    if (keys.length === 1) {
      throw new GatewayError(
        'GATEWAY_INVALID_REQUEST',
        'That is the only key on this connection. Delete the connection instead.',
      );
    }
    await this.vault.delete(ownerRef, target.ref);
    await this.writeKeys(
      connection,
      keys.filter((key) => key.id !== keyId),
    );
    return this.toView(
      (await this.requireOwnedConnection(ownerRef, connectionId)) as ProviderConnection,
    );
  }

  private toView(connection: ProviderConnection): ConnectionView {
    const definition = this.registry.definition(connection.providerId);
    return {
      id: connection.id,
      providerId: connection.providerId,
      providerName: definition.displayName,
      displayName: connection.displayName,
      status: connection.status,
      modelIds: [...connection.modelIds],
      defaultModelId: connection.defaultModelId ?? null,
      credentialHint: connection.credentialHint,
      baseUrl: connection.baseUrl ?? null,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      lastValidatedAt: connection.lastValidatedAt ?? null,
      lastErrorCategory: connection.lastErrorCategory ?? null,
      keys: this.keysOf(connection).map(keyView),
    };
  }
}

/**
 * One connection exposed as an AI Core provider, so existing services keep
 * using AICore unchanged. `send` goes through the gateway (so capability,
 * credential and usage rules still apply) instead of talking to the vendor.
 */
export class GatewayScopedProvider implements AIProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly gateway: AIProviderGateway;
  private readonly ownerRef: string;
  private readonly connection: ProviderConnection;
  private readonly projectId?: string;

  constructor(options: {
    readonly id: string;
    readonly displayName: string;
    readonly gateway: AIProviderGateway;
    readonly ownerRef: string;
    readonly connection: ProviderConnection;
    readonly projectId?: string;
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.gateway = options.gateway;
    this.ownerRef = options.ownerRef;
    this.connection = options.connection;
    if (options.projectId) this.projectId = options.projectId;
  }

  async send(request: AIRequest, model: AIModelInfo): Promise<AIResponse> {
    try {
      const outcome = await this.gateway.generate(
        { ownerRef: this.ownerRef, ...(this.projectId ? { projectId: this.projectId } : {}) },
        {
          connectionId: this.connection.id,
          modelId: model.modelId,
          messages: request.messages,
          ...(request.system !== undefined ? { system: request.system } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined
            ? { maxOutputTokens: request.maxOutputTokens }
            : {}),
          ...(request.structuredOutput !== undefined
            ? { structuredOutput: request.structuredOutput }
            : {}),
          ...(request.capabilities ? { requiredCapabilities: request.capabilities } : {}),
        },
      );
      return {
        content: outcome.content,
        providerId: this.id,
        modelId: outcome.modelId,
        usage:
          outcome.usage.inputTokens === null && outcome.usage.outputTokens === null
            ? null
            : {
                inputTokens: outcome.usage.inputTokens ?? 0,
                outputTokens: outcome.usage.outputTokens ?? 0,
              },
        finishReason: outcome.finishReason,
        requestId: `gw_${outcome.requestedAt}_${outcome.connectionId}`,
        generatedAt: outcome.requestedAt,
      };
    } catch (error) {
      if (isGatewayError(error)) throw new AIProviderError(error.message, { cause: error });
      throw error;
    }
  }
}

export type { RateLimitAction };

/** A cancelled request is a typed outcome, not a mystery rejection. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new GatewayError('GATEWAY_ABORTED', 'The request was cancelled.');
  }
}
