import { GatewayError } from '../errors/index.js';

/**
 * In-process token buckets for the two expensive, abusable operations:
 * credential validation and model discovery. Generation is additionally bounded
 * by the provider's own limits and by per-request timeouts.
 *
 * Limiting is per owner AND per action; a caller cannot exhaust another owner's
 * budget, and a burst on discovery cannot starve validation.
 */
export interface RateLimitRule {
  readonly capacity: number;
  /** Tokens restored per second. */
  readonly refillPerSecond: number;
}

export const DEFAULT_RATE_LIMITS = {
  validate: { capacity: 6, refillPerSecond: 0.1 },
  discover: { capacity: 10, refillPerSecond: 0.2 },
  generate: { capacity: 30, refillPerSecond: 1 },
} satisfies Readonly<Record<string, RateLimitRule>>;

export type RateLimitAction = keyof typeof DEFAULT_RATE_LIMITS;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  readonly rules?: Readonly<Record<string, RateLimitRule>>;
  readonly now?: () => number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly rules: Readonly<Record<string, RateLimitRule>>;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions = {}) {
    this.rules = options.rules ?? DEFAULT_RATE_LIMITS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Consumes one token or throws GATEWAY_RATE_LIMITED. */
  consume(ownerRef: string, action: RateLimitAction): void {
    const rule = this.rules[action];
    if (!rule) return;
    const key = `${ownerRef}:${action}`;
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: rule.capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    const tokens = Math.min(rule.capacity, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      throw new GatewayError(
        'GATEWAY_RATE_LIMITED',
        `Too many ${action} attempts. Wait a moment and try again.`,
        { details: { action } },
      );
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
  }
}
