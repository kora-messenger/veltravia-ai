import type { AIFinishReason } from './request.js';
import type { AIUsage } from './usage.js';

/**
 * Veltravia AI's own, provider-neutral response format.
 * Providers must normalize vendor responses into this shape, including
 * usage metadata (null when the provider reports none).
 */
export interface AIResponse {
  /** Generated content. Plain text (a JSON string when structuredOutput was requested). */
  readonly content: string;
  /** Provider that served the request (Veltravia provider id, not a vendor name). */
  readonly providerId: string;
  /** Model that served the request (Veltravia model id). */
  readonly modelId: string;
  /** Usage metadata, or null when unavailable. */
  readonly usage: AIUsage | null;
  /** Normalized finish reason. */
  readonly finishReason: AIFinishReason;
  /** Stable id for tracing this request. */
  readonly requestId: string;
  /** ISO-8601 UTC timestamp of generation. */
  readonly generatedAt: string;
}
