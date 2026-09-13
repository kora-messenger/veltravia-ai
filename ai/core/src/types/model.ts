import type { AICapability } from './capabilities.js';

/**
 * A model entry in the registry. Model ids are unique across the registry;
 * every model belongs to exactly one provider.
 */
export interface AIModelInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly capabilities: readonly AICapability[];
  /** Maximum context window, when known. */
  readonly contextWindowTokens?: number;
  /** Maximum output tokens, when known. */
  readonly maxOutputTokens?: number;
  /** Whether the model can currently serve requests. */
  readonly available: boolean;
  /** Free-form configuration metadata (plain scalars only). */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}
