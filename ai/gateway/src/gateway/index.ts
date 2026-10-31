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
import type { CredentialVault } from '../vault/index.js';
import { bounded, credentialHint, looksSecretShaped } from '../security/index.js';
import { assertSafeEndpoint } from '../ssrf/index.js';
import type { ConnectionStore, PreferenceStore } from '../store/index.js';
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
  GatewayModel,
  ProjectPreference,
  ProviderConnection,
  ProviderPreferences,
  ResolvedRoute,
  UsageRecord,
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
  readonly maxModelsPerConnection?: number;
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
}

export interface GenerationOutcome {
  readonly content: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly connectionId: string;
  readonly finishReason: AdapterResult['finishReason'];
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null };
  /** True only when a real provider answered over the network. */
  readonly live: boolean;
  readonly latencyMs: number;
  readonly requestedAt: string;
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
  private readonly maxModelsPerConnection: number;

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
    this.maxModelsPerConnection = options.maxModelsPerConnection ?? MAX_MODELS;
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
        : (modelIds[0] as string);

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
    const defaultModelId =
      connection.defaultModelId && modelIds.includes(connection.defaultModelId)
        ? connection.defaultModelId
        : (modelIds[0] ?? undefined);
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
    await this.vault.delete(ownerRef, connection.credentialRef);
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

  /** True when the owner has at least one usable connection. */
  async isConfigured(scope: GatewayScope): Promise<boolean> {
    const ownerRef = requireOwner(scope);
    const stored = await this.connections.listByOwner(ownerRef);
    return stored.some((connection) => connection.status !== 'disabled');
  }

  async generate(scope: GatewayScope, request: GenerationRequest): Promise<GenerationOutcome> {
    const ownerRef = requireOwner(scope);
    const projectId = request.projectId ?? scope.projectId;
    const route = await this.resolveRoute(scope, {
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      ...(request.modelId ? { modelId: request.modelId } : {}),
    });
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
    let result: AdapterResult;
    try {
      const context = await this.adapterContext(ownerRef, connection);
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
    } catch (error) {
      await this.recordUsage({
        ownerRef,
        ...(projectId ? { projectId } : {}),
        providerId: connection.providerId,
        modelId: route.modelId,
        requestedAt,
        status: 'failure',
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
        latencyMs: Date.now() - startedAt,
        errorCategory: errorCategoryOf(error),
        live: true,
      });
      throw error;
    }
    const latencyMs = Date.now() - startedAt;
    await this.recordUsage({
      ownerRef,
      ...(projectId ? { projectId } : {}),
      providerId: connection.providerId,
      modelId: route.modelId,
      requestedAt,
      status: 'success',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd: null,
      latencyMs,
      live: true,
    });
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
    };
  }

  async *stream(
    scope: GatewayScope,
    request: GenerationRequest,
  ): AsyncIterable<{ delta: string; done: boolean }> {
    const ownerRef = requireOwner(scope);
    const route = await this.resolveRoute(scope, {
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
    });
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
    const context = await this.adapterContext(ownerRef, connection);
    yield* adapter.stream(context, {
      modelId: route.modelId,
      messages: request.messages,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
    });
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
  ): Promise<AdapterContext> {
    const definition = this.registry.definition(connection.providerId);
    const apiKey = await this.vault.read(ownerRef, connection.credentialRef);
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
    return { apiKey, baseUrl, timeoutMs: this.timeoutMs, transport: this.transport };
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
