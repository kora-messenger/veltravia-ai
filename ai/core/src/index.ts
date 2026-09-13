/**
 * @veltravia/ai-core - the provider-neutral AI abstraction layer of
 * Veltravia AI. Everything AI-related in the platform builds on these types
 * and this interface; no vendor SDK or vendor response format ever passes
 * through this boundary.
 */

// Core facade
export { AICore, type AICoreOptions } from './core.js';

// Types
export type {
  AICapability,
  AIMessage,
  AIMessageRole,
  AIModelInfo,
  AIRequest,
  AIResponse,
  AIStructuredOutput,
  AIFinishReason,
  AIUsage,
} from './types/index.js';
export { AI_CAPABILITIES, isAICapability, isAICapabilityArray } from './types/index.js';

// Provider interface
export { type AIProvider } from './provider/index.js';

// Registry
export { ModelRegistry } from './registry/index.js';

// Router
export {
  AIRouter,
  type AIRouterDeps,
  type AIRouteDecision,
  DEFAULT_REQUEST_CAPABILITY,
} from './router/index.js';

// Errors
export {
  AIError,
  type AIErrorCode,
  type AIErrorOptions,
  InvalidAIRequestError,
  ProviderNotFoundError,
  ModelNotFoundError,
  CapabilityNotSupportedError,
  AIProviderError,
  AIConfigurationError,
  isAIError,
} from './errors/index.js';

// Configuration
export {
  resolveAIConfig,
  loadAIConfig,
  type AIConfig,
  type AIConfigOverrides,
} from './config/index.js';

// Validation
export { validateAIRequest } from './validation.js';
