/**
 * RevisionStore port (Step 18).
 *
 * The storage boundary for revisions, snapshots, checkpoints, and rollback
 * operations. The core never persists anything itself; the in-memory mock
 * (version-control/mock) is a DETERMINISTIC development/CI adapter and is
 * NOT durable production storage. A future persistent store implements this
 * interface and nothing else changes.
 *
 * Store implementations must reject cross-project/ cross-workspace access
 * with the typed VersionError codes defined in ../errors.
 */

import type {
  Checkpoint,
  ProjectRevision,
  RevisionSnapshot,
  RollbackOperation,
} from '../types/index.js';

export interface StoreRevisionQuery {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly limit: number;
  readonly skip: number;
}

export interface RevisionStore {
  createRevision(revision: ProjectRevision, snapshot: RevisionSnapshot): Promise<void>;
  getRevision(revisionId: string): Promise<ProjectRevision | null>;
  /** Newest-first bounded page. */
  listRevisions(query: StoreRevisionQuery): Promise<{
    revisions: ProjectRevision[];
    total: number;
    hasMore: boolean;
  }>;
  getLatestRevision(projectId: string, workspaceId: string): Promise<ProjectRevision | null>;
  /** Returns revisions (oldest-first) eligible for retention eviction. */
  listRetentionCandidates(projectId: string, workspaceId: string): Promise<ProjectRevision[]>;
  /** Retention-only deletion of snapshots + records. Referenced revisions are excluded by the manager. */
  deleteRevision(revisionId: string): Promise<void>;
  getSnapshot(revisionId: string): Promise<RevisionSnapshot | null>;
  /** Approximate bytes held for a workspace (retention accounting). */
  estimateSnapshotBytes(projectId: string, workspaceId: string): Promise<number>;

  createCheckpoint(checkpoint: Checkpoint): Promise<void>;
  getCheckpoint(checkpointId: string): Promise<Checkpoint | null>;
  listCheckpoints(projectId: string, workspaceId: string): Promise<Checkpoint[]>;
  deleteCheckpoint(checkpointId: string): Promise<void>;

  saveOperation(operation: RollbackOperation): Promise<void>;
  getOperation(operationId: string): Promise<RollbackOperation | null>;
}
