import { describe, expect, it } from 'vitest';
import { loadAIConfig, resolveAIConfig } from './index';

describe('resolveAIConfig', () => {
  it('provides safe defaults', () => {
    const config = resolveAIConfig();
    expect(config.enabledProviders).toEqual([]);
    expect(config.maxInputMessages).toBe(100);
    expect(config.maxInputChars).toBe(10_000);
    expect(config.requestTimeoutMs).toBe(60_000);
    expect(config.defaultModel).toBeUndefined();
  });

  it('applies overrides on top of defaults', () => {
    const config = resolveAIConfig({ defaultModel: 'x', maxInputMessages: 5 });
    expect(config.defaultModel).toBe('x');
    expect(config.maxInputMessages).toBe(5);
    expect(config.maxInputChars).toBe(10_000);
  });
});

describe('loadAIConfig', () => {
  it('reads routing and limit variables from the environment', () => {
    const config = loadAIConfig({
      env: {
        AI_DEFAULT_PROVIDER: 'mock',
        AI_DEFAULT_MODEL: 'mock-text-small',
        AI_ENABLED_PROVIDERS: 'mock, other',
        AI_MAX_INPUT_MESSAGES: '42',
        AI_REQUEST_TIMEOUT_MS: '5000',
      },
    });
    expect(config.defaultProvider).toBe('mock');
    expect(config.defaultModel).toBe('mock-text-small');
    expect(config.enabledProviders).toEqual(['mock', 'other']);
    expect(config.maxInputMessages).toBe(42);
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it('yields defaults when the environment is silent', () => {
    const config = loadAIConfig({ env: {} });
    expect(config.defaultModel).toBeUndefined();
    expect(config.enabledProviders).toEqual([]);
  });

  it('never reads or contains any secret material', () => {
    const config = loadAIConfig({ env: { OPENAI_API_KEY: 'sk-secret' } });
    expect(JSON.stringify(config)).not.toContain('sk-secret');
  });
});
