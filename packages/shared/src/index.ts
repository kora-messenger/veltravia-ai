/**
 * @veltravia/shared - framework-agnostic, dependency-free utilities.
 */

/** Explicit success/failure result, used instead of throw-based control flow. */
export type Result<T, E = Error> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function success<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function failure<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** ISO-8601 UTC timestamp; single canonical format across the platform. */
export function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/** Safe JSON parse returning a Result instead of throwing. */
export function safeJsonParse<T>(raw: string): Result<T, Error> {
  try {
    return success(JSON.parse(raw) as T);
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
  }
}
