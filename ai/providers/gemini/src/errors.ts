import {
  AIConfigurationError,
  AIError,
  AIProviderError,
  InvalidAIRequestError,
  ModelNotFoundError,
} from '@veltravia/ai-core';

/**
 * Gemini failure normalization. Every error that leaves the adapter is a
 * typed Veltravia AIError; raw Gemini SDK errors never reach application
 * code, and the API key never appears in any message or detail.
 *
 * Each normalized error carries a `retryable` flag (and optionally
 * `retryAfterMs`) in its details - the retry-policy abstraction consumes
 * these, so the future retry/circuit-breaker system can be built without
 * re-classifying errors.
 */

/** Anything that might contain the key gets scrubbed before it is surfaced. */
export function redactSecret(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return message;
  return message.split(secret).join('[REDACTED]');
}

/** True when the thrown value looks like the Google SDK's ApiError. */
function isSdkApiError(
  error: unknown,
): error is { status: number; message: string; name?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

/** True for AbortError / TimeoutError / deadline-exceeded style failures. */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /timed? out|deadline exceeded|aborted/i.test(message);
}

/** Network-level failures (fetch rejections, DNS, connection reset). */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

/**
 * Normalizes ANY failure thrown during a Gemini call into a typed AIError.
 * The apiKey is passed only so it can be scrubbed from messages - it is never
 * copied into error details.
 */
export function normalizeGeminiError(error: unknown, apiKey: string | undefined): AIError {
  if (error instanceof AIError) return error;

  if (isTimeoutError(error)) {
    return new AIProviderError('Gemini request timed out', {
      details: { retryable: true, timeout: true, providerId: 'gemini' },
      cause: error,
    });
  }

  if (isNetworkError(error)) {
    return new AIProviderError('Gemini request failed at the network level', {
      details: { retryable: true, network: true, providerId: 'gemini' },
      cause: error,
    });
  }

  if (isSdkApiError(error)) {
    const message = redactSecret(error.message, apiKey);
    const status = error.status;
    // Standard HTTP classification of the Gemini API.
    if (status === 400 || status === 422) {
      return new InvalidAIRequestError(`Gemini rejected the request: ${message}`, {
        details: { retryable: false, geminiStatus: status },
        cause: error,
      });
    }
    if (status === 401 || status === 403) {
      return new AIConfigurationError('Gemini authentication failed (check the API key)', {
        details: { retryable: false, geminiStatus: status },
        cause: error,
      });
    }
    if (status === 404) {
      return new ModelNotFoundError(`Gemini model not found: ${message}`, {
        details: { retryable: false, geminiStatus: status },
        cause: error,
      });
    }
    if (status === 429) {
      return new AIProviderError('Gemini rate limit exceeded', {
        details: { retryable: true, rateLimited: true, geminiStatus: status },
        cause: error,
      });
    }
    if (status >= 500) {
      return new AIProviderError(`Gemini is unavailable (HTTP ${status})`, {
        details: { retryable: true, geminiStatus: status },
        cause: error,
      });
    }
    return new AIProviderError(`Gemini call failed: ${message}`, {
      details: { retryable: false, geminiStatus: status },
      cause: error,
    });
  }

  const message =
    typeof (error as { message?: unknown })?.message === 'string'
      ? redactSecret((error as { message: string }).message, apiKey)
      : 'Unknown Gemini failure';
  return new AIProviderError(`Gemini call failed: ${message}`, {
    details: { retryable: false, providerId: 'gemini' },
    cause: error,
  });
}
