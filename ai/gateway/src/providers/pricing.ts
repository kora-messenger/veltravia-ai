import type { CostSource, ModelPricing } from '../types/index.js';

/**
 * Declared model pricing (Step 29).
 *
 * Veltravia does NOT ship a price list. Vendor prices change without notice and
 * hardcoding them would turn a guess into a number that looks authoritative on a
 * usage screen. Instead an operator declares prices explicitly - per provider
 * and per exact model id - and the gateway estimates cost only for those pairs.
 *
 * Everything else reports `costSource: 'unavailable'` and a null estimate, which
 * is the honest answer.
 */

export interface PricingInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface CostEstimate {
  readonly estimatedCostUsd: number | null;
  readonly costSource: CostSource;
}

const KEY_SEPARATOR = '::';

function pricingKey(providerId: string, modelId: string): string {
  return `${providerId}${KEY_SEPARATOR}${modelId}`;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Rounds to 6 decimals so a usage list does not read like a bank statement. */
function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class ModelPricingTable {
  private readonly prices = new Map<string, ModelPricing>();

  /** Declares a price. Invalid numbers are refused rather than coerced. */
  declare(providerId: string, modelId: string, pricing: ModelPricing): void {
    if (
      !isFiniteNonNegative(pricing.inputPer1MUsd) ||
      !isFiniteNonNegative(pricing.outputPer1MUsd)
    ) {
      throw new Error('A declared price must be a finite, non-negative number.');
    }
    this.prices.set(pricingKey(providerId, modelId), {
      inputPer1MUsd: pricing.inputPer1MUsd,
      outputPer1MUsd: pricing.outputPer1MUsd,
    });
  }

  lookup(providerId: string, modelId: string): ModelPricing | undefined {
    return this.prices.get(pricingKey(providerId, modelId));
  }

  get size(): number {
    return this.prices.size;
  }

  /**
   * Estimates cost from provider-reported tokens and a declared price.
   *
   * Returns null when either half is missing: no price, or no confirmed tokens.
   * A partial count is never extrapolated into a total.
   */
  estimate(input: PricingInput): CostEstimate {
    const pricing = this.lookup(input.providerId, input.modelId);
    if (pricing === undefined) return { estimatedCostUsd: null, costSource: 'unavailable' };
    if (input.inputTokens === null || input.outputTokens === null) {
      return { estimatedCostUsd: null, costSource: 'unavailable' };
    }
    const cost =
      (input.inputTokens / 1_000_000) * pricing.inputPer1MUsd +
      (input.outputTokens / 1_000_000) * pricing.outputPer1MUsd;
    return { estimatedCostUsd: round(cost), costSource: 'declared-pricing' };
  }
}

export interface PricingEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly inputPer1MUsd: number;
  readonly outputPer1MUsd: number;
}

/**
 * Reads operator-declared prices from a JSON string:
 * `[{"providerId":"openai","modelId":"gpt-x","inputPer1MUsd":1.5,"outputPer1MUsd":6}]`
 *
 * Malformed entries are skipped with a reason so the server can log the count
 * without ever echoing a payload. Prices live in configuration, never in code.
 */
export function parsePricingConfig(raw: string | undefined): {
  readonly table: ModelPricingTable;
  readonly skipped: number;
} {
  const table = new ModelPricingTable();
  if (raw === undefined || raw.trim().length === 0) return { table, skipped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { table, skipped: 1 };
  }
  if (!Array.isArray(parsed)) return { table, skipped: 1 };
  let skipped = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      skipped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : '';
    const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
    if (providerId.length === 0 || modelId.length === 0) {
      skipped += 1;
      continue;
    }
    if (!isFiniteNonNegative(record.inputPer1MUsd) || !isFiniteNonNegative(record.outputPer1MUsd)) {
      skipped += 1;
      continue;
    }
    table.declare(providerId, modelId, {
      inputPer1MUsd: record.inputPer1MUsd,
      outputPer1MUsd: record.outputPer1MUsd,
    });
  }
  return { table, skipped };
}
