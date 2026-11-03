import type { PromptCategory } from './prompt-category.js';

/**
 * Which model suits which kind of request, in the order to try them.
 *
 * Why a table: the models we can reach through one provider all declare the
 * same capabilities, so the router's capability scoring cannot tell a coding
 * model from a chat model. This says it directly. Entries are model ids, tried
 * in order; the first one the owner has connected and can use wins.
 *
 * Every id here was listed by its provider with a working key. A model that is
 * not connected is simply skipped, and if nothing matches the router decides
 * as it did before, so this can only improve a choice, never remove one.
 */
export interface ModelPick {
  readonly providerId: string;
  readonly modelId: string;
}

export const MODEL_PREFERENCES: Readonly<Record<PromptCategory, readonly ModelPick[]>> = {
  // Quick, cheap, good enough for everyday questions. Standing default: gpt-4o-mini.
  'general-conversation': [
    { providerId: 'openai', modelId: 'gpt-4o-mini' },
    { providerId: 'groq', modelId: 'openai/gpt-oss-20b' },
    { providerId: 'mistral', modelId: 'mistral-small-latest' },
  ],
  // Source code, errors, scripts.
  coding: [
    { providerId: 'openai', modelId: 'gpt-4.1' },
    { providerId: 'mistral', modelId: 'codestral-latest' },
    { providerId: 'groq', modelId: 'openai/gpt-oss-120b' },
    { providerId: 'openai', modelId: 'gpt-4o-mini' },
  ],
  // Multi-part, analytical, long.
  'complex-reasoning': [
    { providerId: 'openai', modelId: 'gpt-4.1' },
    { providerId: 'groq', modelId: 'openai/gpt-oss-120b' },
    { providerId: 'mistral', modelId: 'mistral-large-4' },
    { providerId: 'openai', modelId: 'gpt-4o' },
  ],
  // Needs a model that accepts pictures.
  'image-understanding': [
    { providerId: 'openai', modelId: 'gpt-4o' },
    { providerId: 'openai', modelId: 'gpt-4o-mini' },
    { providerId: 'openai', modelId: 'gpt-4.1' },
  ],
};

/** A model the owner has connected and can use right now. */
export interface UsableModel {
  readonly connectionId: string;
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * The first preferred model the owner actually has, or null when none match
 * (the caller then lets the router choose).
 */
export function pickModelFor(
  category: PromptCategory,
  usable: readonly UsableModel[],
): UsableModel | null {
  for (const wanted of MODEL_PREFERENCES[category]) {
    const found = usable.find(
      (model) => model.providerId === wanted.providerId && model.modelId === wanted.modelId,
    );
    if (found !== undefined) return found;
  }
  return null;
}
