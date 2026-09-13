import { describe, expect, it } from 'vitest';
import {
  AIError,
  AIConfigurationError,
  AIProviderError,
  CapabilityNotSupportedError,
  InvalidAIRequestError,
  ModelNotFoundError,
  ProviderNotFoundError,
  isAIError,
} from './index';

describe('AI error system', () => {
  it('gives each error class a stable machine-readable code', () => {
    expect(new InvalidAIRequestError('x').code).toBe('AI_INVALID_REQUEST');
    expect(new ProviderNotFoundError('x').code).toBe('AI_PROVIDER_NOT_FOUND');
    expect(new ModelNotFoundError('x').code).toBe('AI_MODEL_NOT_FOUND');
    expect(new CapabilityNotSupportedError('x').code).toBe('AI_CAPABILITY_NOT_SUPPORTED');
    expect(new AIProviderError('x').code).toBe('AI_PROVIDER_ERROR');
    expect(new AIConfigurationError('x').code).toBe('AI_CONFIGURATION_ERROR');
  });

  it('carries structured details and serializes without a stack trace', () => {
    const error = new ModelNotFoundError('Unknown model: nope', {
      details: { modelId: 'nope' },
    });
    expect(error.details).toEqual({ modelId: 'nope' });
    const json = error.toJSON();
    expect(json).toEqual({
      code: 'AI_MODEL_NOT_FOUND',
      message: 'Unknown model: nope',
      details: { modelId: 'nope' },
    });
    expect(JSON.stringify(json)).not.toContain('at ');
  });

  it('preserves the cause for wrapped provider failures', () => {
    const cause = new Error('vendor blew up');
    const error = new AIProviderError('Provider failed', { cause });
    expect((error.cause as Error).message).toBe('vendor blew up');
  });

  it('is recognized by the type guard and instanceof across packages', () => {
    const error: unknown = new AIConfigurationError('bad wiring');
    expect(isAIError(error)).toBe(true);
    expect(error instanceof AIError).toBe(true);
  });
});
