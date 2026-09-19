/**
 * Persistence abstraction for codebase indexes (Phase 28).
 *
 * The repository stores index ARTIFACTS (paths, symbols, relationships,
 * evidence) - never raw file contents and never secret-shaped values.
 * Implementations live outside the analysis core (in-memory in the mock,
 * a real store later); the manager only depends on this interface.
 *
 * IMPORTANT: the repository is keyed by (projectId, workspaceId) - cross
 * project access is structurally impossible through the API layer, and
 * the manager enforces project/workspace association BEFORE any read.
 */

import type {
  CodebaseIndex,
  IndexedSymbol,
  SourcePath,
  SymbolRelationship,
} from '../types/index.js';

export interface CodebaseIndexRepository {
  /** Persists a NEW index (or replaces the previous one for the same key). */
  save(index: CodebaseIndex): Promise<void>;
  /** The stored index for one workspace, or null. */
  get(projectId: string, workspaceId: string): Promise<CodebaseIndex | null>;
  /** Updates an existing index in place (same identity, bumped revision). */
  update(index: CodebaseIndex): Promise<void>;
  /** Marks the stored index stale (source changed since it was built). */
  markStale(projectId: string, workspaceId: string): Promise<void>;
  /** Deletes the stored index. No-op when absent. */
  delete(projectId: string, workspaceId: string): Promise<void>;
  /** Symbol lookup helpers used by the search/trace engines. */
  findSymbols(
    projectId: string,
    workspaceId: string,
    predicate: (symbol: IndexedSymbol) => boolean,
    maxResults: number,
  ): Promise<readonly IndexedSymbol[]>;
  findRelationships(
    projectId: string,
    workspaceId: string,
    predicate: (relationship: SymbolRelationship) => boolean,
    maxResults: number,
  ): Promise<readonly SymbolRelationship[]>;
  getFileEntry(
    projectId: string,
    workspaceId: string,
    path: SourcePath,
  ): Promise<CodebaseIndex['files'][number] | null>;
}
