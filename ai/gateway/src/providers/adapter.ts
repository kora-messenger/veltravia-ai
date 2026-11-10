import type {
  AICapability,
  AIFinishReason,
  AIMessage,
  AIStructuredOutput,
} from '@veltravia/ai-core';

import type { GatewayModel, ProviderDefinition } from '../types/index.js';
import type { ProviderTransport } from './transport.js';

/**
 * The adapter contract every provider implements. Adapters are the ONLY place
 * vendor request/response shapes exist; everything above sees normalized
 * results and normalized errors.
 */

export interface AdapterContext {
  /** Decrypted for this request only. Never stored on the adapter. */
  readonly apiKey: string;
  /** Validated base URL (catalog default or owner-supplied custom endpoint). */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly transport: ProviderTransport;
  /** Custom auth format override, for OpenAI-compatible endpoints. */
  readonly authFormatOverride?: 'bearer' | 'x-api-key' | 'query-key';
  /** Aborted when the caller cancels; adapters pass it to the transport. */
  readonly signal?: AbortSignal;
  /** Abort an idle stream after this long. Defaults to the request timeout. */
  readonly idleTimeoutMs?: number;
}

export interface AdapterRequest {
  readonly modelId: string;
  readonly messages: readonly AIMessage[];
  readonly system?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly structuredOutput?: AIStructuredOutput;
  /** Capabilities the caller declared the task needs. */
  readonly requiredCapabilities?: readonly AICapability[];
}

export interface AdapterUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Subset of inputTokens served from the provider's cache; null when unreported. */
  readonly cachedInputTokens?: number | null;
}

export interface AdapterResult {
  readonly content: string;
  readonly finishReason: AIFinishReason;
  readonly usage: AdapterUsage;
}

/**
 * One streamed fragment. `usage` and `finishReason` arrive on the terminal
 * chunk when the vendor reports them; they are never synthesized upstream.
 */
export interface AdapterChunk {
  readonly delta: string;
  readonly done: boolean;
  readonly usage?: AdapterUsage;
  readonly finishReason?: AIFinishReason;
}

export interface CredentialValidationResult {
  readonly valid: boolean;
  /** Normalized category when invalid - never provider text. */
  readonly errorCategory?: string;
  /** Models discovered during validation, when the provider supports it. */
  readonly models?: readonly GatewayModel[];
}

export interface ProviderAdapter {
  readonly definition: ProviderDefinition;
  /** True when the adapter can list models over the network. */
  readonly supportsDiscovery: boolean;
  validateCredential(context: AdapterContext): Promise<CredentialValidationResult>;
  discoverModels(context: AdapterContext): Promise<readonly GatewayModel[]>;
  generate(context: AdapterContext, request: AdapterRequest): Promise<AdapterResult>;
  /** Present only when the adapter implements streaming. */
  stream?(context: AdapterContext, request: AdapterRequest): AsyncIterable<AdapterChunk>;
}
