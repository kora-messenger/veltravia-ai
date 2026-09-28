import { AudioIntelligenceManager, type AudioAuditEvent } from '@veltravia/audio-intelligence-core';
import { MockAudioProvider } from '@veltravia/audio-intelligence-mock';
import type { FileIntelligenceManager } from '@veltravia/file-intelligence-core';

export interface AudioServiceOptions {
  readonly files: FileIntelligenceManager;
  readonly now?: () => Date;
  readonly onAudit?: (event: AudioAuditEvent) => void;
}

/**
 * Builds the API's Audio Intelligence manager.
 *
 * DEVELOPMENT-ONLY PROVIDER NOTE (honest limitation, Step 20): the API
 * currently wires the deterministic MOCK provider. The mock simulates every
 * capability offline and never represents real model quality. The genuine
 * Gemini-backed reasoning adapter (audio-intelligence/core provider/
 * gemini-reasoning) exists and is unit-tested with an injected AIProvider,
 * but no real audio-transcription provider is wired into the API in this
 * step; wiring one is a later roadmap item and must never be faked here.
 * AUDIO_MOCK_CHUNK_DELAY_MS slows the simulated provider so cancellation
 * behavior can be exercised in live QA.
 */
export function createAudioIntelligenceService(
  options: AudioServiceOptions,
): AudioIntelligenceManager {
  const delayRaw = Number(process.env.AUDIO_MOCK_CHUNK_DELAY_MS ?? '0');
  const chunkDelayMs = Number.isFinite(delayRaw) && delayRaw > 0 ? Math.min(delayRaw, 5000) : 0;
  const provider = new MockAudioProvider({ chunkDelayMs });
  return new AudioIntelligenceManager({
    files: options.files,
    provider,
    now: options.now,
    onAudit: options.onAudit,
  });
}
