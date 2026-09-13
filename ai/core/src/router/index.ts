import type { AIConfig } from '../config/index.js';
import {
  CapabilityNotSupportedError,
  ModelNotFoundError,
  ProviderNotFoundError,
} from '../errors/index.js';
import type { AIProvider } from '../provider/index.js';
import type { ModelRegistry } from '../registry/index.js';
import type { AICapability, AIModelInfo, AIRequest } from '../types/index.js';

/** Everything the router needs to make a decision. */
export interface AIRouterDeps {
  readonly registry: ModelRegistry;
  readonly providers: ReadonlyMap<string, AIProvider>;
  readonly config: AIConfig;
}

/** A routing decision: the provider instance plus the model it will serve. */
export interface AIRouteDecision {
  readonly provider: AIProvider;
  readonly model: AIModelInfo;
}

/** Capability assumed when a request does not name any. */
export const DEFAULT_REQUEST_CAPABILITY: AICapability = 'text-generation';

/**
 * Deterministic router. Selection rules (in order):
 *  1. request.model  - exact model, must exist, be available, be enabled and capable
 *  2. config.defaultModel - same checks as (1)
 *  3. capability scan - first registered, available, enabled model declaring
 *     all required capabilities; models of config.defaultProvider win ties
 *
 * If nothing matches, a typed error is thrown. No scoring, no heuristics yet -
 * those come with real providers in a later step.
 */
export class AIRouter {
  private readonly registry: ModelRegistry;
  private readonly providers: ReadonlyMap<string, AIProvider>;
  private readonly config: AIConfig;

  constructor(deps: AIRouterDeps) {
    this.registry = deps.registry;
    this.providers = deps.providers;
    this.config = deps.config;
  }

  select(request: AIRequest): AIRouteDecision {
    if (request.model !== undefined) {
      return this.decideForModel(request.model, request);
    }
    if (this.config.defaultModel !== undefined) {
      return this.decideForModel(this.config.defaultModel, request);
    }
    return this.decideByCapabilities(request);
  }

  private decideForModel(modelId: string, request: AIRequest): AIRouteDecision {
    const model = this.registry.getModel(modelId);
    if (!model.available) {
      throw new ModelNotFoundError(`Model is not available: ${modelId}`, {
        details: { modelId },
      });
    }
    const provider = this.resolveProvider(model);
    this.assertCapabilities(model, request);
    return { provider, model };
  }

  private decideByCapabilities(request: AIRequest): AIRouteDecision {
    const required =
      request.capabilities === undefined || request.capabilities.length === 0
        ? [DEFAULT_REQUEST_CAPABILITY]
        : request.capabilities;

    const candidates = this.registry
      .findModelsByCapabilities(required)
      .filter(
        (model) =>
          model.available && this.isProviderEnabled(model) && this.providers.has(model.providerId),
      );

    if (candidates.length === 0) {
      throw new CapabilityNotSupportedError(
        `No available model supports the requested capabilities: ${required.join(', ')}`,
        { details: { requiredCapabilities: required } },
      );
    }

    // Deterministic tiebreak: the default provider's models come first,
    // otherwise registration order decides.
    const preferred = this.config.defaultProvider;
    const ordered = preferred
      ? [
          ...candidates.filter((model) => model.providerId === preferred),
          ...candidates.filter((model) => model.providerId !== preferred),
        ]
      : candidates;

    const model = ordered[0];
    if (model === undefined) {
      throw new CapabilityNotSupportedError(
        `No available model supports the requested capabilities: ${required.join(', ')}`,
        { details: { requiredCapabilities: required } },
      );
    }
    const provider = this.resolveProvider(model);
    return { provider, model };
  }

  private resolveProvider(model: AIModelInfo): AIProvider {
    if (!this.isProviderEnabled(model)) {
      throw new ProviderNotFoundError(`Provider is not enabled: ${model.providerId}`, {
        details: { providerId: model.providerId },
      });
    }
    const provider = this.providers.get(model.providerId);
    if (provider === undefined) {
      throw new ProviderNotFoundError(`No provider instance registered for: ${model.providerId}`, {
        details: { providerId: model.providerId },
      });
    }
    return provider;
  }

  private isProviderEnabled(model: AIModelInfo): boolean {
    const { enabledProviders } = this.config;
    return enabledProviders.length === 0 || enabledProviders.includes(model.providerId);
  }

  private assertCapabilities(model: AIModelInfo, request: AIRequest): void {
    const required =
      request.capabilities === undefined || request.capabilities.length === 0
        ? [DEFAULT_REQUEST_CAPABILITY]
        : request.capabilities;

    const missing = required.filter((capability) => !model.capabilities.includes(capability));
    if (missing.length > 0) {
      throw new CapabilityNotSupportedError(
        `Model ${model.modelId} does not support: ${missing.join(', ')}`,
        { details: { modelId: model.modelId, missingCapabilities: missing } },
      );
    }
  }
}
