/**
 * Cached tokens (Step 55).
 *
 * Two things must never be true of a cache charge: the cached part is billed
 * twice, once as ordinary input and once at the cache rate; or a saving is
 * reported against a rate the deployment never configured.
 */

import { describe, expect, it } from 'vitest';

import { computeCharge } from './charge.js';
import { defaultChargingCatalog, planCharging, policyFor } from './policies.js';
import type { UsageMeasurement } from './types.js';

const catalog = defaultChargingCatalog();
const paid = planCharging(catalog, 'paid');
const policy = (modelId?: string) =>
  policyFor(paid, 'coding.run', modelId === undefined ? null : modelId) as NonNullable<
    ReturnType<typeof policyFor>
  >;

const measure = (over: Partial<UsageMeasurement> = {}): UsageMeasurement => ({
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  durationMs: null,
  toolCalls: null,
  ...over,
});

describe('cached input', () => {
  it('bills the non-cached part at the input rate and the cached part at the cache rate', () => {
    const priced = policy();
    const computation = computeCharge({
      policy: priced,
      planBillable: true,
      measurement: measure({ inputTokens: 10_000, cachedTokens: 6_000, outputTokens: 1_000 }),
    });

    const rates = priced.tokens as { per1kInput: number; per1kCached: number; per1kOutput: number };
    const flat = priced.flat.credits;
    const expected =
      flat +
      (4_000 / 1000) * rates.per1kInput +
      (6_000 / 1000) * rates.per1kCached +
      (1_000 / 1000) * rates.per1kOutput;

    expect(computation.credits).toBeCloseTo(expected, 4);
    expect(computation.nonCachedInputTokens).toBe(4_000);
    expect(computation.measuredTokens).toBe(11_000);
  });

  it('reports what the cache saved instead of assuming a saving', () => {
    const priced = policy();
    const computation = computeCharge({
      policy: priced,
      planBillable: true,
      measurement: measure({ inputTokens: 10_000, cachedTokens: 8_000, outputTokens: 100 }),
    });
    const rates = priced.tokens as { per1kInput: number; per1kCached: number };
    expect(computation.cachedSavings).toBeCloseTo(
      (8_000 / 1000) * (rates.per1kInput - rates.per1kCached),
      4,
    );
  });

  it('reports no saving when nothing was served from cache', () => {
    const computation = computeCharge({
      policy: policy(),
      planBillable: true,
      measurement: measure({ inputTokens: 1_000, cachedTokens: 0, outputTokens: 10 }),
    });
    expect(computation.cachedSavings).toBeNull();
    expect(computation.nonCachedInputTokens).toBe(1_000);
  });

  it('never counts a cache report as extra input', () => {
    const plain = computeCharge({
      policy: policy(),
      planBillable: true,
      measurement: measure({ inputTokens: 5_000, outputTokens: 500 }),
    });
    const cached = computeCharge({
      policy: policy(),
      planBillable: true,
      measurement: measure({ inputTokens: 5_000, cachedTokens: 2_000, outputTokens: 500 }),
    });
    // Cache reads are cheaper, never more expensive than plain input.
    expect(cached.credits).toBeLessThan(plain.credits);
    expect(cached.measuredTokens).toBe(plain.measuredTokens);
  });

  it('ignores a cache report larger than the input it is a subset of', () => {
    const computation = computeCharge({
      policy: policy(),
      planBillable: true,
      measurement: measure({ inputTokens: 1_000, cachedTokens: 9_000, outputTokens: 10 }),
    });
    expect(computation.nonCachedInputTokens).toBe(0);
    expect(computation.credits).toBeGreaterThan(0);
  });

  it('says nothing was measured when the provider reported no tokens at all', () => {
    const computation = computeCharge({
      policy: policy(),
      planBillable: true,
      measurement: measure(),
    });
    expect(computation.measuredTokens).toBeNull();
    expect(computation.nonCachedInputTokens).toBeNull();
    expect(computation.cachedSavings).toBeNull();
  });
});
