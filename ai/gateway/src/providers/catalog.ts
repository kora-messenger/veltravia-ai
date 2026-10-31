import type { ProviderDefinition } from '../types/index.js';

/**
 * The provider catalog (Step 26).
 *
 * A declaration here is a claim about the ADAPTER, not about any model. Model
 * capabilities come from discovery or from a model id the owner supplies, so a
 * vendor shipping a new model never makes this file wrong.
 *
 * Deliberately absent from every provider: pricing. Veltravia does not invent
 * costs, so `estimatedCostUsd` stays null unless a deployment adds reliable
 * pricing metadata of its own.
 */

function openAiCompatible(
  input: Omit<ProviderDefinition, 'adapter' | 'authParameter'> & {
    readonly authParameter?: string;
  },
): ProviderDefinition {
  return {
    ...input,
    adapter: 'openai-compatible',
    authParameter: input.authParameter ?? 'api_key',
  };
}

export const OPENAI_PROVIDER: ProviderDefinition = openAiCompatible({
  id: 'openai',
  displayName: 'OpenAI',
  description: 'Official OpenAI API. Keys are sent to api.openai.com only.',
  baseUrl: 'https://api.openai.com/v1',
  generationPath: '/chat/completions',
  modelsPath: '/models',
  auth: 'bearer',
  authParameter: 'api_key',
  capabilities: [
    'text-generation',
    'streaming',
    'structured-output',
    'vision',
    'model-discovery',
    'credential-validation',
  ],
  modelCapabilities: ['text-generation', 'structured-output', 'streaming', 'vision'],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://platform.openai.com/api-keys',
});

export const GEMINI_PROVIDER: ProviderDefinition = {
  id: 'gemini',
  displayName: 'Google Gemini',
  description: 'Google Generative Language REST API, called with your own key.',
  adapter: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  generationPath: '/models',
  modelsPath: '/models',
  auth: 'x-goog-api-key',
  authParameter: 'key',
  capabilities: [
    'text-generation',
    'streaming',
    'structured-output',
    'vision',
    'model-discovery',
    'credential-validation',
  ],
  modelCapabilities: [
    'text-generation',
    'streaming',
    'structured-output',
    'vision',
    'large-context',
  ],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://aistudio.google.com/app/apikey',
};

export const ANTHROPIC_PROVIDER: ProviderDefinition = {
  id: 'anthropic',
  displayName: 'Anthropic Claude',
  description: 'Anthropic Messages API. Keys are sent to api.anthropic.com only.',
  adapter: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  generationPath: '/messages',
  modelsPath: '/models',
  auth: 'x-api-key',
  authParameter: 'x-api-key',
  capabilities: ['text-generation', 'streaming', 'model-discovery', 'credential-validation'],
  modelCapabilities: ['text-generation', 'streaming', 'large-context'],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://console.anthropic.com/settings/keys',
};

export const DEEPSEEK_PROVIDER: ProviderDefinition = openAiCompatible({
  id: 'deepseek',
  displayName: 'DeepSeek',
  description: 'DeepSeek OpenAI-compatible API.',
  baseUrl: 'https://api.deepseek.com',
  generationPath: '/chat/completions',
  modelsPath: '/models',
  auth: 'bearer',
  capabilities: [
    'text-generation',
    'streaming',
    'model-discovery',
    'credential-validation',
    'structured-output',
  ],
  modelCapabilities: ['text-generation', 'streaming', 'structured-output'],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://platform.deepseek.com/api_keys',
});

export const XAI_PROVIDER: ProviderDefinition = openAiCompatible({
  id: 'xai',
  displayName: 'xAI Grok',
  description: 'xAI OpenAI-compatible API.',
  baseUrl: 'https://api.x.ai/v1',
  generationPath: '/chat/completions',
  modelsPath: '/models',
  auth: 'bearer',
  capabilities: ['text-generation', 'streaming', 'model-discovery', 'credential-validation'],
  modelCapabilities: ['text-generation', 'streaming'],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://console.x.ai',
});

export const OPENROUTER_PROVIDER: ProviderDefinition = openAiCompatible({
  id: 'openrouter',
  displayName: 'OpenRouter',
  description: 'OpenRouter gateway; model ids keep their vendor prefix (e.g. vendor/model).',
  baseUrl: 'https://openrouter.ai/api/v1',
  generationPath: '/chat/completions',
  modelsPath: '/models',
  auth: 'bearer',
  capabilities: [
    'text-generation',
    'streaming',
    'structured-output',
    'model-discovery',
    'credential-validation',
  ],
  modelCapabilities: ['text-generation', 'streaming', 'structured-output'],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://openrouter.ai/keys',
});

export const MISTRAL_PROVIDER: ProviderDefinition = openAiCompatible({
  id: 'mistral',
  displayName: 'Mistral AI',
  description: 'Mistral OpenAI-compatible API.',
  baseUrl: 'https://api.mistral.ai/v1',
  generationPath: '/chat/completions',
  modelsPath: '/models',
  auth: 'bearer',
  capabilities: [
    'text-generation',
    'streaming',
    'structured-output',
    'model-discovery',
    'credential-validation',
  ],
  modelCapabilities: ['text-generation', 'streaming', 'structured-output'],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://console.mistral.ai/api-keys',
});

export const GROQ_PROVIDER: ProviderDefinition = openAiCompatible({
  id: 'groq',
  displayName: 'Groq',
  description: 'Groq Cloud OpenAI-compatible API.',
  baseUrl: 'https://api.groq.com/openai/v1',
  generationPath: '/chat/completions',
  modelsPath: '/models',
  auth: 'bearer',
  capabilities: [
    'text-generation',
    'streaming',
    'structured-output',
    'model-discovery',
    'credential-validation',
  ],
  modelCapabilities: ['text-generation', 'streaming', 'structured-output'],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://console.groq.com/keys',
});

export const TOGETHER_PROVIDER: ProviderDefinition = openAiCompatible({
  id: 'together',
  displayName: 'Together AI',
  description: 'Together AI OpenAI-compatible API.',
  baseUrl: 'https://api.together.xyz/v1',
  generationPath: '/chat/completions',
  modelsPath: '/models',
  auth: 'bearer',
  capabilities: ['text-generation', 'streaming', 'model-discovery', 'credential-validation'],
  modelCapabilities: ['text-generation', 'streaming'],
  allowsCustomBaseUrl: false,
  docsUrl: 'https://api.together.ai/settings/api-keys',
});

/**
 * Custom OpenAI-compatible provider. The owner supplies the base URL, so this
 * is the one entry the SSRF guard treats as untrusted input on every request.
 */
export const CUSTOM_OPENAI_COMPATIBLE_PROVIDER: ProviderDefinition = openAiCompatible({
  id: 'custom-openai-compatible',
  displayName: 'Custom (OpenAI-compatible)',
  description:
    'Any HTTPS endpoint that speaks the OpenAI chat-completions shape. The URL is revalidated on every request; private and loopback addresses are refused.',
  baseUrl: '',
  generationPath: '/chat/completions',
  modelsPath: '/models',
  auth: 'bearer',
  capabilities: ['text-generation', 'streaming', 'model-discovery', 'credential-validation'],
  modelCapabilities: ['text-generation', 'streaming'],
  allowsCustomBaseUrl: true,
});

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  OPENAI_PROVIDER,
  GEMINI_PROVIDER,
  ANTHROPIC_PROVIDER,
  DEEPSEEK_PROVIDER,
  XAI_PROVIDER,
  OPENROUTER_PROVIDER,
  MISTRAL_PROVIDER,
  GROQ_PROVIDER,
  TOGETHER_PROVIDER,
  CUSTOM_OPENAI_COMPATIBLE_PROVIDER,
];

export function findProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.id === id);
}

/** Safe catalog view for the UI: no secrets, no internal paths we do not need. */
export interface ProviderCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly modelCapabilities: readonly string[];
  readonly allowsCustomBaseUrl: boolean;
  readonly supportsDiscovery: boolean;
  readonly docsUrl: string | null;
  readonly authFormat: string;
}

export function catalogView(): readonly ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    description: provider.description,
    capabilities: [...provider.capabilities],
    modelCapabilities: [...provider.modelCapabilities],
    allowsCustomBaseUrl: provider.allowsCustomBaseUrl,
    supportsDiscovery: Boolean(provider.modelsPath),
    docsUrl: provider.docsUrl ?? null,
    authFormat: provider.auth,
  }));
}
