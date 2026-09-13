import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEMINI_MODEL,
  isGeminiAvailable,
  loadGeminiConfig,
  resolveGeminiConfig,
} from './config';

describe('resolveGeminiConfig', () => {
  it('provides safe defaults', () => {
    const config = resolveGeminiConfig();
    expect(config.apiKey).toBeUndefined();
    expect(config.defaultModel).toBe(DEFAULT_GEMINI_MODEL);
    expect(config.defaultModel).toBe('gemini-3.8-flash');
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.enabled).toBe(true);
    expect(config.storeInteractions).toBe(false);
  });

  it('treats an empty-string API key as absent', () => {
    expect(resolveGeminiConfig({ apiKey: '' }).apiKey).toBeUndefined();
  });

  it('applies overrides', () => {
    const config = resolveGeminiConfig({
      apiKey: 'test-key',
      defaultModel: 'gemini-3.1-pro-preview',
      requestTimeoutMs: 5_000,
    });
    expect(config.apiKey).toBe('test-key');
    expect(config.defaultModel).toBe('gemini-3.1-pro-preview');
    expect(config.requestTimeoutMs).toBe(5_000);
  });
});

describe('loadGeminiConfig', () => {
  it('loads a valid configuration from the environment', () => {
    const config = loadGeminiConfig({
      env: {
        GEMINI_API_KEY: 'test-key',
        GEMINI_MODEL: 'gemini-3.7-flash',
        GEMINI_REQUEST_TIMEOUT_MS: '15000',
        GEMINI_STORE_INTERACTIONS: 'true',
        GEMINI_THINKING_LEVEL: 'low',
      },
    });
    expect(config.apiKey).toBe('test-key');
    expect(config.defaultModel).toBe('gemini-3.7-flash');
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.storeInteractions).toBe(true);
    expect(config.thinkingLevel).toBe('low');
  });

  it('detects a missing API key: provider is not available', () => {
    const config = loadGeminiConfig({ env: {} });
    expect(config.apiKey).toBeUndefined();
    expect(isGeminiAvailable(config)).toBe(false);
  });

  it('respects the enable/disable switch', () => {
    const disabled = loadGeminiConfig({
      env: { GEMINI_API_KEY: 'test-key', GEMINI_ENABLED: 'false' },
    });
    expect(disabled.enabled).toBe(false);
    expect(isGeminiAvailable(disabled)).toBe(false);

    const enabled = loadGeminiConfig({ env: { GEMINI_API_KEY: 'test-key' } });
    expect(isGeminiAvailable(enabled)).toBe(true);
  });

  it('reads model configuration and keeps the default current', () => {
    const withModel = loadGeminiConfig({ env: { GEMINI_MODEL: 'gemini-3.5-flash' } });
    expect(withModel.defaultModel).toBe('gemini-3.5-flash');
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.8-flash');
  });
});

describe('createGeminiModels (model configuration)', () => {
  it('registers supported current Gemini models with text/code capabilities', async () => {
    const { createGeminiModels } = await import('./models');
    const models = createGeminiModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    for (const model of models) {
      expect(model.providerId).toBe('gemini');
      expect(model.available).toBe(true);
      expect(model.capabilities).toContain('text-generation');
      expect(model.capabilities).toContain('code-generation');
    }
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('gemini-3.8-flash');
    expect(ids).toContain('gemini-3.1-pro-preview');
  });

  it('adds a non-default configured model so the registry stays configurable', async () => {
    const { createGeminiModels } = await import('./models');
    const models = createGeminiModels('gemini-3.6-flash');
    expect(models.some((m) => m.modelId === 'gemini-3.6-flash')).toBe(true);
  });
});
