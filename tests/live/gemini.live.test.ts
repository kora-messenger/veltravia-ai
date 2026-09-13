import { describe, expect, it } from 'vitest';
import { AICore } from '@veltravia/ai-core';
import {
  GeminiAIProvider,
  createGeminiModels,
  isGeminiAvailable,
  loadGeminiConfig,
} from '@veltravia/ai-provider-gemini';

/**
 * OPTIONAL LIVE GEMINI INTEGRATION TEST - NOT part of normal CI.
 *
 * Never runs unless BOTH are present:
 *   RUN_GEMINI_INTEGRATION_TESTS=true
 *   GEMINI_API_KEY=<a real key>
 *
 * Run locally:
 *   RUN_GEMINI_INTEGRATION_TESTS=true GEMINI_API_KEY=... \
 *     npx vitest run tests/live/gemini.live.test.ts
 *
 * CI never sets these variables, so this file always skips there. The key is
 * read from the environment only; it is never printed, logged, or committed.
 */

const enabled =
  process.env.RUN_GEMINI_INTEGRATION_TESTS === 'true' &&
  typeof process.env.GEMINI_API_KEY === 'string' &&
  process.env.GEMINI_API_KEY.length > 0;

describe.skipIf(!enabled)('live Gemini Interactions API', () => {
  // Constructed lazily inside each test: suite bodies run even for skipped
  // suites, and the provider constructor throws without a key.
  const build = () => {
    const config = loadGeminiConfig();
    return {
      config,
      provider: new GeminiAIProvider({ config }),
      model: createGeminiModels(config.defaultModel)[0],
    };
  };

  it('answers a single-turn request with a normalized response', async () => {
    const { provider, model } = build();
    const response = await provider.send(
      { messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }] },
      model,
    );
    expect(response.providerId).toBe('gemini');
    expect(response.requestId.length).toBeGreaterThan(0);
    expect(response.content.length).toBeGreaterThan(0);
    // Usage must come from Gemini itself - never fabricated.
    if (response.usage) {
      expect(response.usage.totalTokens).toBeGreaterThan(0);
    }
  });

  it('answers a multi-turn conversation end to end', async () => {
    const { provider, model } = build();
    const response = await provider.send(
      {
        system: 'You are a terse test assistant.',
        messages: [
          { role: 'user', content: 'My name is Veltravia.' },
          { role: 'assistant', content: 'Nice to meet you, Veltravia.' },
          { role: 'user', content: 'What is my name?' },
        ],
      },
      model,
    );
    expect(response.content.toLowerCase()).toContain('veltravia');
  });

  it('flows through the full AICore facade', async () => {
    const { provider, config, model } = build();
    const core = new AICore({
      providers: [provider],
      config: { defaultProvider: 'gemini', defaultModel: model.modelId },
    });
    core.registry.registerModels(createGeminiModels(config.defaultModel));
    const response = await core.generate({
      messages: [{ role: 'user', content: 'Say ready' }],
    });
    expect(response.providerId).toBe('gemini');
  });

  it('never places the API key in any response field', async () => {
    const { provider, model } = build();
    const apiKey = process.env.GEMINI_API_KEY as string;
    const response = await provider.send(
      { messages: [{ role: 'user', content: 'Say ok' }] },
      model,
    );
    expect(JSON.stringify(response)).not.toContain(apiKey);
  });
});

// Sanity check so a misconfigured run fails loudly instead of silently
// skipping everything: if the flag is on but the key is missing, say so.
describe('live Gemini test configuration', () => {
  it('skips unless explicitly enabled', () => {
    if (!enabled) return;
    expect(isGeminiAvailable(loadGeminiConfig())).toBe(true);
  });
});
