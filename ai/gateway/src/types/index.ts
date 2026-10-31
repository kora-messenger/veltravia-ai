import type { AICapability } from '@veltravia/ai-core';

/**
 * Provider gateway types (Step 26).
 *
 * Three separate things are kept apart on purpose:
 *   1. a PROVIDER - a vendor Veltravia can talk to (declared statically);
 *   2. a CONNECTION - one owner's credential for one provider;
 *   3. a CREDENTIAL - the secret itself, encrypted in the vault and never part
 *      of a connection record, a response, a log line or an audit event.
 */

/** How an adapter talks to a vendor's HTTP API. */
export const AUTH_FORMATS = ['bearer', 'x-api-key', 'x-goog-api-key', 'query-key'] as const;
export type AuthFormat = (typeof AUTH_FORMATS)[number];

export function isAuthFormat(value: unknown): value is AuthFormat {
  return typeof value === 'string' && (AUTH_FORMATS as readonly string[]).includes(value);
}

/**
 * Declared capabilities of one provider.
 *
 * These are the capabilities the ADAPTER can translate, not a guess about a
 * model. Model-level capabilities come from discovery or from an explicit
 * model entry, and unsupported operations are refused rather than silently
 * downgraded.
 */
export const GATEWAY_CAPABILITIES = [
  'text-generation',
  'streaming',
  'structured-output',
  'vision',
  'model-discovery',
  'credential-validation',
] as const;
export type GatewayCapability = (typeof GATEWAY_CAPABILITIES)[number];

/** A statically declared provider in the catalog. */
export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  /** Short, honest description of what the adapter does. */
  readonly description: string;
  /** Adapter family: a native adapter, or the reusable OpenAI-compatible one. */
  readonly adapter: 'openai-compatible' | 'anthropic' | 'gemini';
  /** HTTPS base URL. Empty for custom providers (the owner supplies one). */
  readonly baseUrl: string;
  /** Path used for chat/response generation, relative to baseUrl. */
  readonly generationPath: string;
  /** Path used for model discovery, when the vendor supports it. */
  readonly modelsPath?: string;
  /** Path used to validate a credential, when discovery is unavailable. */
  readonly validationPath?: string;
  readonly auth: AuthFormat;
  /** Static header/env name a key is presented through (never the key itself). */
  readonly authParameter: string;
  /** Capabilities the adapter itself implements. */
  readonly capabilities: readonly GatewayCapability[];
  /** AI Core capabilities the adapter can request for a model. */
  readonly modelCapabilities: readonly AICapability[];
  /** Admissible model ids when the vendor has no discovery endpoint. */
  readonly knownModels?: readonly ModelSeed[];
  /** Whether the owner may override the base URL (custom / self-hosted). */
  readonly allowsCustomBaseUrl: boolean;
  /** Documentation URL for the provider's API-key screen (no secrets). */
  readonly docsUrl?: string;
}

/** A model the catalog knows about before discovery runs. */
export interface ModelSeed {
  /** Exactly as the vendor expects it - never normalized or prettified. */
  readonly modelId: string;
  readonly displayName?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  /** Model-level capability overrides; defaults to the provider's. */
  readonly capabilities?: readonly AICapability[];
}

/** A model entry returned to callers and the UI. */
export interface GatewayModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: readonly AICapability[];
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  /** False when discovery or configuration indicates the model is unusable. */
  readonly available: boolean;
  /** Where the entry came from, so the UI never implies live discovery. */
  readonly source: 'discovery' | 'catalog' | 'manual';
}

export type ConnectionStatus = 'active' | 'invalid' | 'unverified' | 'disabled';

/** An owner's saved provider connection. NEVER contains a secret. */
export interface ProviderConnection {
  readonly id: string;
  readonly ownerRef: string;
  readonly providerId: string;
  readonly displayName: string;
  /** Vault reference to the encrypted credential. Not the credential. */
  readonly credentialRef: string;
  readonly status: ConnectionStatus;
  /** Model ids the owner may use through this connection. */
  readonly modelIds: readonly string[];
  readonly defaultModelId?: string;
  /** Custom OpenAI-compatible endpoints only. */
  readonly baseUrl?: string;
  /** Masked hint (last 4 characters), safe to display. */
  readonly credentialHint: string;
  /** One-way, owner-scoped digest used only to detect an exact duplicate.
   *  Never leaves the server and cannot be turned back into the key. */
  readonly credentialFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Last successful validation, when one ever succeeded. */
  readonly lastValidatedAt?: string;
  /** Normalized category of the last failure, never the provider's raw text. */
  readonly lastErrorCategory?: string;
}

/** Anything that may cross the API boundary as a connection view. */
export interface ConnectionView {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly displayName: string;
  readonly status: ConnectionStatus;
  readonly modelIds: readonly string[];
  readonly defaultModelId: string | null;
  readonly credentialHint: string;
  readonly baseUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastValidatedAt: string | null;
  readonly lastErrorCategory: string | null;
}

/** Per-owner, per-project provider preferences. */
export interface ProviderPreferences {
  readonly ownerRef: string;
  /** Default connection for this owner. */
  readonly defaultConnectionId?: string;
  readonly defaultModelId?: string;
  /** Explicit per-project overrides. */
  readonly projects: Readonly<Record<string, ProjectPreference>>;
  readonly updatedAt: string;
}

export interface ProjectPreference {
  readonly connectionId: string;
  readonly modelId: string;
}

/** The resolved route for one generation request. */
export interface ResolvedRoute {
  readonly connectionId: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Where the choice came from - used for honest reporting, never as auth. */
  readonly source: 'project' | 'default' | 'explicit';
}

/** Usage metadata. No prompts, no keys, no headers. */
export interface UsageRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedAt: string;
  readonly status: 'success' | 'failure';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Only when the catalog declares a reliable price for this exact model. */
  readonly estimatedCostUsd: number | null;
  readonly latencyMs: number;
  /** Normalized error category, never provider text. */
  readonly errorCategory?: string;
  /** Whether the call reached a real provider over the network. */
  readonly live: boolean;
}
