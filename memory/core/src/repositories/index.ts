/**
 * The persistence boundary for the Project Memory & Knowledge System.
 *
 * The core package depends on this interface ONLY - never on a concrete
 * database. `memory-mock` provides the deterministic in-memory
 * implementation used by tests and the development API today; a real
 * database adapter implements the same interface later.
 */

import type {
  CreateMemoryInput,
  MemoryListQuery,
  MemorySearchQuery,
  MemoryStatus,
  ProjectMemory,
} from '../types/index.js';

/** The subset of fields the repository may set on update. */
export interface MemoryRecordPatch {
  readonly title?: string;
  readonly content?: string;
  readonly type?: ProjectMemory['type'];
  readonly confidence?: ProjectMemory['confidence'];
  readonly status?: MemoryStatus;
  readonly verificationStatus?: ProjectMemory['verificationStatus'];
  readonly lastVerifiedAt?: string | null;
}

export interface MemorySearchResult {
  readonly memories: readonly ProjectMemory[];
  readonly totalMatched: number;
}

export interface MemoryRepository {
  /** Stores a new record. The repository assigns id, revision, timestamps. */
  create(input: CreateMemoryInput): Promise<ProjectMemory>;
  /**
   * Returns the record ONLY when it exists in the given project scope.
   * Cross-project lookups resolve to null - existence is never leaked.
   */
  get(memoryId: string, projectId: string): Promise<ProjectMemory | null>;
  /**
   * Applies a patch. Implementations must enforce the revision check:
   * a mismatch rejects with nothing written (typed conflict surfaces
   * through the manager, which reloads to report the current revision).
   */
  update(
    memoryId: string,
    projectId: string,
    expectedRevision: number,
    patch: MemoryRecordPatch,
  ): Promise<ProjectMemory | null>;
  /** Lists records for one project, deterministically ordered, bounded. */
  list(query: MemoryListQuery): Promise<readonly ProjectMemory[]>;
  /** Bounded text/field search with a totalMatched count. */
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  /** Counts stored records for one project (for limit enforcement). */
  count(projectId: string): Promise<number>;
  /** Permanently removes the record. Returns true when it existed. */
  delete(memoryId: string, projectId: string): Promise<boolean>;
}
