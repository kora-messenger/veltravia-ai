import { describe, expect, it } from 'vitest';
import {
  AIConfigurationError,
  AIProviderError,
  InvalidAIRequestError,
  isAIError,
  ModelNotFoundError,
} from '@veltravia/ai-core';
import { normalizeGeminiError, redactSecret } from './errors';
import { isRetryableGeminiError, NoRetryPolicy, ConservativeRetryPolicy } from './retry';

const KEY = 'AIza-super-secret-key';

describe('normalizeGeminiError', () => {
  it('maps authentication failures (401/403) to AIConfigurationError, non-retryable', () => {
    for (const status of [401, 403]) {
      const error = normalizeGeminiError({ status, message: 'API key not valid' }, KEY);
      expect(error).toBeInstanceOf(AIConfigurationError);
      expect(isRetryableGeminiError(error)).toBe(false);
      expect(error.details).toMatchObject({ retryable: false, geminiStatus: status });
    }
  });

  it('maps invalid requests (400) to InvalidAIRequestError', () => {
    const error = normalizeGeminiError({ status: 400, message: 'Invalid field' }, KEY);
    expect(error).toBeInstanceOf(InvalidAIRequestError);
    expect(isRetryableGeminiError(error)).toBe(false);
  });

  it('maps unknown models (404) to ModelNotFoundError', () => {
    const error = normalizeGeminiError({ status: 404, message: 'model not found' }, KEY);
    expect(error).toBeInstanceOf(ModelNotFoundError);
    expect(isRetryableGeminiError(error)).toBe(false);
  });

  it('maps rate limits (429) to a retryable AIProviderError', () => {
    const error = normalizeGeminiError({ status: 429, message: 'Resource exhausted' }, KEY);
    expect(error).toBeInstanceOf(AIProviderError);
    expect(error.details).toMatchObject({ retryable: true, rateLimited: true });
    expect(isRetryableGeminiError(error)).toBe(true);
  });

  it('maps 5xx server errors to a retryable AIProviderError (provider unavailable)', () => {
    for (const status of [500, 503]) {
      const error = normalizeGeminiError({ status, message: 'Backend error' }, KEY);
      expect(error).toBeInstanceOf(AIProviderError);
      expect(error.details).toMatchObject({ retryable: true, geminiStatus: status });
    }
  });

  it('maps timeouts to a retryable, timeout-flagged provider error', () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const error = normalizeGeminiError(abortError, KEY);
    expect(error).toBeInstanceOf(AIProviderError);
    expect(error.details).toMatchObject({ retryable: true, timeout: true });
  });

  it('maps network failures (TypeError) to a retryable network error', () => {
    const error = normalizeGeminiError(new TypeError('fetch failed'), KEY);
    expect(error).toBeInstanceOf(AIProviderError);
    expect(error.details).toMatchObject({ retryable: true, network: true });
  });

  it('maps malformed SDK errors (no status) to a non-retryable provider error', () => {
    const error = normalizeGeminiError(new Error('something odd'), KEY);
    expect(error).toBeInstanceOf(AIProviderError);
    expect(isRetryableGeminiError(error)).toBe(false);
  });

  it('passes already-normalized AIErrors through unchanged', () => {
    const typed = new AIProviderError('typed failure');
    expect(normalizeGeminiError(typed, KEY)).toBe(typed);
  });

  it('scrubs the API key from every error message - never exposes credentials', () => {
    const leaked = { status: 400, message: `bad request with key ${KEY} inside` };
    const error = normalizeGeminiError(leaked, KEY);
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain('[REDACTED]');
    expect(JSON.stringify(error.details)).not.toContain(KEY);
  });
});

describe('redactSecret', () => {
  it('removes the secret from arbitrary strings', () => {
    expect(redactSecret(`prefix ${KEY} suffix`, KEY)).toBe('prefix [REDACTED] suffix');
    expect(redactSecret('no secrets here', undefined)).toBe('no secrets here');
  });
});

describe('retry policy abstraction', () => {
  it('NoRetryPolicy never retries (Step 3 default - no retry storms)', () => {
    const policy = new NoRetryPolicy();
    const rateLimit = normalizeGeminiError({ status: 429, message: 'slow down' }, KEY);
    expect(policy.shouldRetry(rateLimit, 1).retry).toBe(false);
    expect(policy.shouldRetry(rateLimit, 2).retry).toBe(false);
  });

  it('ConservativeRetryPolicy retries only retryable errors, with a cap', () => {
    const policy = new ConservativeRetryPolicy(2, 500);
    const rateLimit = normalizeGeminiError({ status: 429, message: 'slow down' }, KEY);
    const invalid = normalizeGeminiError({ status: 400, message: 'bad' }, KEY);

    expect(policy.shouldRetry(rateLimit, 1)).toEqual({ retry: true, delayMs: 500 });
    expect(policy.shouldRetry(rateLimit, 2)).toEqual({ retry: true, delayMs: 1000 });
    expect(policy.shouldRetry(rateLimit, 3).retry).toBe(false);
    expect(policy.shouldRetry(invalid, 1).retry).toBe(false);
  });

  it('isAIError recognizes every normalized error', () => {
    const error = normalizeGeminiError({ status: 500, message: 'x' }, KEY);
    expect(isAIError(error)).toBe(true);
  });
});
