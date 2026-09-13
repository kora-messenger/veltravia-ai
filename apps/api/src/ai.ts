import { AICore, loadAIConfig, type AIConfigOverrides, type AIProvider } from '@veltravia/ai-core';
import { MockAIProvider, createMockModels } from '@veltravia/ai-provider-mock';
import {
  GeminiAIProvider,
  createGeminiModels,
  isGeminiAvailable,
  loadGeminiConfig,
} from '@veltravia/ai-provider-gemini';

/**
 * Builds the API's AICore instance.
 *
 * Providers are registered purely through the provider-neutral interface:
 * - the mock provider is ALWAYS registered (tests, development, offline use)
 * - the Gemini adapter is registered ONLY when GEMINI_API_KEY is present and
 *   GEMINI_ENABLED is not false. No key, no Gemini registration - the app
 *   boots and serves mock traffic without any credentials.
 *
 * When Gemini is configured it becomes the default provider/model (unless the
 * operator set AI_DEFAULT_MODEL / AI_DEFAULT_PROVIDER explicitly). Adding a
 * future provider means adding one entry here; nothing else changes. Secrets
 * are read only to be handed to the adapter - never logged, never returned.
 */
export function createAICore(now: () => Date = () => new Date()): AICore {
  const geminiConfig = loadGeminiConfig();
  const geminiAvailable = isGeminiAvailable(geminiConfig);

  const providers: readonly AIProvider[] = [
    new MockAIProvider({ now }),
    ...(geminiAvailable ? [new GeminiAIProvider({ config: geminiConfig })] : []),
  ];

  let configOverrides: AIConfigOverrides | undefined;
  if (geminiAvailable) {
    const envConfig = loadAIConfig();
    configOverrides = {
      ...envConfig,
      defaultProvider: envConfig.defaultProvider ?? 'gemini',
      defaultModel: envConfig.defaultModel ?? geminiConfig.defaultModel,
    };
  }

  const core = new AICore({
    providers,
    config: configOverrides ?? loadAIConfig(),
  });

  core.registry.registerModels(createMockModels());
  if (geminiAvailable) {
    core.registry.registerModels(createGeminiModels(geminiConfig.defaultModel));
  }
  return core;
}
