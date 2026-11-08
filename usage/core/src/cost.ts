/**
 * What a request cost, and who owes it.
 *
 * No price is invented. A cost exists only when the provider reported one or
 * when a price table was configured for that exact provider and model; anything
 * else is `null` with `costSource: 'unknown'`. A missing price is displayed as
 * unknown, never as zero, because zero is a claim.
 */

import type { CostBearer, CostSource } from './types.js';

export interface ModelPrice {
  readonly providerId: string;
  readonly modelId: string;
  /** USD per one million input tokens. */
  readonly inputPerMillion: number;
  /** USD per one million output tokens. */
  readonly outputPerMillion: number;
}

export type PriceTable = readonly ModelPrice[];

/**
 * Parse a price table from configuration. Anything malformed is dropped rather
 * than defaulted: a bad row must not become a price.
 */
export function parsePriceTable(raw: string | null | undefined): PriceTable {
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ModelPrice[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const providerId = row.providerId;
      const modelId = row.modelId;
      const input = row.inputPerMillion;
      const output = row.outputPerMillion;
      if (typeof providerId !== 'string' || providerId === '') continue;
      if (typeof modelId !== 'string' || modelId === '') continue;
      if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) continue;
      if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) continue;
      out.push({ providerId, modelId, inputPerMillion: input, outputPerMillion: output });
    }
    return out;
  } catch {
    return [];
  }
}

export function findPrice(
  table: PriceTable,
  providerId: string | null,
  modelId: string | null,
): ModelPrice | null {
  if (providerId === null || modelId === null) return null;
  const lowerProvider = providerId.toLowerCase();
  const lowerModel = modelId.toLowerCase();
  return (
    table.find(
      (row) =>
        row.providerId.toLowerCase() === lowerProvider && row.modelId.toLowerCase() === lowerModel,
    ) ?? null
  );
}

export interface ProviderCostInput {
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** What the provider itself said the request cost, when it said anything. */
  readonly reportedCostUsd?: number | null;
  readonly priceTable?: PriceTable;
}

export interface ProviderCost {
  readonly costUsd: number | null;
  readonly costSource: CostSource;
  readonly explanation: string;
}

export function providerCost(input: ProviderCostInput): ProviderCost {
  if (typeof input.reportedCostUsd === 'number' && Number.isFinite(input.reportedCostUsd)) {
    return {
      costUsd: input.reportedCostUsd,
      costSource: 'provider_reported',
      explanation: 'The provider reported this cost for the request.',
    };
  }
  const price = findPrice(input.priceTable ?? [], input.providerId, input.modelId);
  if (price === null) {
    return {
      costUsd: null,
      costSource: 'unknown',
      explanation: 'No provider-reported cost and no price configured for this model.',
    };
  }
  if (input.inputTokens === null && input.outputTokens === null) {
    return {
      costUsd: null,
      costSource: 'unknown',
      explanation: 'The provider did not report token counts, so no cost can be computed.',
    };
  }
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  return {
    costUsd:
      (inputTokens / 1_000_000) * price.inputPerMillion +
      (outputTokens / 1_000_000) * price.outputPerMillion,
    costSource: 'price_table',
    explanation: `Computed from the configured price for ${price.providerId}/${price.modelId}.`,
  };
}

/**
 * Who bears a provider charge. A key the user connected is the user's bill to
 * their provider; a key Veltravia connected is Veltravia's. The distinction is
 * what keeps BYOK usage out of the included allowance.
 */
export function providerBearer(byok: boolean): CostBearer {
  return byok ? 'user_provider' : 'veltravia';
}

/** Infrastructure records belong to Veltravia, always. */
export const INFRASTRUCTURE_BEARER: CostBearer = 'veltravia';
