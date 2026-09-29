import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_LIMITS, IMAGE_LIMIT_CEILINGS, resolveImageLimits } from './index.js';

describe('image limits', () => {
  it('exposes bounded defaults for every limit', () => {
    for (const key of Object.keys(DEFAULT_IMAGE_LIMITS) as (keyof typeof DEFAULT_IMAGE_LIMITS)[])
      expect(DEFAULT_IMAGE_LIMITS[key]).toBeGreaterThan(0);
  });

  it('resolves without overrides to the defaults', () => {
    expect(resolveImageLimits()).toEqual(DEFAULT_IMAGE_LIMITS);
  });

  it('clamps every limit to its hard ceiling', () => {
    const overCeiling = {
      maxFileBytes: IMAGE_LIMIT_CEILINGS.maxFileBytes + 1,
      maxDimensionPixels: IMAGE_LIMIT_CEILINGS.maxDimensionPixels + 1,
      maxFrames: IMAGE_LIMIT_CEILINGS.maxFrames + 1,
      maxProcessingMs: IMAGE_LIMIT_CEILINGS.maxProcessingMs + 1,
      maxConcurrentJobs: IMAGE_LIMIT_CEILINGS.maxConcurrentJobs + 1,
      maxContextCharacters: IMAGE_LIMIT_CEILINGS.maxContextCharacters + 1,
      maxSearchMatches: IMAGE_LIMIT_CEILINGS.maxSearchMatches + 1,
      maxCompareImages: IMAGE_LIMIT_CEILINGS.maxCompareImages + 1,
      maxOcrCharacters: IMAGE_LIMIT_CEILINGS.maxOcrCharacters + 1,
      jobTtlSeconds: IMAGE_LIMIT_CEILINGS.jobTtlSeconds + 1,
    };
    expect(resolveImageLimits(overCeiling)).toEqual(IMAGE_LIMIT_CEILINGS);
  });

  it('rejects invalid values by falling back to defaults', () => {
    const clamped = resolveImageLimits({
      maxFileBytes: 0,
      maxDimensionPixels: -5,
      maxFrames: Number.NaN,
    });
    expect(clamped.maxFileBytes).toBe(DEFAULT_IMAGE_LIMITS.maxFileBytes);
    expect(clamped.maxDimensionPixels).toBe(DEFAULT_IMAGE_LIMITS.maxDimensionPixels);
    expect(clamped.maxFrames).toBe(DEFAULT_IMAGE_LIMITS.maxFrames);
  });

  it('keeps configured values that sit under the ceiling', () => {
    const clamped = resolveImageLimits({ maxFileBytes: 1024, maxConcurrentJobs: 2 });
    expect(clamped.maxFileBytes).toBe(1024);
    expect(clamped.maxConcurrentJobs).toBe(2);
  });
});
