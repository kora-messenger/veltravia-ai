import { resolveAIConfig, type AIConfig, type AIConfigOverrides } from './config/index.js';
import { AIProviderError, isAIError } from './errors/index.js';
import type { AIProvider } from './provider/index.js';
import { ModelRegistry } from './registry/index.js';
import { AIRouter, type AIRouteDecision } from './router/index.js';
import type { AIModelInfo, AIResponse } from './types/index.js';
import { validateAIRequest } from './validation.js';

/** Constructor options for AICore. */
export interface AICoreOptions {
  readonly registry?: ModelRegistry;
  readonly providers?: readonly AIProvider[];
  readonly config?: AIConfigOverrides;
}

/**
 * The AI Core facade - the single entry point the rest of Veltravia AI uses.
 * Everything behind it (validation, routing, providers) stays swappable.
 */
export class AICore {
  readonly registry: ModelRegistry;
  readonly config: AIConfig;
  private readonly providers: ReadonlyMap<string, AIProvider>;
  private readonly router: AIRouter;

  constructor(options: AICoreOptions = {}) {
    const providers = options.providers ?? [];
    const seen = new Set<string>();
    for (const provider of providers) {
      if (seen.has(provider.id)) {
        throw new Error(`Duplicate provider id: ${provider.id}`);
      }
      seen.add(provider.id);
    }
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.registry = options.registry ?? new ModelRegistry();
    this.config = resolveAIConfig(options.config);
    this.router = new AIRouter({
      registry: this.registry,
      providers: this.providers,
      config: this.config,
    });
  }

  /**
   * Validates the request, routes it to a provider/model, executes it and
   * returns the normalized response. Provider failures are normalized into
   * AIError subclasses - vendor-specific errors never escape this call.
   */
  async generate(value: unknown): Promise<AIResponse> {
    const request = validateAIRequest(value, this.config);
    const decision: AIRouteDecision = this.router.select(request);
    try {
      return await decision.provider.send(request, decision.model);
    } catch (error) {
      if (isAIError(error)) throw error;
      throw new AIProviderError(`Provider ${decision.provider.id} failed`, {
        details: { providerId: decision.provider.id, modelId: decision.model.modelId },
        cause: error,
      });
    }
  }

  /** All registered models (registry order) - for diagnostics and the future UI. */
  listModels(): AIModelInfo[] {
    return this.registry.listModels();
  }
}
