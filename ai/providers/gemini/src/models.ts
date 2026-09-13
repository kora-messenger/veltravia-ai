import type { AIModelInfo } from '@veltravia/ai-core';
import { DEFAULT_GEMINI_MODEL } from './config.js';

/**
 * Registry entries for the Gemini models the adapter supports. Model ids are
 * Veltravia's registry keys and map 1:1 to Gemini's official model ids, so
 * changing the default model is a configuration change (GEMINI_MODEL), not a
 * redesign. Both entries are currently supported Gemini models verified
 * against Google's official model documentation (ai.google.dev/gemini-api/docs).
 */
export function createGeminiModels(defaultModel: string = DEFAULT_GEMINI_MODEL): AIModelInfo[] {
  const models: AIModelInfo[] = [
    {
      providerId: 'gemini',
      modelId: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      capabilities: ['text-generation', 'code-generation', 'structured-output'],
      available: true,
      metadata: { api: 'gemini-interactions', provider: 'google' },
    },
    {
      providerId: 'gemini',
      modelId: 'gemini-3.1-pro-preview',
      displayName: 'Gemini 3.1 Pro (Preview)',
      capabilities: ['text-generation', 'code-generation', 'structured-output'],
      available: true,
      metadata: { api: 'gemini-interactions', provider: 'google', preview: true },
    },
  ];

  // The configured default model is always registered (and first).
  if (defaultModel !== DEFAULT_GEMINI_MODEL && !models.some((m) => m.modelId === defaultModel)) {
    models.unshift({
      providerId: 'gemini',
      modelId: defaultModel,
      displayName: `Gemini (${defaultModel})`,
      capabilities: ['text-generation', 'code-generation', 'structured-output'],
      available: true,
      metadata: { api: 'gemini-interactions', provider: 'google', configuredDefault: true },
    });
  }
  return models;
}
