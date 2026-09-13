import { describe, expect, it } from 'vitest';
import { AIConfigurationError, ModelNotFoundError } from '../errors';
import type { AIModelInfo } from '../types';
import { ModelRegistry } from './index';

const model = (overrides: Partial<AIModelInfo> = {}): AIModelInfo => ({
  providerId: 'mock',
  modelId: 'test-model',
  capabilities: ['text-generation'],
  available: true,
  ...overrides,
});

describe('ModelRegistry', () => {
  it('registers and retrieves models', () => {
    const registry = new ModelRegistry();
    registry.registerModel(model());
    expect(registry.hasModel('test-model')).toBe(true);
    expect(registry.getModel('test-model').providerId).toBe('mock');
  });

  it('throws ModelNotFoundError for unknown models', () => {
    const registry = new ModelRegistry();
    expect(() => registry.getModel('ghost')).toThrow(ModelNotFoundError);
    expect(() => registry.getModel('ghost')).toThrow(/ghost/);
  });

  it('offers a soft-failure lookup via tryGetModel', () => {
    const registry = new ModelRegistry();
    expect(registry.tryGetModel('ghost')).toBeUndefined();
    registry.registerModel(model());
    expect(registry.tryGetModel('test-model')?.modelId).toBe('test-model');
  });

  it('rejects duplicate model ids with a configuration error', () => {
    const registry = new ModelRegistry();
    registry.registerModel(model());
    expect(() => registry.registerModel(model())).toThrow(AIConfigurationError);
  });

  it('reports models by capability and per-model capability checks', () => {
    const registry = new ModelRegistry();
    registry.registerModels([
      model({ modelId: 'text-only' }),
      model({ modelId: 'vision', capabilities: ['text-generation', 'vision'] }),
      model({ modelId: 'offline', available: false }),
    ]);

    expect(registry.modelHasCapability('vision', 'vision')).toBe(true);
    expect(registry.modelHasCapability('vision', 'embeddings')).toBe(false);
    expect(registry.modelHasCapability('ghost', 'vision')).toBe(false);

    const byCaps = registry.findModelsByCapabilities(['text-generation', 'vision']);
    expect(byCaps.map((m) => m.modelId)).toEqual(['vision']);
  });

  it('lists models in registration order', () => {
    const registry = new ModelRegistry();
    registry.registerModels([
      model({ modelId: 'a' }),
      model({ modelId: 'b' }),
      model({ modelId: 'c' }),
    ]);
    expect(registry.listModels().map((m) => m.modelId)).toEqual(['a', 'b', 'c']);
  });
});
