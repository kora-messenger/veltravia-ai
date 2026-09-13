/**
 * @veltravia/ai-provider-gemini - the official Gemini adapter for Veltravia AI.
 *
 * Implements the provider-neutral AIProvider interface from @veltravia/ai-core
 * on top of Google's CURRENT recommended Gemini interface, the Interactions
 * API (GA June 2026), via the official @google/genai SDK. This package is the
 * ONLY code in Veltravia AI that knows Gemini-specific details: the AI Core,
 * the router, the API layer, and the web app only ever see normalized types.
 */

export {
  GeminiAIProvider,
  type GeminiAIProviderOptions,
  type GeminiClientLike,
} from './provider.js';
export {
  DEFAULT_GEMINI_MODEL,
  isGeminiAvailable,
  loadGeminiConfig,
  resolveGeminiConfig,
  type GeminiConfig,
  type GeminiConfigOverrides,
} from './config.js';
export { createGeminiModels } from './models.js';
export {
  toGeminiInteraction,
  fromGeminiInteraction,
  extractOutputText,
  mapGeminiUsage,
  mapFinishReason,
  type GeminiCreateInteraction,
  type GeminiInteractionResult,
  type GeminiStep,
  type GeminiTextContent,
  type GeminiRequestOptions,
} from './mapping.js';
export { normalizeGeminiError, redactSecret } from './errors.js';
export {
  isRetryableGeminiError,
  NoRetryPolicy,
  ConservativeRetryPolicy,
  type GeminiRetryPolicy,
  type RetryDecision,
} from './retry.js';
