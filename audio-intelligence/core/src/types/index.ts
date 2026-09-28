/**
 * Core domain types for Audio Intelligence (Step 20).
 *
 * TRUST MODEL (fixed, mirrors Step 19):
 *
 *     SYSTEM POLICY
 *         |
 *     SECURITY / PERMISSIONS
 *         |
 *     TOOLS
 *         |
 *     FILE INTELLIGENCE  (audio bytes, untrusted)
 *         |
 *     TRANSCRIPT / EXTRACTION  (untrusted data)
 *         |
 *     AI REASONING OUTPUT  (ai_generated, never a direct audio fact)
 *
 * Audio content is DATA. A recording that says "delete the project" is
 * content being analyzed, never an authorized instruction. Nothing in this
 * package executes tools, mutates projects, or grants permission.
 *
 * Every timestamp, speaker label, and confidence value in these types is
 * nullable on purpose: providers that do not supply a value must represent
 * it as unavailable - never invent it.
 */
import type { FileAssetId, FileScope, FilePrincipal } from '@veltravia/file-intelligence-core';

/** Opaque audio job id. */
export type AudioJobId = string & { readonly __audioJobId: unique symbol };

/** Audio container formats this step can validate and process. */
export const AUDIO_FORMATS = ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/** Safe, exposed audio metadata. Never includes storage paths. */
export interface AudioMetadata {
  readonly fileId: FileAssetId;
  readonly filename: string;
  readonly mimeType: string;
  readonly format: AudioFormat | null;
  readonly byteSize: number;
  readonly checksum: string;
  /** Seconds, when safely detectable from the container. Null when unknown. */
  readonly durationSeconds: number | null;
  /** PCM details are only parsed from WAV headers; others stay null. */
  readonly sampleRateHz: number | null;
  readonly channels: number | null;
  readonly codec: string | null;
  readonly createdAt: string;
  readonly scope: FileScope;
}

/** What a provider can genuinely do. Closed union - no free strings. */
export const AUDIO_CAPABILITIES = [
  'transcription',
  'timestamps',
  'speaker_identification',
  'translation',
  'summarization',
  'question_answering',
  'structured_extraction',
  'long_audio',
] as const;
export type AudioCapability = (typeof AUDIO_CAPABILITIES)[number];

/** A provider's declared capability surface. Honest by construction. */
export interface AudioProviderCapabilities {
  readonly providerId: string;
  readonly capabilities: readonly AudioCapability[];
  /** Formats the provider accepts, or null for format-agnostic. */
  readonly supportedFormats: readonly AudioFormat[] | null;
  /** Longest single recording the provider accepts, or null for unknown. */
  readonly maxDurationSeconds: number | null;
  readonly maxBytes: number | null;
  readonly supportedLanguages: readonly string[] | null;
}

/** Neutral speaker label - never a claimed identity. */
export type SpeakerLabel = string;

/** One transcript segment. Timestamps are provider-supplied or null. */
export interface TranscriptSegment {
  readonly id: string;
  readonly startSeconds: number | null;
  readonly endSeconds: number | null;
  /** Neutral label (e.g. "Speaker 1") or null when speaker analysis is unavailable. */
  readonly speaker: SpeakerLabel | null;
  readonly text: string;
  /** Provider-supplied confidence, or null when the provider does not report one. */
  readonly confidence: number | null;
}

/** The transcript of one audio file. Content is untrusted data. */
export interface Transcript {
  readonly fileId: FileAssetId;
  readonly language: string | null;
  readonly languageAutoDetected: boolean;
  readonly segments: readonly TranscriptSegment[];
  /** Full concatenated text (bounded). */
  readonly text: string;
  readonly providerId: string;
  readonly timestampsAvailable: boolean;
  readonly speakersAvailable: boolean;
  readonly confidence: number | null;
  /** How many bounded chunks were processed (1 for short audio). */
  readonly chunkCount: number;
  readonly jobId: AudioJobId | null;
  readonly createdAt: string;
  readonly trust: 'untrusted_data';
}

/** Style of summary a caller can request. */
export const AUDIO_SUMMARY_STYLES = [
  'short',
  'detailed',
  'meeting',
  'executive',
  'key_points',
  'chronological',
] as const;
export type AudioSummaryStyle = (typeof AUDIO_SUMMARY_STYLES)[number];

/** Trust tag separating recorded facts from AI interpretation. */
export type AudioTrust = 'untrusted_data' | 'ai_generated' | 'extracted';

/** An AI-generated summary over the transcript. */
export interface AudioSummary {
  readonly fileId: FileAssetId;
  readonly style: AudioSummaryStyle;
  readonly text: string;
  readonly keyPoints: readonly string[];
  readonly attendees: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly followUps: readonly string[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

/** Possible action item detected in the audio. A suggestion, never an action. */
export interface AudioActionItem {
  readonly description: string;
  readonly assignedTo: SpeakerLabel | null;
  readonly deadline: string | null;
  /** Segment evidence - only real provider segments, never fabricated. */
  readonly evidence: { readonly segmentId: string } | null;
  readonly certainty: 'stated' | 'suggested';
}

/** Possible decision detected in the audio. Uncertainty is explicit. */
export interface AudioDecision {
  readonly statement: string;
  readonly evidence: { readonly segmentId: string } | null;
  readonly certainty: 'stated' | 'probable';
}

/** A structured value extracted from the audio. */
export interface AudioEntity {
  readonly field: string;
  readonly value: string;
  readonly evidence: { readonly segmentId: string } | null;
  /** True when the extraction is uncertain or ambiguous. */
  readonly uncertain: boolean;
}

/** Question answering over the audio. Supporting segments are real ones only. */
export interface AudioQueryResult {
  readonly fileId: FileAssetId;
  readonly question: string;
  readonly answer: string;
  /** Transcript segments that support the answer (already bounded). */
  readonly supportingSegments: readonly TranscriptSegment[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

/** Transcript-content search result. Search never matches only filenames. */
export interface AudioSearchMatch {
  readonly segment: TranscriptSegment;
  /** Bounded surrounding text from neighbouring segments. */
  readonly context: string;
}
export interface AudioSearchResult {
  readonly fileId: FileAssetId;
  readonly query: string;
  readonly matches: readonly AudioSearchMatch[];
  readonly truncated: boolean;
}

/** Translation of transcript content. Original is always preserved separately. */
export interface AudioTranslation {
  readonly fileId: FileAssetId;
  readonly targetLanguage: string;
  readonly scope: 'transcript' | 'segment' | 'summary';
  readonly segmentId: string | null;
  readonly translatedText: string;
  readonly originalPreserved: true;
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

/** Combined analysis bundle (summary + structured findings). */
export interface AudioAnalysis {
  readonly fileId: FileAssetId;
  readonly summary: AudioSummary | null;
  readonly actionItems: readonly AudioActionItem[];
  readonly decisions: readonly AudioDecision[];
  readonly entities: readonly AudioEntity[];
  readonly trust: 'ai_generated';
}

/** Processing lifecycle. Typed transitions; clients can never set status. */
export const AUDIO_JOB_STATUSES = [
  'received',
  'validating',
  'validated',
  'processing',
  'transcribing',
  'analyzing',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;
export type AudioProcessingStatus = (typeof AUDIO_JOB_STATUSES)[number];

export type AudioJobStage =
  'queued' | 'validation' | 'chunking' | 'transcription' | 'assembly' | 'analysis' | 'done';

export interface AudioJobError {
  readonly code: string;
  readonly message: string;
}

/** A bounded audio processing job. */
export interface AudioProcessingJob {
  readonly id: AudioJobId;
  readonly fileId: FileAssetId;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly status: AudioProcessingStatus;
  readonly stage: AudioJobStage;
  readonly requestedLanguage: string | null;
  readonly detectedLanguage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly chunks: number;
  readonly completedChunks: number;
  readonly error: AudioJobError | null;
}

/** Derived artifact kinds users can save through the Step 19 artifact system. */
export const AUDIO_ARTIFACT_KINDS = [
  'transcript_txt',
  'transcript_md',
  'transcript_json',
  'summary_md',
  'action_items_json',
  'meeting_notes_md',
  'translation_md',
  'analysis_json',
] as const;
export type AudioArtifactKind = (typeof AUDIO_ARTIFACT_KINDS)[number];

export interface AudioArtifactDraft {
  readonly kind: AudioArtifactKind;
  readonly filename?: string;
  /** For translation artifacts: the translation to persist. */
  readonly translation?: AudioTranslation;
}

/** Configurable limits. Every value has a hard server-side ceiling. */
export interface AudioLimits {
  readonly maxFileBytes: number;
  readonly maxDurationSeconds: number;
  readonly maxProcessingMs: number;
  readonly maxConcurrentJobs: number;
  readonly maxChunks: number;
  readonly maxTranscriptCharacters: number;
  readonly maxContextCharacters: number;
  readonly maxSearchMatches: number;
  readonly maxQuerySupportingSegments: number;
  readonly jobTtlSeconds: number;
}

/** Who is asking. Mirrors the Step 19 file principal exactly. */
export type AudioPrincipal = FilePrincipal;
