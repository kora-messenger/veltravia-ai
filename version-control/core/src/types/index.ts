/**
 * Version Control domain types (Step 18).
 *
 * Revisions are IMMUTABLE historical records of a workspace's tree at a
 * point in time. They are metadata + a snapshot reference: file CONTENTS
 * live only inside the RevisionStore's snapshot storage and are never
 * placed into revision metadata, audit events, API list responses, or UI
 * summaries. Contents are UNTRUSTED PROJECT DATA.
 */

/** Sources that can create a revision. Bounded and explicit. */
export const REVISION_SOURCES = [
  'manual',
  'generation_before',
  'generation_after',
  'testing_before_repair',
  'testing_after',
  'coding_before',
  'coding_after',
  'artifact_publish',
  'rollback',
] as const;

export type RevisionSource = (typeof REVISION_SOURCES)[number];

export function isRevisionSource(value: unknown): value is RevisionSource {
  return typeof value === 'string' && (REVISION_SOURCES as readonly string[]).includes(value);
}

/**
 * Revision lifecycle status.
 * - `active`: a normal historical revision.
 * - `restored`: the state of this revision was later restored by a rollback
 *   (informational lineage only - the revision itself is never modified).
 */
export const REVISION_STATUSES = ['active', 'restored'] as const;

export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export function isRevisionStatus(value: unknown): value is RevisionStatus {
  return typeof value === 'string' && (REVISION_STATUSES as readonly string[]).includes(value);
}

/** One workspace node captured in a snapshot (path + type + content hash). */
export interface SnapshotNode {
  /** Validated, normalized workspace-relative path. */
  readonly path: string;
  readonly type: 'file' | 'directory';
  /** Byte size of file content (0 for directories). */
  readonly size: number;
  /** sha256 hex of file content (empty string for directories). */
  readonly contentHash: string;
  /** File content (files only). UNTRUSTED DATA - never surfaced in metadata. */
  readonly content: string;
}

/** The reconstructable tree state of one revision. */
export interface RevisionSnapshot {
  readonly revisionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  /** sha256 over the full sorted node manifest - integrity anchor. */
  readonly manifestHash: string;
  readonly nodes: readonly SnapshotNode[];
  readonly capturedAt: string;
  readonly totalBytes: number;
}

/** Counts describing what changed relative to the parent revision. */
export interface RevisionChange {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly total: number;
}

/** An immutable revision record. Never mutated after creation. */
export interface ProjectRevision {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  /** The workspace revision number captured by this record. */
  readonly revisionNumber: number;
  readonly parentRevisionId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly source: RevisionSource;
  readonly status: RevisionStatus;
  readonly change: RevisionChange;
  /** Byte counts of the snapshot (metadata only - no content). */
  readonly fileCount: number;
  readonly totalBytes: number;
  /** sha256 manifest hash of the snapshot (integrity, never content). */
  readonly manifestHash: string;
  readonly message: string | null;
  /** Present only on rollback revisions: the revision whose state was restored. */
  readonly restoredFromRevisionId: string | null;
}

/** A named, stable recovery point referencing an immutable revision. */
export interface Checkpoint {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** The exact input of one rollback request. Never trusted from a client alone. */
export interface RollbackRequest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly targetRevisionId: string;
  /** The workspace revision the requester believes is current. */
  readonly expectedCurrentRevision: number;
  readonly reason: string | null;
}

export const ROLLBACK_OPERATION_STATES = [
  'pending_confirmation',
  'approved',
  'rejected',
  'completed',
  'failed',
] as const;

export type RollbackOperationState = (typeof ROLLBACK_OPERATION_STATES)[number];

export function isRollbackOperationState(value: unknown): value is RollbackOperationState {
  return (
    typeof value === 'string' && (ROLLBACK_OPERATION_STATES as readonly string[]).includes(value)
  );
}

/** One rollback operation - a single-use, confirmation-bound state machine. */
export interface RollbackOperation {
  readonly id: string;
  readonly request: RollbackRequest;
  readonly state: RollbackOperationState;
  readonly createdAt: string;
  /** Tool System confirmation id bound to the exact rollback input. */
  readonly confirmationId: string | null;
  readonly decidedAt: string | null;
  readonly completedAt: string | null;
  /** Typed failure code when state is `failed`. */
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  /** Set on success. */
  readonly result: RollbackResult | null;
}

/** What a successful rollback produced. */
export interface RollbackResult {
  /** The NEW revision record representing the restored state. */
  readonly newRevisionId: string;
  readonly newRevisionNumber: number;
  readonly restoredFromRevisionId: string;
  readonly restoredFromRevisionNumber: number;
  readonly filesChanged: number;
}

/** One file-level entry in a revision comparison. */
export type DiffEntryKind = 'added' | 'modified' | 'deleted' | 'unchanged' | 'renamed';

export interface DiffLine {
  /** `add` | `del` | `context`. */
  readonly kind: 'add' | 'del' | 'context';
  readonly text: string;
}

/** Bounded per-file diff. Line detail appears only when safe and within caps. */
export interface FileDiff {
  readonly path: string;
  readonly kind: DiffEntryKind;
  /** Previous path for renames. */
  readonly previousPath: string | null;
  readonly oldSize: number;
  readonly newSize: number;
  readonly sizeDelta: number;
  /** True when content is binary-like - no line detail is ever produced. */
  readonly binary: boolean;
  readonly lines: readonly DiffLine[];
  /** Truncation flags - the diff engine never streams unbounded output. */
  readonly linesTruncated: boolean;
}

/** Aggregate comparison between two revisions. */
export interface RevisionComparison {
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly unchanged: number;
  readonly renamed: number;
  readonly files: readonly FileDiff[];
  /** True when the file list was cut at the response cap. */
  readonly filesTruncated: boolean;
  readonly totalBytesChanged: number;
}

/** Lightweight reference used in safe list views. */
export interface RevisionReference {
  readonly id: string;
  readonly revisionNumber: number;
  readonly source: RevisionSource;
  readonly createdAt: string;
}
