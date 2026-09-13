import { AIConfigurationError, ModelNotFoundError } from '../errors/index.js';
import type { AICapability, AIModelInfo } from '../types/index.js';

/**
 * The model registry: Veltravia AI's single source of truth for which models
 * exist, which provider owns them, what they can do, and whether they are
 * available. Routing decisions are always made from registry data.
 */
export class ModelRegistry {
  private readonly models = new Map<string, AIModelInfo>();

  /**
   * Registers a model. Model ids must be unique across the whole registry;
   * a duplicate id is a wiring error and throws AIConfigurationError.
   */
  registerModel(model: AIModelInfo): void {
    if (this.models.has(model.modelId)) {
      throw new AIConfigurationError(`Model already registered: ${model.modelId}`, {
        details: { modelId: model.modelId },
      });
    }
    this.models.set(model.modelId, model);
  }

  /** Registers several models at once. */
  registerModels(models: readonly AIModelInfo[]): void {
    for (const model of models) this.registerModel(model);
  }

  hasModel(modelId: string): boolean {
    return this.models.has(modelId);
  }

  /** Returns a model or throws ModelNotFoundError. */
  getModel(modelId: string): AIModelInfo {
    const model = this.tryGetModel(modelId);
    if (model === undefined) {
      throw new ModelNotFoundError(`Unknown model: ${modelId}`, {
        details: { modelId },
      });
    }
    return model;
  }

  /** Returns a model or undefined - for callers that prefer soft failures. */
  tryGetModel(modelId: string): AIModelInfo | undefined {
    return this.models.get(modelId);
  }

  /** All registered models, in registration order. */
  listModels(): AIModelInfo[] {
    return [...this.models.values()];
  }

  /** Models that declare ALL of the given capabilities, in registration order. */
  findModelsByCapabilities(capabilities: readonly AICapability[]): AIModelInfo[] {
    return this.listModels().filter((model) =>
      capabilities.every((capability) => model.capabilities.includes(capability)),
    );
  }

  /** Whether a given model declares a given capability. */
  modelHasCapability(modelId: string, capability: AICapability): boolean {
    return this.tryGetModel(modelId)?.capabilities.includes(capability) ?? false;
  }
}
