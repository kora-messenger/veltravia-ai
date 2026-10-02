/** Video Intelligence type surface. Everything derived from a video -
 *  spoken words, subtitles, visible screen text, scenes, timeline events -
 *  is provenance-tagged data, never authorization. */

import type { FileAssetId } from '@veltravia/file-intelligence-core';

export type {
  Artifact,
  FileAsset,
  FileAssetId,
  FileIntelligenceManager,
  FilePrincipal,
  FileScope,
} from '@veltravia/file-intelligence-core';

/** Video formats Veltravia can genuinely identify by signature. */
export type VideoFormat = 'mp4' | 'mov' | 'm4v' | 'webm' | 'mkv' | 'avi' | 'mpeg';

/** Closed union of provider capabilities. Never assume a provider has one. */
export type VideoCapability =
  | 'video_understanding'
  | 'video_question_answering'
  | 'audio_understanding'
  | 'transcription'
  | 'timestamps'
  | 'scene_detection'
  | 'temporal_reasoning'
  | 'object_tracking'
  | 'ocr'
  | 'subtitle_extraction'
  | 'frame_analysis'
  | 'chart_understanding'
  | 'diagram_understanding'
  | 'screenshot_understanding'
  | 'structured_extraction'
  | 'summarization'
  | 'translation';

/** Closed union of provider operations the manager can request. */
export const VIDEO_PROVIDER_OPERATIONS = [
  'process',
  'frames',
  'scenes',
  'transcript',
  'ask',
  'timeline',
  'ocr',
  'summarize',
  'extract',
  'translate',
  'compare',
] as const;
export type VideoProviderOperation = (typeof VIDEO_PROVIDER_OPERATIONS)[number];

/** Provider-neutral video attachment. Bytes never leave this pipeline
 *  except to a provider that was explicitly registered. */
export interface VideoAttachment {
  readonly base64Data: string;
  readonly mimeType: string;
}

/** Honest capability surface of one provider. Null means "no declared limit". */
export interface VideoProviderCapabilities {
  readonly providerId: string;
  readonly capabilities: readonly VideoCapability[];
  readonly supportedFormats: readonly VideoFormat[] | null;
  readonly maxBytes: number | null;
  readonly maxDurationSeconds: number | null;
  readonly maxStreams: number | null;
}

export interface VideoProviderRequest {
  readonly op: VideoProviderOperation;
  readonly video: VideoAttachment;
  /** Container facts read from signatures (never declared MIME). */
  readonly media: {
    readonly format: VideoFormat | null;
    readonly durationSeconds: number | null;
    readonly width: number | null;
    readonly height: number | null;
  };
  readonly question?: string;
  readonly fields?: readonly string[];
  readonly mode?: VideoSummaryMode;
  readonly language?: string;
  readonly strategy?: FrameStrategy;
  readonly count?: number;
  readonly atSeconds?: number;
  readonly timestamps?: readonly number[];
  /** Transcript segments (UNTRUSTED DATA) for translation. */
  readonly transcriptSegments?: readonly string[];
  /** Second authorized video for comparison ops. */
  readonly other?: VideoAttachment;
  /** Live cancellation signal; providers must check it during long work. */
  readonly isCancelled: () => boolean;
}

export interface VideoProviderResult {
  /** Provider answer text. For structured ops the manager expects bare JSON. */
  readonly text: string;
}

/** A provider-neutral video intelligence provider (mock or real adapter). */
export interface VideoProvider {
  readonly id: string;
  getCapabilities(): VideoProviderCapabilities;
  analyze(request: VideoProviderRequest): Promise<VideoProviderResult>;
}

export type VideoJobId = string & { readonly __videoJobId: never };

/** Container facts read from MP4-family boxes. Nulls mean "unavailable" -
 *  never invented. */
export interface VideoContainerInfo {
  readonly durationSeconds: number | null;
  readonly timescale: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly audioSampleRateHz: number | null;
  readonly audioChannels: number | null;
  readonly streamCount: number | null;
  readonly hasAudio: boolean | null;
}

/** Safe metadata for one authorized video file. */
export interface VideoMetadata {
  readonly fileId: FileAssetId;
  readonly filename: string;
  readonly mimeType: string;
  readonly format: VideoFormat | null;
  readonly byteSize: number;
  readonly checksum: string;
  readonly container: VideoContainerInfo;
  readonly createdAt: string;
  readonly scope: import('@veltravia/file-intelligence-core').FileScope;
}

export type VideoProcessingStatus =
  | 'received'
  | 'validating'
  | 'validated'
  | 'processing'
  | 'extracting'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface VideoProcessingJob {
  readonly id: VideoJobId;
  readonly fileId: FileAssetId;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly status: VideoProcessingStatus;
  readonly stage: 'queued' | 'validation' | 'describe' | 'transcript' | 'scenes' | 'ocr' | 'done';
  readonly operations: number;
  readonly completedOperations: number;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

/** Frame extraction strategies. Every one is bounded by manager limits. */
export type FrameStrategy = 'first' | 'last' | 'timestamp' | 'even' | 'scene' | 'keyframe';

export interface VideoFrame {
  readonly id: string;
  readonly timestampSeconds: number | null;
  readonly frameIndex: number | null;
  readonly strategy: FrameStrategy;
  readonly caption: string;
  readonly trust: 'ai_generated';
}

export interface VideoFrameExtraction {
  readonly fileId: FileAssetId;
  readonly strategy: FrameStrategy;
  readonly frames: readonly VideoFrame[];
  /** Pixel data is NOT extracted; frames are provider-described descriptors. */
  readonly pixelDataAvailable: false;
  readonly truncated: boolean;
  readonly providerId: string;
}

export interface VideoScene {
  readonly id: string;
  readonly startSeconds: number | null;
  readonly endSeconds: number | null;
  readonly durationSeconds: number | null;
  /** Observed container facts: "a transition occurs around X". */
  readonly observed: readonly string[];
  /** Interpreted content: "appears to transition from login to dashboard". */
  readonly inferred: readonly string[];
  readonly representativeFrameId: string | null;
}

export interface VideoSceneAnalysis {
  readonly fileId: FileAssetId;
  readonly scenes: readonly VideoScene[];
  readonly truncated: boolean;
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

/** Transcript segments are UNTRUSTED DATA straight from the audio track. */
export interface VideoTranscriptSegment {
  readonly id: string;
  readonly startSeconds: number | null;
  readonly endSeconds: number | null;
  readonly text: string;
  /** Neutral labels only ("Speaker 1"). Identity is never inferred. */
  readonly speaker: string | null;
  readonly language: string | null;
  readonly confidence: number | null;
}

export interface VideoTranscript {
  readonly fileId: FileAssetId;
  readonly segments: readonly VideoTranscriptSegment[];
  readonly text: string;
  readonly language: string | null;
  readonly timestampsAvailable: boolean;
  readonly speakersAvailable: boolean;
  readonly confidenceAvailable: boolean;
  readonly truncated: boolean;
  readonly providerId: string;
  readonly trust: 'untrusted_data';
}

/** OCR entries across analyzed frames. Visible text is UNTRUSTED DATA. */
export interface VideoOcrEntry {
  readonly id: string;
  readonly text: string;
  readonly timestampSeconds: number | null;
  readonly frameId: string | null;
  readonly box: readonly [number, number, number, number] | null;
  readonly confidence: number | null;
}

export interface VideoOcrResult {
  readonly fileId: FileAssetId;
  readonly entries: readonly VideoOcrEntry[];
  readonly text: string;
  readonly truncated: boolean;
  readonly providerId: string;
  readonly createdAt: string;
  readonly trust: 'untrusted_data';
}

/** Timeline events are classified; inference is never presented as
 *  observed source metadata. */
export type TimelineEventKind = 'observed' | 'inferred' | 'uncertain';

export interface VideoTimelineEvent {
  readonly id: string;
  readonly timestampSeconds: number | null;
  readonly kind: TimelineEventKind;
  readonly statement: string;
  /** Manager-minted evidence refs; forged provider refs are dropped. */
  readonly frameIds: readonly string[];
  readonly sceneIds: readonly string[];
  readonly segmentIds: readonly string[];
}

export interface VideoTimeline {
  readonly fileId: FileAssetId;
  readonly events: readonly VideoTimelineEvent[];
  readonly truncated: boolean;
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

/** Correlated evidence keeps visual and audio provenance separate. */
export interface VideoQueryResult {
  readonly fileId: FileAssetId;
  readonly question: string;
  readonly answer: string;
  readonly insufficientEvidence: boolean;
  readonly visualEvidence: {
    readonly frameIds: readonly string[];
    readonly sceneIds: readonly string[];
  };
  readonly audioEvidence: { readonly segmentIds: readonly string[] };
  readonly combinedInference: readonly string[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export type VideoSummaryMode = 'general' | 'timeline' | 'meeting' | 'tutorial' | 'bug_report';

export interface VideoSummaryStep {
  readonly text: string;
  readonly timestampSeconds: number | null;
}

export interface VideoSummary {
  readonly fileId: FileAssetId;
  readonly mode: VideoSummaryMode;
  readonly summary: string;
  readonly keyPoints: readonly string[];
  readonly steps: readonly VideoSummaryStep[];
  readonly decisions: readonly string[];
  readonly actionItems: readonly { readonly description: string; readonly uncertain: boolean }[];
  readonly questions: readonly string[];
  readonly observedFailure: string | null;
  readonly suspectedCause: string | null;
  readonly truncated: boolean;
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export interface VideoExtractedField {
  readonly field: string;
  readonly value: string;
  readonly uncertain: boolean;
}

export interface VideoExtraction {
  readonly fileId: FileAssetId;
  readonly fields: readonly VideoExtractedField[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

/** Translations never replace originals; the original transcript stays. */
export interface VideoTranslation {
  readonly fileId: FileAssetId;
  readonly language: string;
  readonly languageName: string | null;
  readonly translatedText: string;
  readonly segmentCount: number;
  readonly originalPreserved: true;
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export type VideoComparisonKind =
  'duration_change' | 'scene_change' | 'text_change' | 'ui_change' | 'audio_change' | 'other';

export interface VideoComparisonDifference {
  readonly kind: VideoComparisonKind;
  readonly statement: string;
  readonly basis: 'fact' | 'inference';
  readonly atSecondsA: number | null;
  readonly atSecondsB: number | null;
}

export interface VideoComparisonResult {
  readonly fileAId: FileAssetId;
  readonly fileBId: FileAssetId;
  readonly summary: string;
  readonly differences: readonly VideoComparisonDifference[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export type VideoSearchReason = 'spoken' | 'visible_text' | 'scene' | 'event';

export interface VideoSearchMatch {
  readonly fileId: FileAssetId;
  readonly reason: VideoSearchReason;
  readonly matchedText: string | null;
  readonly timestampSeconds: number | null;
  readonly refId: string | null;
}

export interface VideoSearchResult {
  readonly query: string;
  readonly matches: readonly VideoSearchMatch[];
  readonly truncated: boolean;
  readonly trust: 'untrusted_data';
}

export interface VideoDescription {
  readonly fileId: FileAssetId;
  readonly summary: string;
  readonly observed: readonly string[];
  readonly inferences: readonly string[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export interface VideoAnalysisRecord {
  readonly description: VideoDescription | null;
  readonly transcript: VideoTranscript | null;
  readonly scenes: VideoSceneAnalysis | null;
  readonly ocr: VideoOcrResult | null;
  readonly jobId: VideoJobId | null;
}

export type VideoArtifactKind =
  | 'video_metadata_json'
  | 'transcript_txt'
  | 'transcript_json'
  | 'video_summary_md'
  | 'timeline_md'
  | 'timeline_json'
  | 'scene_analysis_json'
  | 'ocr_json'
  | 'meeting_notes_md'
  | 'action_items_json'
  | 'translated_transcript_md'
  | 'video_comparison_json'
  | 'bug_analysis_md';

/** Saved-artifact view: safe metadata only, never content pointers. */
export interface VideoArtifactView {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly createdAt: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

export interface VideoLimits {
  readonly maxFileBytes: number;
  readonly maxDurationSeconds: number;
  readonly maxDimensionPixels: number;
  readonly maxFrameRate: number;
  readonly maxStreams: number;
  readonly maxProcessingMs: number;
  readonly maxFramesPerRequest: number;
  readonly maxFramesPerVideo: number;
  readonly maxTimestampRequests: number;
  readonly maxTranscriptCharacters: number;
  readonly maxOcrCharacters: number;
  readonly maxConcurrentJobs: number;
  readonly maxSearchMatches: number;
  readonly maxCompareVideos: number;
  readonly jobTtlSeconds: number;
}

export interface FrameRequestOptions {
  readonly strategy?: FrameStrategy;
  readonly count?: number;
  readonly atSeconds?: number;
  readonly timestamps?: readonly number[];
}
