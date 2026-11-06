/**
 * Native export types.
 *
 * Nothing here carries file CONTENT except the archive bytes themselves, and
 * nothing carries a secret VALUE: an exclusion names a path and a reason.
 */

export const EXPORT_LIMITS = {
  /** Most files one archive may hold. */
  maxFiles: 2000,
  /** Largest single file included, in bytes (matches source storage). */
  maxFileBytes: 512 * 1024,
  /** Most uncompressed bytes one archive may hold. */
  maxTotalBytes: 32 * 1024 * 1024,
  /** Largest finished archive kept for download, in bytes. */
  maxArchiveBytes: 32 * 1024 * 1024,
  /** Longest path accepted, in characters. */
  maxPathLength: 512,
  /** Most paths a selection may name. */
  maxSelectionPaths: 100,
  /** How many times a changing project is re-read before giving up. */
  maxConsistencyAttempts: 3,
  /** Archives kept per owner before the oldest is dropped. */
  maxArchivesPerOwner: 10,
  /** Milliseconds a finished archive stays downloadable. */
  archiveTtlMs: 15 * 60 * 1000,
} as const;

export type ExportScope = 'project' | 'selection';

/** Why a file was left out. Reasons are fixed words: they never echo content. */
export type ExclusionReason =
  | 'credential-file' // .env, key files, .npmrc ...
  | 'secret-in-content' // content looks like a credential
  | 'too-large' // over the per-file limit
  | 'total-size-limit' // archive size ceiling reached
  | 'file-count-limit' // archive file ceiling reached
  | 'unreadable'; // the file vanished or could not be read

export interface ExcludedFile {
  readonly path: string;
  readonly reason: ExclusionReason;
  /** One plain sentence. Never contains file content or a matched value. */
  readonly detail: string;
}

export interface IncludedFile {
  readonly path: string;
  readonly size: number;
  readonly contentHash: string;
}

export type ExportStatus = 'running' | 'ready' | 'failed' | 'expired';

export type ExportFailureCode =
  | 'EXPORT_INVALID_REQUEST'
  | 'EXPORT_PATH_INVALID'
  | 'EXPORT_SELECTION_EMPTY'
  | 'EXPORT_NOTHING_TO_EXPORT'
  | 'EXPORT_REVISION_CONFLICT'
  | 'EXPORT_TOO_LARGE'
  | 'EXPORT_NOT_FOUND'
  | 'EXPORT_NOT_READY'
  | 'EXPORT_EXPIRED'
  | 'EXPORT_RATE_LIMITED'
  | 'EXPORT_INTERNAL';

export interface ExportFailure {
  readonly code: ExportFailureCode;
  readonly message: string;
}

/** Everything the API returns about an export. Never includes archive bytes. */
export interface ExportView {
  readonly exportId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly scope: ExportScope;
  /** The paths a selection asked for (empty for a whole-project export). */
  readonly selection: readonly string[];
  readonly status: ExportStatus;
  /** The workspace revision every included file was read at. */
  readonly revision: number | null;
  readonly fileName: string | null;
  readonly archiveBytes: number | null;
  readonly archiveHash: string | null;
  readonly included: readonly IncludedFile[];
  readonly excluded: readonly ExcludedFile[];
  readonly totals: { readonly files: number; readonly bytes: number };
  /** How many times the tree changed under the export and was re-read. */
  readonly consistencyRetries: number;
  readonly failure: ExportFailure | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}
