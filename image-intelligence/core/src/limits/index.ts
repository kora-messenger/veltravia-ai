/** Bounded, ceiling-clamped limits for Image Intelligence. Nothing is
 *  unbounded; configured values are clamped, never trusted raw. */
import type { ImageLimits } from '../types/index.js';

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxDimensionPixels: 12_000,
  maxFrames: 1200,
  maxProcessingMs: 120_000,
  maxConcurrentJobs: 4,
  maxContextCharacters: 60_000,
  maxSearchMatches: 100,
  maxCompareImages: 4,
  maxOcrCharacters: 100_000,
  jobTtlSeconds: 86_400,
};

/** Hard ceilings. No configuration may exceed these. */
export const IMAGE_LIMIT_CEILINGS: ImageLimits = {
  maxFileBytes: 50 * 1024 * 1024,
  maxDimensionPixels: 20_000,
  maxFrames: 5000,
  maxProcessingMs: 600_000,
  maxConcurrentJobs: 16,
  maxContextCharacters: 200_000,
  maxSearchMatches: 500,
  maxCompareImages: 10,
  maxOcrCharacters: 500_000,
  jobTtlSeconds: 7 * 24 * 60 * 60,
};

type LimitsKey = keyof ImageLimits;

function clamp(key: LimitsKey, value: number | undefined): number {
  if (value === undefined) return DEFAULT_IMAGE_LIMITS[key];
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IMAGE_LIMITS[key];
  return Math.min(Math.floor(value), IMAGE_LIMIT_CEILINGS[key]);
}

export function resolveImageLimits(overrides?: Partial<ImageLimits>): ImageLimits {
  const keys = Object.keys(DEFAULT_IMAGE_LIMITS) as readonly LimitsKey[];
  const out = {} as Record<LimitsKey, number>;
  for (const key of keys) out[key] = clamp(key, overrides?.[key]);
  return out as ImageLimits;
}
