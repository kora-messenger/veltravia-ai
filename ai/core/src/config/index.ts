import { readEnv, readIntEnv, type EnvSource } from '@veltravia/config';

/**
 * AI Core configuration. Secrets are deliberately absent: API keys will live
 * in the secret manager and be bound inside provider adapters, never here.
 */
export interface AIConfig {
  /** Preferred provider for ties during capability-based routing. */
  readonly defaultProvider?: string;
  /** Default model, used when a request does not specify one. */
  readonly defaultModel?: string;
  /** Enabled provider ids. Empty means "all registered providers". */
  readonly enabledProviders: readonly string[];
  /** Maximum number of input messages per request. */
  readonly maxInputMessages: number;
  /** Maximum characters per message / system instruction. */
  readonly maxInputChars: number;
  /** Per-request timeout. Enforcement starts with the first real adapter. */
  readonly requestTimeoutMs: number;
}

export interface AIConfigOverrides extends Partial<Omit<AIConfig, 'enabledProviders'>> {
  readonly enabledProviders?: readonly string[];
}

const DEFAULT_MAX_INPUT_MESSAGES = 100;
const DEFAULT_MAX_INPUT_CHARS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Fills in defaults for anything a caller (or the environment) leaves unset. */
export function resolveAIConfig(overrides?: AIConfigOverrides): AIConfig {
  return {
    defaultProvider: overrides?.defaultProvider,
    defaultModel: overrides?.defaultModel,
    enabledProviders: overrides?.enabledProviders ?? [],
    maxInputMessages: overrides?.maxInputMessages ?? DEFAULT_MAX_INPUT_MESSAGES,
    maxInputChars: overrides?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
    requestTimeoutMs: overrides?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

/**
 * Builds the AI configuration from environment variables (via @veltravia/config).
 * Reads AI_DEFAULT_PROVIDER, AI_DEFAULT_MODEL, AI_ENABLED_PROVIDERS (comma list),
 * AI_MAX_INPUT_MESSAGES, AI_MAX_INPUT_CHARS, AI_REQUEST_TIMEOUT_MS.
 */
export function loadAIConfig(opts?: EnvSource): AIConfig {
  const enabledRaw = readEnv('AI_ENABLED_PROVIDERS', opts);
  const enabledProviders = enabledRaw
    ? enabledRaw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  return resolveAIConfig({
    defaultProvider: readEnv('AI_DEFAULT_PROVIDER', opts),
    defaultModel: readEnv('AI_DEFAULT_MODEL', opts),
    enabledProviders,
    maxInputMessages: readIntEnv('AI_MAX_INPUT_MESSAGES', DEFAULT_MAX_INPUT_MESSAGES, opts),
    maxInputChars: readIntEnv('AI_MAX_INPUT_CHARS', DEFAULT_MAX_INPUT_CHARS, opts),
    requestTimeoutMs: readIntEnv('AI_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, opts),
  });
}
