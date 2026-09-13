import type { AICapability } from './capabilities.js';
import type { AIMessage } from './message.js';

/**
 * Requirement for a structured (JSON) response. `schema` is an optional
 * JSON-Schema-like object; providers that support structured output use it
 * as a hint, the core never assumes full schema enforcement.
 */
export interface AIStructuredOutput {
  readonly name: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

/**
 * Veltravia AI's own, provider-neutral request format.
 * Every future provider adapter translates to/from this shape - vendor API
 * formats never leak into application code.
 */
export interface AIRequest {
  /** Conversation messages. Required; at least one. */
  readonly messages: readonly AIMessage[];
  /** System instructions, prepended by the router semantics. */
  readonly system?: string;
  /** Explicit model id; skips routing. */
  readonly model?: string;
  /** Capabilities the task requires; used by the router when `model` is not set. */
  readonly capabilities?: readonly AICapability[];
  /** Sampling temperature, 0..2, where the provider supports it. */
  readonly temperature?: number;
  /** Output token limit, where the provider supports it. */
  readonly maxOutputTokens?: number;
  /** Request for a structured JSON response. */
  readonly structuredOutput?: AIStructuredOutput;
}

/** Why generation finished, in normalized terms. */
export type AIFinishReason = 'stop' | 'length' | 'content-filter' | 'error' | 'unknown';
