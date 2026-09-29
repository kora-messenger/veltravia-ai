/** Image Intelligence type surface. Everything derived from an image is
 *  provenance-tagged data, never authorization. */

import type { FileAssetId } from '@veltravia/file-intelligence-core';
import type { AIImageAttachment } from '@veltravia/ai-core';

export type {
  Artifact,
  FileAsset,
  FileAssetId,
  FileIntelligenceManager,
  FilePrincipal,
  FileScope,
} from '@veltravia/file-intelligence-core';
export type { AIImageAttachment } from '@veltravia/ai-core';

/** Image formats Veltravia can genuinely identify by signature. */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff' | 'svg';

/** Closed union of provider capabilities. Never assume a provider has one. */
export type ImageCapability =
  | 'image_understanding'
  | 'visual_question_answering'
  | 'ocr'
  | 'object_detection'
  | 'scene_understanding'
  | 'screenshot_understanding'
  | 'ui_element_detection'
  | 'structured_extraction'
  | 'image_search'
  | 'comparison'
  | 'chart_understanding'
  | 'diagram_understanding'
  | 'document_image_understanding';

/** Closed union of provider operations the manager can request. */
export const IMAGE_PROVIDER_OPERATIONS = [
  'describe',
  'ocr',
  'query',
  'screenshot',
  'ui_structure',
  'chart',
  'diagram',
  'extract',
  'compare',
] as const;
export type ImageProviderOperation = (typeof IMAGE_PROVIDER_OPERATIONS)[number];

/** Honest capability surface of one provider. Null means "no declared limit". */
export interface ImageProviderCapabilities {
  readonly providerId: string;
  readonly capabilities: readonly ImageCapability[];
  readonly supportedFormats: readonly ImageFormat[] | null;
  readonly maxBytes: number | null;
  readonly maxDimensionPixels: number | null;
}

export interface ImageProviderRequest {
  readonly op: ImageProviderOperation;
  readonly images: readonly AIImageAttachment[];
  /** Live cancellation signal; providers must check it during long work. */
  readonly isCancelled: () => boolean;
  readonly question?: string;
  readonly fields?: readonly string[];
}

export interface ImageProviderResult {
  /** Provider answer text. For structured ops the manager expects bare JSON. */
  readonly text: string;
}

/** A provider-neutral image intelligence provider (mock or real adapter). */
export interface ImageProvider {
  readonly id: string;
  getCapabilities(): ImageProviderCapabilities;
  analyze(request: ImageProviderRequest): Promise<ImageProviderResult>;
}

export type ImageJobId = string & { readonly __imageJobId: never };

/** PNG container facts read from the IHDR chunk. Nulls mean "unknown". */
export interface ImageColorInfo {
  readonly bitDepth: number | null;
  readonly colorType: number | null;
  readonly hasAlpha: boolean;
  readonly dominantColors: readonly string[];
}

/** Safe metadata for one authorized image file. */
export interface ImageMetadata {
  readonly fileId: FileAssetId;
  readonly filename: string;
  readonly mimeType: string;
  readonly format: ImageFormat | null;
  readonly byteSize: number;
  readonly checksum: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly colorInfo: ImageColorInfo | null;
  readonly animated: boolean | null;
  readonly frameCount: number | null;
  readonly createdAt: string;
  readonly scope: import('@veltravia/file-intelligence-core').FileScope;
}

export type ImageProcessingStatus =
  | 'received'
  | 'validating'
  | 'validated'
  | 'processing'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface ImageProcessingJob {
  readonly id: ImageJobId;
  readonly fileId: FileAssetId;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly status: ImageProcessingStatus;
  readonly stage: 'queued' | 'validation' | 'describe' | 'ocr' | 'done';
  readonly operations: number;
  readonly completedOperations: number;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

/** OCR: extracted text is UNTRUSTED DATA straight from pixels. */
export interface OcrRegion {
  readonly id: string;
  readonly text: string;
  readonly box: readonly [number, number, number, number] | null;
  readonly confidence: number | null;
  readonly readingOrder: number | null;
}

export interface OcrResult {
  readonly fileId: FileAssetId;
  readonly regions: readonly OcrRegion[];
  readonly text: string;
  readonly regionsAvailable: boolean;
  readonly confidenceAvailable: boolean;
  readonly providerId: string;
  readonly createdAt: string;
  readonly trust: 'untrusted_data';
}

/** AI descriptions are interpretations, not image facts. */
export interface ImageDescription {
  readonly fileId: FileAssetId;
  readonly summary: string;
  readonly observed: readonly string[];
  readonly inferences: readonly string[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export interface ImageQueryResult {
  readonly fileId: FileAssetId;
  readonly question: string;
  readonly answer: string;
  readonly insufficientEvidence: boolean;
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export type ScreenshotIssueKind =
  | 'overlap'
  | 'clipping'
  | 'spacing'
  | 'alignment'
  | 'readability'
  | 'contrast'
  | 'hierarchy'
  | 'missing_element'
  | 'duplicated_control'
  | 'suspicious_state'
  | 'other';

export interface ScreenshotIssue {
  readonly id: string;
  readonly kind: ScreenshotIssueKind;
  readonly statement: string;
  readonly basis: 'fact' | 'inference';
  readonly regionId: string | null;
}

export interface ScreenshotAnalysis {
  readonly fileId: FileAssetId;
  readonly issues: readonly ScreenshotIssue[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export type UiElementKind =
  | 'navigation'
  | 'header'
  | 'sidebar'
  | 'card'
  | 'button'
  | 'input'
  | 'tab'
  | 'table'
  | 'dialog'
  | 'image'
  | 'icon'
  | 'text'
  | 'list'
  | 'chart'
  | 'unknown';

export interface UiElement {
  readonly id: string;
  readonly kind: UiElementKind;
  readonly label: string | null;
  readonly regionId: string | null;
}

export interface UiStructure {
  readonly fileId: FileAssetId;
  readonly elements: readonly UiElement[];
  readonly notes: readonly string[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export interface ChartAnalysis {
  readonly fileId: FileAssetId;
  readonly chartType: string;
  readonly title: string | null;
  readonly observed: readonly string[];
  readonly inferences: readonly string[];
  readonly values: readonly string[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export interface DiagramNode {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
}

export interface DiagramRelationship {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly label: string;
  readonly kind: string;
}

export interface DiagramAnalysis {
  readonly fileId: FileAssetId;
  readonly nodes: readonly DiagramNode[];
  readonly relationships: readonly DiagramRelationship[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export type ComparisonKind =
  | 'text_change'
  | 'element_added'
  | 'element_removed'
  | 'layout_change'
  | 'color_change'
  | 'chart_change'
  | 'screenshot_change'
  | 'other';

export interface ComparisonDifference {
  readonly kind: ComparisonKind;
  readonly statement: string;
  readonly basis: 'fact' | 'inference';
}

export interface ComparisonResult {
  readonly fileAId: FileAssetId;
  readonly fileBId: FileAssetId;
  readonly summary: string;
  readonly differences: readonly ComparisonDifference[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export interface ExtractedField {
  readonly field: string;
  readonly value: string;
  readonly uncertain: boolean;
}

export interface ImageExtraction {
  readonly fileId: FileAssetId;
  readonly fields: readonly ExtractedField[];
  readonly providerId: string;
  readonly trust: 'ai_generated';
}

export interface ImageSearchMatch {
  readonly fileId: FileAssetId;
  readonly reason: string;
  readonly matchedText: string | null;
}

export interface ImageSearchResult {
  readonly query: string;
  readonly matches: readonly ImageSearchMatch[];
  readonly truncated: boolean;
  readonly trust: 'untrusted_data';
}

export interface ImageAnalysisRecord {
  readonly description: ImageDescription | null;
  readonly ocr: OcrResult | null;
  readonly jobId: ImageJobId | null;
}

export type ImageArtifactKind =
  | 'image_analysis_json'
  | 'image_description_md'
  | 'ocr_txt'
  | 'screenshot_analysis_md'
  | 'ui_structure_json'
  | 'image_comparison_json'
  | 'chart_analysis_json'
  | 'diagram_analysis_json';

/** Saved-artifact view: safe metadata only, never content pointers. */
export interface ImageArtifactView {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly createdAt: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

export interface ImageLimits {
  readonly maxFileBytes: number;
  readonly maxDimensionPixels: number;
  readonly maxFrames: number;
  readonly maxProcessingMs: number;
  readonly maxConcurrentJobs: number;
  readonly maxContextCharacters: number;
  readonly maxSearchMatches: number;
  readonly maxCompareImages: number;
  readonly maxOcrCharacters: number;
  readonly jobTtlSeconds: number;
}
