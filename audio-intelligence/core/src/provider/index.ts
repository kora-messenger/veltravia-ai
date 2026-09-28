/**
 * Provider-neutral audio intelligence interface.
 *
 *         Audio Intelligence (core)
 *                    |
 *         AudioProvider (this interface)
 *                    |
 *     Mock provider / Gemini-backed adapter / future providers
 *
 * Providers declare capabilities explicitly. A capability that is not
 * declared throws AUDIO_CAPABILITY_UNSUPPORTED - results are never
 * silently fabricated by a provider that cannot actually produce them.
 */
import type { AudioFormat, AudioProviderCapabilities, AudioSummaryStyle } from '../types/index.js';
export type { AudioProviderCapabilities } from '../types/index.js';

/** One bounded chunk of audio sent for transcription. */
export interface AudioChunkRequest {
  readonly bytes: Uint8Array;
  readonly format: AudioFormat | null;
  readonly mimeType: string;
  /** 0-based chunk index. */
  readonly index: number;
  readonly total: number;
  /** Explicit requested language, or null for automatic detection. */
  readonly language: string | null;
  /**
   * When the container makes the chunk's time offset computable (WAV byte
   * math), the offset in seconds. Null when unknown - providers must never
   * invent absolute times from it.
   */
  readonly offsetSeconds: number | null;
  /** Cancellation probe - providers should check between units of work. */
  readonly isCancelled: () => boolean;
}

/** A provider-returned transcript segment. Every value is nullable. */
export interface ProviderTranscriptSegment {
  readonly startSeconds: number | null;
  readonly endSeconds: number | null;
  readonly speaker: string | null;
  readonly text: string;
  readonly confidence: number | null;
}

export interface ProviderTranscript {
  readonly segments: readonly ProviderTranscriptSegment[];
  /** Detected spoken language, or null when the provider does not detect one. */
  readonly language: string | null;
  /** Overall confidence, or null when the provider does not report one. */
  readonly confidence: number | null;
}

/** Text reasoning over an already-produced, bounded transcript. */
export interface AudioReasoningRequest {
  readonly op: 'summarize' | 'query' | 'extract' | 'translate';
  /** Bounded transcript text (never raw audio). */
  readonly transcriptText: string;
  /** Bounded segment list for evidence references (id, time, speaker, text). */
  readonly segments: readonly {
    readonly id: string;
    readonly startSeconds: number | null;
    readonly endSeconds: number | null;
    readonly speaker: string | null;
    readonly text: string;
  }[];
  readonly style?: AudioSummaryStyle;
  readonly question?: string;
  readonly fields?: readonly string[];
  readonly targetLanguage?: string;
  readonly sourceLanguage?: string | null;
}

/** The reasoning op each core operation maps to. */
export const REASONING_CAPABILITY = {
  summarize: 'summarization',
  query: 'question_answering',
  extract: 'structured_extraction',
  translate: 'translation',
} as const;

export interface AudioProvider {
  /** Stable provider id, e.g. "audio.mock" or "audio.gemini". */
  readonly id: string;
  capabilities(): AudioProviderCapabilities;
  transcribe(request: AudioChunkRequest): Promise<ProviderTranscript>;
  reason(request: AudioReasoningRequest): Promise<{ readonly text: string }>;
}

/** Providers whose results are simulations (mocks) must identify as such. */
export interface SimulatedProvider extends AudioProvider {
  readonly isSimulation: true;
}
export function isSimulatedProvider(p: AudioProvider): p is SimulatedProvider {
  return (p as Partial<SimulatedProvider>).isSimulation === true;
}
