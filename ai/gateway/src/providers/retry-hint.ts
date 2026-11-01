/**
 * How long the provider asked us to wait, in milliseconds.
 *
 * OpenAI-compatible APIs send `retry_after` on a 429 and Gemini sends
 * `details[].retryDelay`; following either is the difference between a retry
 * that works and three quick retries that fail identically.
 */
export function retryHintMs(body: unknown): number | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const direct = record.retry_after ?? record.retryAfter;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
    return Math.round(direct * 1000);
  }
  const error = record.error;
  if (error === null || typeof error !== 'object') return undefined;
  const errorRecord = error as Record<string, unknown>;
  const nested = errorRecord.retry_after;
  if (typeof nested === 'number' && Number.isFinite(nested) && nested > 0) {
    return Math.round(nested * 1000);
  }
  const details = errorRecord.details;
  if (!Array.isArray(details)) return undefined;
  for (const entry of details) {
    if (entry === null || typeof entry !== 'object') continue;
    const delay = (entry as { retryDelay?: unknown }).retryDelay;
    if (typeof delay !== 'string') continue;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(delay.trim());
    if (match) return Math.round(Number(match[1]) * 1000);
  }
  return undefined;
}
