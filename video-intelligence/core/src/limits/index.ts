/** Bounded, ceiling-clamped limits for Video Intelligence. Nothing is
 *  unbounded; configured values are clamped, never trusted raw. */
import type { VideoLimits } from '../types/index.js';

export const DEFAULT_VIDEO_LIMITS: VideoLimits = {
  maxFileBytes: 200 * 1024 * 1024,
  maxDurationSeconds: 1800,
  maxDimensionPixels: 8000,
  maxFrameRate: 240,
  maxStreams: 16,
  maxProcessingMs: 300_000,
  maxFramesPerRequest: 12,
  maxFramesPerVideo: 128,
  maxTimestampRequests: 16,
  maxTranscriptCharacters: 500_000,
  maxOcrCharacters: 200_000,
  maxConcurrentJobs: 2,
  maxSearchMatches: 200,
  maxCompareVideos: 2,
  jobTtlSeconds: 86_400,
};

/** Hard ceilings. No configuration may exceed these. */
export const VIDEO_LIMIT_CEILINGS: VideoLimits = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxDurationSeconds: 7200,
  maxDimensionPixels: 16_000,
  maxFrameRate: 480,
  maxStreams: 64,
  maxProcessingMs: 1_800_000,
  maxFramesPerRequest: 64,
  maxFramesPerVideo: 512,
  maxTimestampRequests: 64,
  maxTranscriptCharacters: 2_000_000,
  maxOcrCharacters: 1_000_000,
  maxConcurrentJobs: 8,
  maxSearchMatches: 1000,
  maxCompareVideos: 4,
  jobTtlSeconds: 7 * 24 * 60 * 60,
};

type LimitsKey = keyof VideoLimits;

function clamp(key: LimitsKey, value: number | undefined): number {
  if (value === undefined) return DEFAULT_VIDEO_LIMITS[key];
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_VIDEO_LIMITS[key];
  return Math.min(Math.floor(value), VIDEO_LIMIT_CEILINGS[key]);
}

export function resolveVideoLimits(overrides?: Partial<VideoLimits>): VideoLimits {
  const keys = Object.keys(DEFAULT_VIDEO_LIMITS) as readonly LimitsKey[];
  const out = {} as Record<LimitsKey, number>;
  for (const key of keys) out[key] = clamp(key, overrides?.[key]);
  return out as VideoLimits;
}
