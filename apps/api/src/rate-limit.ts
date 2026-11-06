/**
 * A small fixed-window rate limiter, keyed by caller.
 *
 * HONEST SCOPE: the counters live in this process. Behind several API
 * instances each would count separately, so this limits abuse from one caller
 * on one instance and is not a distributed quota. A shared store would replace
 * `hits` without changing callers.
 */
export interface RateLimiter {
  /** Returns 0 when allowed, otherwise the seconds until the caller may retry. */
  take(key: string): number;
}

export function createRateLimiter(options: {
  readonly max: number;
  readonly windowMs: number;
  readonly now?: () => number;
}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    take(key) {
      const current = now();
      // Drop finished windows so the map cannot grow without bound.
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.resetAt <= current) hits.delete(k);
      }
      const entry = hits.get(key);
      if (entry === undefined || entry.resetAt <= current) {
        hits.set(key, { count: 1, resetAt: current + options.windowMs });
        return 0;
      }
      if (entry.count >= options.max) {
        return Math.max(1, Math.ceil((entry.resetAt - current) / 1000));
      }
      entry.count += 1;
      return 0;
    },
  };
}
