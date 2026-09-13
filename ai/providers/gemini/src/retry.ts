import { isAIError, type AIError } from '@veltravia/ai-core';

/**
 * The retry-policy ABSTRACTION for the Gemini adapter.
 *
 * Step 3 deliberately performs NO automatic retries - but every normalized
 * Gemini error already carries `details.retryable`, so retry decisions are
 * data, not guesswork. A future exponential-backoff / circuit-breaker system
 * implements this same interface without touching the provider or the AI Core.
 */

export interface RetryDecision {
  readonly retry: boolean;
  /** Suggested wait before the next attempt, when retrying. */
  readonly delayMs?: number;
}

export interface GeminiRetryPolicy {
  /** Decides whether a failed call should be attempted again. */
  shouldRetry(error: AIError, attempt: number): RetryDecision;
}

/**
 * The Step 3 default: never retry. Keeps request latency predictable and
 * guarantees no retry storms; the classification the future policy needs is
 * already attached to every error.
 */
export class NoRetryPolicy implements GeminiRetryPolicy {
  shouldRetry(): RetryDecision {
    return { retry: false };
  }
}

/**
 * A conservative reference policy (NOT wired in by default): at most
 * `maxAttempts` attempts, only for retryable failures (rate limits, 5xx,
 * timeouts, network errors), with fixed-delay backoff and an optional
 * respect for a provider-advertised retry-after hint.
 */
export class ConservativeRetryPolicy implements GeminiRetryPolicy {
  /**
   * @param maxRetries how many additional attempts are allowed in total.
   * @param baseDelayMs wait before the first retry; doubles each time.
   * `attempt` is the 1-based index of the retry being decided.
   */
  constructor(
    private readonly maxRetries: number = 2,
    private readonly baseDelayMs: number = 1_000,
  ) {}

  shouldRetry(error: AIError, attempt: number): RetryDecision {
    if (!isAIError(error)) return { retry: false };
    const retryable = error.details?.retryable === true;
    if (!retryable || attempt > this.maxRetries) return { retry: false };
    const retryAfterMs = readRetryAfterMs(error);
    if (retryAfterMs !== undefined) return { retry: true, delayMs: retryAfterMs };
    return { retry: true, delayMs: this.baseDelayMs * 2 ** (attempt - 1) };
  }
}

/** Reads an optional retry-after hint from an error's details. */
function readRetryAfterMs(error: AIError): number | undefined {
  const raw = error.details?.retryAfterMs;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/** Convenience predicate: is this normalized error retryable at all? */
export function isRetryableGeminiError(error: AIError): boolean {
  return isAIError(error) && error.details?.retryable === true;
}
