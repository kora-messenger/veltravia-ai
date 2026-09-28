import type { AudioLimits } from '../types/index.js';

/**
 * Hard ceilings. No caller - user, config, or model - can exceed these.
 * Configured limits are clamped here, so a bad env var can never unlock
 * unbounded audio processing.
 */
export const AUDIO_LIMIT_CEILINGS: Readonly<AudioLimits> = {
  maxFileBytes: 100 * 1024 * 1024,
  maxDurationSeconds: 4 * 60 * 60,
  maxProcessingMs: 10 * 60 * 1000,
  maxConcurrentJobs: 4,
  maxChunks: 32,
  maxTranscriptCharacters: 400_000,
  maxContextCharacters: 24_000,
  maxSearchMatches: 50,
  maxQuerySupportingSegments: 12,
  jobTtlSeconds: 24 * 60 * 60,
};

export const DEFAULT_AUDIO_LIMITS: Readonly<AudioLimits> = {
  maxFileBytes: 25 * 1024 * 1024,
  maxDurationSeconds: 90 * 60,
  maxProcessingMs: 5 * 60 * 1000,
  maxConcurrentJobs: 2,
  maxChunks: 16,
  maxTranscriptCharacters: 200_000,
  maxContextCharacters: 16_000,
  maxSearchMatches: 25,
  maxQuerySupportingSegments: 8,
  jobTtlSeconds: 6 * 60 * 60,
};

const clamp = (value: number | undefined, fallback: number, ceiling: number) =>
  !value || !Number.isFinite(value) || value <= 0 ? fallback : Math.min(Math.floor(value), ceiling);

export function resolveAudioLimits(config: Partial<AudioLimits> = {}): AudioLimits {
  const c = AUDIO_LIMIT_CEILINGS;
  const d = DEFAULT_AUDIO_LIMITS;
  return {
    maxFileBytes: clamp(config.maxFileBytes, d.maxFileBytes, c.maxFileBytes),
    maxDurationSeconds: clamp(
      config.maxDurationSeconds,
      d.maxDurationSeconds,
      c.maxDurationSeconds,
    ),
    maxProcessingMs: clamp(config.maxProcessingMs, d.maxProcessingMs, c.maxProcessingMs),
    maxConcurrentJobs: clamp(config.maxConcurrentJobs, d.maxConcurrentJobs, c.maxConcurrentJobs),
    maxChunks: clamp(config.maxChunks, d.maxChunks, c.maxChunks),
    maxTranscriptCharacters: clamp(
      config.maxTranscriptCharacters,
      d.maxTranscriptCharacters,
      c.maxTranscriptCharacters,
    ),
    maxContextCharacters: clamp(
      config.maxContextCharacters,
      d.maxContextCharacters,
      c.maxContextCharacters,
    ),
    maxSearchMatches: clamp(config.maxSearchMatches, d.maxSearchMatches, c.maxSearchMatches),
    maxQuerySupportingSegments: clamp(
      config.maxQuerySupportingSegments,
      d.maxQuerySupportingSegments,
      c.maxQuerySupportingSegments,
    ),
    jobTtlSeconds: clamp(config.jobTtlSeconds, d.jobTtlSeconds, c.jobTtlSeconds),
  };
}
