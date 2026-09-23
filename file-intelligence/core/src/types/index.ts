/** File bytes/text are UNTRUSTED DATA. These types never grant permissions or instructions. */
export type FileAssetId = string & { readonly __fileAssetId: unique symbol };
export type ArtifactId = string & { readonly __artifactId: unique symbol };
export const asFileAssetId = (value: string): FileAssetId => value as FileAssetId;
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId;

export const FILE_SOURCES = [
  'user_upload',
  'generated_artifact',
  'project_file',
  'connected_app_reference',
  'imported_archive',
  'derived_extraction',
] as const;
export type FileSource = (typeof FILE_SOURCES)[number];
export const FILE_STATUSES = [
  'received',
  'validating',
  'validated',
  'extracting',
  'ready',
  'processing',
  'derived',
  'expired',
  'deleted',
  'rejected',
  'corrupted',
] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];
export const FILE_TYPES = [
  'txt',
  'markdown',
  'json',
  'xml',
  'csv',
  'pdf',
  'docx',
  'xlsx',
  'code',
  'png',
  'jpeg',
  'webp',
  'gif',
  'zip',
  'audio',
  'video',
  'binary',
  'unknown',
] as const;
export type FileType = (typeof FILE_TYPES)[number];
export type FileCategory =
  | 'text'
  | 'document'
  | 'spreadsheet'
  | 'code'
  | 'image'
  | 'archive'
  | 'audio'
  | 'video'
  | 'binary'
  | 'unknown';

export interface FileScope {
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}
export interface FileContentReference {
  readonly storageKey: string;
  readonly byteLength: number;
  readonly checksum: string;
}
export interface FileMetadata {
  readonly originalFilename: string;
  readonly normalizedFilename: string;
  readonly declaredMimeType: string | null;
  readonly detectedMimeType: string;
  readonly detectedType: FileType;
  readonly category: FileCategory;
  readonly byteSize: number;
  readonly checksum: string;
  readonly extensionMismatch: boolean;
  readonly mimeMismatch: boolean;
  readonly encoding: string | null;
  readonly lineCount: number | null;
  readonly language: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
}
export interface FileAsset {
  readonly id: FileAssetId;
  readonly metadata: FileMetadata;
  readonly source: FileSource;
  readonly scope: FileScope;
  readonly status: FileStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly parentFileId: FileAssetId | null;
  readonly parentArtifactId: ArtifactId | null;
  readonly sourceOperation: string | null;
  readonly content: FileContentReference;
}
export interface FileValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: 'warning' | 'error';
}
export interface FileValidationResult {
  readonly valid: boolean;
  readonly declaredType: string | null;
  readonly detectedType: FileType;
  readonly issues: readonly FileValidationIssue[];
}
export interface ArchiveEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly detectedType: FileType;
}
export interface StructuredText {
  readonly kind: 'text';
  readonly text: string;
  readonly truncated: boolean;
  readonly totalCharacters: number;
}
export interface StructuredJson {
  readonly kind: 'json';
  readonly value: unknown;
  readonly textPreview: string;
  readonly truncated: boolean;
}
export interface StructuredXml {
  readonly kind: 'xml';
  readonly rootNames: readonly string[];
  readonly textPreview: string;
  readonly truncated: boolean;
}
export interface StructuredCsv {
  readonly kind: 'csv';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly totalRows: number;
  readonly truncated: boolean;
}
export interface StructuredDocument {
  readonly kind: 'document';
  readonly text: string;
  readonly pages: number | null;
  readonly headings: readonly string[];
  readonly truncated: boolean;
}
export interface StructuredWorkbook {
  readonly kind: 'workbook';
  readonly sheets: readonly {
    readonly name: string;
    readonly rows: number;
    readonly columns: number;
    readonly headers: readonly string[];
    readonly cells: readonly (readonly string[])[];
  }[];
  readonly truncated: boolean;
}
export interface StructuredCode {
  readonly kind: 'code';
  readonly language: string;
  readonly lineCount: number;
  readonly text: string;
  readonly truncated: boolean;
}
export interface StructuredArchive {
  readonly kind: 'archive';
  readonly entries: readonly ArchiveEntry[];
  readonly totalEntries: number;
  readonly totalUncompressedBytes: number;
  readonly truncated: boolean;
}
export interface StructuredMedia {
  readonly kind: 'media';
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
}
export type StructuredRepresentation =
  | StructuredText
  | StructuredJson
  | StructuredXml
  | StructuredCsv
  | StructuredDocument
  | StructuredWorkbook
  | StructuredCode
  | StructuredArchive
  | StructuredMedia;
export interface FileExtractionResult {
  readonly fileId: FileAssetId;
  readonly representation: StructuredRepresentation;
  readonly childFileIds: readonly FileAssetId[];
  readonly artifactIds: readonly ArtifactId[];
}
export interface FilePreview {
  readonly fileId: FileAssetId;
  readonly kind: 'text' | 'document' | 'image' | 'archive' | 'metadata';
  readonly text: string | null;
  readonly mediaMimeType: string | null;
  readonly entries: readonly ArchiveEntry[];
  readonly truncated: boolean;
  readonly trust: 'untrusted_data';
}

export const ARTIFACT_TYPES = [
  'generated_zip',
  'extracted_document',
  'transformed_csv',
  'generated_json',
  'generated_image',
  'generated_project_archive',
  'report',
  'exported_code_bundle',
  'derived_text',
  'generic',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export const ARTIFACT_STATUSES = [
  'creating',
  'validating',
  'ready',
  'expired',
  'deleted',
  'corrupted',
  'failed',
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];
export interface ArtifactMetadata {
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
}
export interface ArtifactReference {
  readonly storageKey: string;
  readonly byteLength: number;
  readonly checksum: string;
}
export interface ArtifactProvenance {
  readonly parentFileIds: readonly FileAssetId[];
  readonly parentArtifactIds: readonly ArtifactId[];
  readonly operationId: string;
  readonly statement: string;
}
export interface Artifact {
  readonly id: ArtifactId;
  readonly type: ArtifactType;
  readonly metadata: ArtifactMetadata;
  readonly scope: FileScope;
  readonly status: ArtifactStatus;
  readonly sourceOperation: string;
  readonly provenance: ArtifactProvenance;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly reference: ArtifactReference;
}
export interface DownloadReference {
  readonly token: string;
  readonly artifactId: ArtifactId;
  readonly expiresAt: string;
}
export interface FileLimits {
  readonly maxSingleFileBytes: number;
  readonly maxArchiveUncompressedBytes: number;
  readonly maxArchiveEntries: number;
  readonly maxPathLength: number;
  readonly maxNestingDepth: number;
  readonly maxArtifactBytesPerOperation: number;
  readonly maxTextExtractionCharacters: number;
  readonly maxCompressionRatio: number;
  readonly maxPreviewCharacters: number;
}
export interface FilePrincipal {
  readonly ownerRef: string;
  readonly allowedProjectIds?: readonly string[];
  readonly allowedWorkspaceIds?: readonly string[];
}
export interface RegisterFileInput {
  readonly filename: string;
  readonly declaredMimeType?: string;
  readonly bytes: Uint8Array;
  readonly source: FileSource;
  readonly scope: FileScope;
  readonly expiresAt?: string | null;
  readonly parentFileId?: FileAssetId | null;
  readonly parentArtifactId?: ArtifactId | null;
  readonly sourceOperation?: string | null;
}
export interface CreateArtifactInput {
  readonly type: ArtifactType;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly scope: FileScope;
  readonly sourceOperation: string;
  readonly parentFileIds?: readonly FileAssetId[];
  readonly parentArtifactIds?: readonly ArtifactId[];
  readonly expiresAt?: string | null;
}
