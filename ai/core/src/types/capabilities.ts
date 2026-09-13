/**
 * Every capability a model can expose. Providers declare their models'
 * capabilities in the registry, and the router checks them before routing -
 * Veltravia AI never assumes a model can do something it has not declared.
 */
export const AI_CAPABILITIES = [
  'text-generation',
  'structured-output',
  'streaming',
  'vision',
  'image-generation',
  'tool-calling',
  'embeddings',
  'audio-input',
  'audio-output',
  'large-context',
  'code-generation',
] as const;

export type AICapability = (typeof AI_CAPABILITIES)[number];

/** Type guard for a single capability string. */
export function isAICapability(value: unknown): value is AICapability {
  return typeof value === 'string' && (AI_CAPABILITIES as readonly string[]).includes(value);
}

/** Type guard for an array of capability strings. */
export function isAICapabilityArray(value: unknown): value is AICapability[] {
  return Array.isArray(value) && value.every((entry) => isAICapability(entry));
}
