import type { DocumentErrorCode } from '../errors/index.js';
/** Bounded document understanding: types, trust tags and view models.
 *  Extracted text, tables, cells, OCR output are UNTRUSTED DATA. Provider
 *  reasoning (answers, summaries, entities, comparisons) is ai_generated
 *  interpretation and never authorization. */
import type { FileAssetId } from '@veltravia/file-intelligence-core';

export type { FileAssetId };
export { asFileAssetId } from '@veltravia/file-intelligence-core';

/** Formats detected from magic bytes, never from declared MIME types. */
export const DOCUMENT_FORMATS = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'markdown',
  'html',
  'json',
  'xml',
  'txt',
] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** What an uploaded document is allowed to be used for. */
export const DOCUMENT_CAPABILITIES = [
  'document_understanding',
  'question_answering',
  'summarization',
  'semantic_search',
  'entity_extraction',
  'comparison_reasoning',
  'ocr',
] as const;
export type DocumentCapability = (typeof DOCUMENT_CAPABILITIES)[number];

/** Provider-declared operations; the manager re-checks each call. */
export const DOCUMENT_PROVIDER_OPERATIONS = [
  'process',
  'answer',
  'summarize',
  'semantic-search',
  'entities',
  'compare',
  'ocr',
] as const;
export type DocumentProviderOperation = (typeof DOCUMENT_PROVIDER_OPERATIONS)[number];

/** Fixed trust tags for every derived output. */
export const DOCUMENT_TRUST_TAGS = ['untrusted_data', 'ai_generated', 'metadata'] as const;
export type DocumentTrustTag = (typeof DOCUMENT_TRUST_TAGS)[number];

export interface DocumentLimits {
  /** Maximum uploaded document size in bytes. */
  readonly maxFileBytes: number;
  /** Maximum parsed elements per document. */
  readonly maxElements: number;
  /** Maximum sections retained per document. */
  readonly maxSections: number;
  /** Maximum tables retained per document. */
  readonly maxTables: number;
  /** Maximum rows retained per table. */
  readonly maxTableRows: number;
  /** Maximum spreadsheet rows inspected. */
  readonly maxSheetRows: number;
  /** Maximum slides retained per presentation. */
  readonly maxSlides: number;
  /** Maximum search matches returned. */
  readonly maxSearchMatches: number;
  /** Maximum evidence quotes per answer. */
  readonly maxEvidenceQuotes: number;
  /** Maximum characters per answer or summary. */
  readonly maxAnswerChars: number;
  /** Maximum entities returned. */
  readonly maxEntities: number;
  /** Maximum OCR characters retained. */
  readonly maxOcrChars: number;
  /** Maximum concurrent provider calls. */
  readonly maxConcurrentProviderCalls: number;
  /** Wall-clock processing ceiling in ms. */
  readonly maxProcessingMs: number;
  /** Job expiry in ms after terminal status. */
  readonly jobExpiryMs: number;
}

/** Where a piece of derived information came from. */
export interface SourceRef {
  readonly kind: 'element' | 'table' | 'section' | 'page' | 'sheet' | 'slide';
  readonly id: string;
  readonly label: string;
}

/** One structural element extracted from genuine parsing. */
export interface DocumentElement {
  readonly id: string;
  readonly type: 'heading' | 'paragraph' | 'listItem' | 'table' | 'link' | 'image' | 'code';
  readonly text: string;
  readonly level: number | null;
  readonly tableId: string | null;
  readonly imageCount: number | null;
  readonly linkUrl: string | null;
  readonly ref: SourceRef;
}

export interface DocumentTable {
  readonly id: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly truncated: boolean;
  readonly ref: SourceRef;
}

export interface DocumentSection {
  readonly id: string;
  readonly title: string;
  readonly elementIds: readonly string[];
  readonly ref: SourceRef;
}

/** Metadata entry parsed from genuine document metadata, never guessed. */
export interface DocumentMetadataEntry {
  readonly key: string;
  readonly value: string;
  readonly source: 'document';
}

export interface DocumentInspectionView {
  readonly fileId: FileAssetId;
  readonly format: DocumentFormat | 'unknown';
  readonly detectedFrom: 'magic-bytes';
  readonly byteSize: number;
  readonly capabilities: readonly DocumentCapability[];
  readonly simulated: boolean;
}

/** The parsed, deterministic structural view. Untrusted data by trust tag. */
export interface DocumentStructureView {
  readonly fileId: FileAssetId;
  readonly format: DocumentFormat;
  readonly elements: readonly DocumentElement[];
  readonly tables: readonly DocumentTable[];
  readonly sections: readonly DocumentSection[];
  readonly metadata: readonly DocumentMetadataEntry[];
  readonly pageCount: number | null;
  readonly slideCount: number | null;
  readonly sheetCount: number | null;
  readonly truncated: boolean;
  readonly trustTag: 'untrusted_data';
}

export interface DocumentSearchMatch {
  readonly elementId: string;
  readonly snippet: string;
  readonly score: number;
}

export interface DocumentExactSearchResult {
  readonly fileId: FileAssetId;
  readonly matches: readonly DocumentSearchMatch[];
  readonly total: number;
  readonly truncated: boolean;
  readonly trustTag: 'untrusted_data';
}

export interface DocumentEvidenceQuote {
  readonly quote: string;
  readonly ref: SourceRef;
}

export interface DocumentAnswerView {
  readonly fileId: FileAssetId;
  readonly question: string;
  readonly answer: string;
  readonly evidence: readonly DocumentEvidenceQuote[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly trustTag: 'ai_generated';
}

export type DocumentSummaryMode = 'brief' | 'bullets' | 'executive';

export interface DocumentSummaryView {
  readonly fileId: FileAssetId;
  readonly mode: DocumentSummaryMode;
  readonly summary: string;
  readonly trustTag: 'ai_generated';
}

export interface DocumentEntity {
  readonly name: string;
  readonly type: string;
}

export interface DocumentEntitiesView {
  readonly fileId: FileAssetId;
  readonly entities: readonly DocumentEntity[];
  readonly trustTag: 'ai_generated';
}

export interface DocumentComparisonPoint {
  readonly label: string;
  readonly left: string;
  readonly right: string;
}

export interface DocumentComparisonView {
  readonly leftFileId: FileAssetId;
  readonly rightFileId: FileAssetId;
  readonly summary: string;
  readonly points: readonly DocumentComparisonPoint[];
  readonly trustTag: 'ai_generated';
}

export interface DocumentOcrView {
  readonly fileId: FileAssetId;
  readonly text: string;
  readonly truncated: boolean;
  readonly trustTag: 'untrusted_data';
}

export interface SpreadsheetColumnStats {
  readonly header: string;
  readonly numericCount: number;
  readonly numericRatio: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly sum: number | null;
  readonly mean: number | null;
}

export interface SpreadsheetSheetView {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly headers: readonly string[];
  /** Bounded data rows (never more than the row limit, 64 columns wide). */
  readonly rows: readonly (readonly string[])[];
  readonly formulaCells: number;
  readonly stats: readonly SpreadsheetColumnStats[];
}

export interface DocumentSpreadsheetView {
  readonly fileId: FileAssetId;
  readonly sheets: readonly SpreadsheetSheetView[];
  readonly truncated: boolean;
  readonly trustTag: 'untrusted_data';
}

export interface PresentationSlideView {
  readonly index: number;
  readonly title: string;
  readonly bulletTexts: readonly string[];
  readonly notes: string;
}

export interface DocumentPresentationView {
  readonly fileId: FileAssetId;
  readonly slides: readonly PresentationSlideView[];
  readonly truncated: boolean;
  readonly trustTag: 'untrusted_data';
}

/** A non-authoritative memory candidate derived from a processed document. */
export interface DocumentMemoryCandidate {
  readonly title: string;
  readonly content: string;
  readonly source: 'system_derived';
  readonly sourceKind: 'document_analysis';
  readonly elementIds: readonly string[];
}

export type DocumentJobStatus =
  | 'received'
  | 'parsing'
  | 'parsed'
  | 'reasoning'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface DocumentJobError {
  readonly code: DocumentErrorCode;
  readonly message: string;
}

export interface DocumentProcessingJob {
  readonly jobId: string;
  readonly fileId: FileAssetId;
  readonly status: DocumentJobStatus;
  readonly error: DocumentJobError | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** Derivative exports a caller may publish through the Step 19 file system. */
export const DOCUMENT_ARTIFACT_KINDS = [
  'document_structure_json',
  'document_text_md',
  'document_tables_csv',
  'document_summary_md',
  'document_entities_json',
  'document_search_json',
  'document_comparison_json',
] as const;
export type DocumentArtifactKind = (typeof DOCUMENT_ARTIFACT_KINDS)[number];

export interface DocumentArtifactInput {
  readonly kind: DocumentArtifactKind;
  /** Optional summary mode for document_summary_md. */
  readonly mode?: DocumentSummaryMode;
  /** Optional query for document_search_json. */
  readonly query?: string;
  /** Optional second document for document_comparison_json. */
  readonly otherFileId?: FileAssetId | null;
}

export interface DocumentArtifactView {
  readonly id: FileAssetId;
  readonly kind: DocumentArtifactKind;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

/** A parsed structure record kept after processing. */
export interface DocumentAnalysisRecord {
  readonly structure: DocumentStructureView;
  readonly processedAt: string;
  readonly jobId: string | null;
}
