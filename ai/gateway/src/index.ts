/**
 * @veltravia/ai-gateway - the AI provider gateway and BYOK layer (Step 26).
 *
 * Everything that reasons with a language model goes through here: the owner's
 * own provider, an encrypted credential, one capability check, normalized
 * results and normalized errors. No vendor SDK and no credential ever leaves
 * this package.
 */

export { AIProviderGateway, GatewayScopedProvider } from './gateway/index.js';
export { ModelPricingTable, parsePricingConfig } from './providers/pricing.js';
export type {
  RouteSelector,
  RouteSelectorRequest,
  RouteSelectorResult,
  GatewayStreamChunk,
  UsageSource,
  CostSource,
} from './types/index.js';
export type { PricingEntry, PricingInput, CostEstimate } from './providers/pricing.js';
export { prepareContext, estimateTokens, estimateMessagesTokens } from './context/index.js';
export type { ContextBudget, ContextInput, ContextResult } from './context/index.js';
export type {
  ConnectionListEntry,
  CreateConnectionInput,
  GatewayOptions,
  GatewayScope,
  GenerationOutcome,
  GenerationRequest,
  UpdateConnectionInput,
} from './gateway/index.js';

export type {
  AUTH_FORMATS,
  AuthFormat,
  ConnectionStatus,
  ConnectionView,
  GatewayCapability,
  GatewayModel,
  ModelSeed,
  ProjectPreference,
  ProviderConnection,
  ProviderDefinition,
  ProviderPreferences,
  ResolvedRoute,
  UsageRecord,
} from './types/index.js';
export { GATEWAY_CAPABILITIES, isAuthFormat } from './types/index.js';

export {
  PROVIDER_CATALOG,
  catalogView,
  findProviderDefinition,
  CUSTOM_OPENAI_COMPATIBLE_PROVIDER,
  type ProviderCatalogEntry,
} from './providers/catalog.js';
export { ProviderAdapterRegistry, createAdapter, definitionOf } from './providers/registry.js';
export { OpenAICompatibleAdapter } from './providers/openai-compatible.js';
export { AnthropicAdapter } from './providers/anthropic.js';
export { GeminiGatewayAdapter } from './providers/gemini.js';
export type {
  AdapterChunk,
  AdapterContext,
  AdapterRequest,
  AdapterResult,
  CredentialValidationResult,
  ProviderAdapter,
} from './providers/adapter.js';
export {
  FetchProviderTransport,
  ScriptedProviderTransport,
  type ProviderTransport,
  type TransportRequest,
  type TransportResponse,
  type TransportStreamEvent,
  type TransportStreamRequest,
} from './providers/transport.js';

export {
  CredentialVault,
  InMemoryVaultRecordStore,
  VAULT_ALGORITHM,
  loadVaultKeyring,
  type EncryptedCredentialRecord,
  type StoredCredentialRef,
  type VaultKeyring,
  type VaultRecordStore,
} from './vault/index.js';

export {
  InMemoryConnectionStore,
  InMemoryPreferenceStore,
  type ConnectionStore,
  type PreferenceStore,
} from './store/index.js';

export { InMemoryUsageStore, newUsageRecordId, type UsageStore } from './usage/index.js';
export {
  RateLimiter,
  DEFAULT_RATE_LIMITS,
  type RateLimitAction,
  type RateLimitRule,
} from './ratelimit/index.js';

export {
  GatewayError,
  GATEWAY_ERROR_CODES,
  PROVIDER_ERROR_CATEGORIES,
  errorCategoryOf,
  isGatewayError,
  type GatewayErrorCode,
  type ProviderErrorCategory,
} from './errors/index.js';

export {
  bounded,
  credentialHint,
  looksSecretShaped,
  redact,
  safeEqual,
  summarizeProviderMessage,
} from './security/index.js';

export {
  assertSafeEndpoint,
  assertSafeHostname,
  isBlockedAddress,
  isBlockedIpv4,
  isBlockedIpv6,
  joinEndpoint,
  type SsrfGuardOptions,
} from './ssrf/index.js';

export {
  createGatewayCodingDecisionSource,
  createGatewayDecisionSource,
  createGatewayDocumentProvider,
  createGatewaySynthesisProvider,
  extractJsonObject,
  isNoProviderError,
  providerDisclosure,
  type AgentDecisionShape,
  type BridgeOptions,
  type DocumentProviderBridgeOptions,
} from './bridges/index.js';
