import { readEnv, readIntEnv, readBoolEnv, type EnvSource } from '@veltravia/config';

/**
 * Gemini adapter configuration. This is the ONLY place the Gemini API key is
 * read from the environment - it is never hard-coded, never logged, never
 * returned in responses, and never committed to Git.
 *
 * The key lives in the server environment (or a future secret manager) and is
 * passed to the Google SDK client at construction time. Nothing else in
 * Veltravia AI sees it.
 */
export interface GeminiConfig {
  /** Server-side API key. Undefined means the adapter cannot call Gemini. */
  readonly apiKey?: string;
  /** Default Gemini model id used when registering/previewing the adapter. */
  readonly defaultModel: string;
  /** Per-request timeout, forwarded to the SDK client's HTTP options. */
  readonly requestTimeoutMs: number;
  /** Master switch: when false the adapter must not be registered at all. */
  readonly enabled: boolean;
  /**
   * Whether Gemini may persist interactions server-side (Interactions API
   * `store` parameter). Veltravia sends the full conversation history with
   * each request (stateless), so storage is OFF by default. Turning it on is
   * a prerequisite for the future `previous_interaction_id` stateful mode.
   */
  readonly storeInteractions: boolean;
  /** Default thinking level forwarded in generation_config, if set. */
  readonly thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

/** Partial config used by resolveGeminiConfig (tests inject partials). */
export type GeminiConfigOverrides = Partial<GeminiConfig>;

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Fills in defaults for anything a caller (or the environment) leaves unset. */
export function resolveGeminiConfig(overrides?: GeminiConfigOverrides): GeminiConfig {
  const apiKey = overrides?.apiKey;
  return {
    apiKey: apiKey === '' ? undefined : apiKey,
    defaultModel: overrides?.defaultModel ?? DEFAULT_GEMINI_MODEL,
    requestTimeoutMs: overrides?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    enabled: overrides?.enabled ?? true,
    storeInteractions: overrides?.storeInteractions ?? false,
    thinkingLevel: overrides?.thinkingLevel,
  };
}

/**
 * Reads the Gemini configuration from environment variables:
 * GEMINI_API_KEY, GEMINI_MODEL, GEMINI_REQUEST_TIMEOUT_MS, GEMINI_ENABLED,
 * GEMINI_STORE_INTERACTIONS, GEMINI_THINKING_LEVEL.
 *
 * The provider is considered "available" only when enabled AND a key exists.
 * Callers use this to decide whether to register the adapter at all.
 */
export function loadGeminiConfig(opts?: EnvSource): GeminiConfig {
  const config = resolveGeminiConfig({
    apiKey: readEnv('GEMINI_API_KEY', opts),
    defaultModel: readEnv('GEMINI_MODEL', opts),
    requestTimeoutMs: readIntEnv('GEMINI_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, opts),
    enabled: readBoolEnv('GEMINI_ENABLED', true, opts),
    storeInteractions: readBoolEnv('GEMINI_STORE_INTERACTIONS', false, opts),
    thinkingLevel: readEnv('GEMINI_THINKING_LEVEL', opts) as GeminiConfig['thinkingLevel'],
  });
  return config;
}

/** Whether the adapter can serve requests: enabled AND has a key. */
export function isGeminiAvailable(config: GeminiConfig): boolean {
  return config.enabled && typeof config.apiKey === 'string' && config.apiKey.length > 0;
}
