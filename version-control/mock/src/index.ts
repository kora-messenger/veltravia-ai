/**
 * @veltravia/version-mock - DETERMINISTIC in-memory RevisionStore (Step 18).
 *
 * DEVELOPMENT/CI ADAPTER ONLY: all state lives in the process and is wiped
 * on restart. This is not durable production storage and never claims to
 * be. A future persistent store implements the same RevisionStore interface
 * and nothing else changes.
 */

import type {
  Checkpoint,
  ProjectRevision,
  RevisionSnapshot,
  RollbackOperation,
} from '@veltravia/version-core';
import type { RevisionStore, StoreRevisionQuery } from '@veltravia/version-core';

interface WorkspaceState {
  revisions: Map<string, ProjectRevision>;
  /** New records first (newest-first insertion order). */
  order: string[];
  snapshots: Map<string, RevisionSnapshot>;
  checkpoints: Map<string, Checkpoint>;
  checkpointOrder: string[];
}

export class InMemoryRevisionStore implements RevisionStore {
  private readonly workspaces: Map<string, WorkspaceState> = new Map();
  private readonly operations: Map<string, RollbackOperation> = new Map();

  private workspace(projectId: string, workspaceId: string): WorkspaceState {
    const key = `${projectId}::${workspaceId}`;
    let state = this.workspaces.get(key);
    if (state === undefined) {
      state = {
        revisions: new Map(),
        order: [],
        snapshots: new Map(),
        checkpoints: new Map(),
        checkpointOrder: [],
      };
      this.workspaces.set(key, state);
    }
    return state;
  }

  async createRevision(revision: ProjectRevision, snapshot: RevisionSnapshot): Promise<void> {
    const state = this.workspace(revision.projectId, revision.workspaceId);
    if (state.revisions.has(revision.id)) {
      throw new Error(`Revision "${revision.id}" already exists.`);
    }
    state.revisions.set(revision.id, revision);
    state.order.unshift(revision.id);
    state.snapshots.set(revision.id, snapshot);
  }

  async getRevision(revisionId: string): Promise<ProjectRevision | null> {
    for (const state of this.workspaces.values()) {
      const revision = state.revisions.get(revisionId);
      if (revision !== undefined) return revision;
    }
    return null;
  }

  async listRevisions(query: StoreRevisionQuery): Promise<{
    revisions: ProjectRevision[];
    total: number;
    hasMore: boolean;
  }> {
    const state = this.workspace(query.projectId, query.workspaceId);
    const page = state.order
      .slice(query.skip, query.skip + query.limit)
      .map((id) => state.revisions.get(id) as ProjectRevision);
    return {
      revisions: page,
      total: state.order.length,
      hasMore: query.skip + query.limit < state.order.length,
    };
  }

  async getLatestRevision(projectId: string, workspaceId: string): Promise<ProjectRevision | null> {
    const state = this.workspace(projectId, workspaceId);
    const latestId = state.order[0];
    return latestId === undefined ? null : (state.revisions.get(latestId) ?? null);
  }

  async listRetentionCandidates(
    projectId: string,
    workspaceId: string,
  ): Promise<ProjectRevision[]> {
    const state = this.workspace(projectId, workspaceId);
    // Oldest-first.
    return [...state.order].reverse().map((id) => state.revisions.get(id) as ProjectRevision);
  }

  async deleteRevision(revisionId: string): Promise<void> {
    for (const state of this.workspaces.values()) {
      if (state.revisions.delete(revisionId)) {
        state.order = state.order.filter((id) => id !== revisionId);
        state.snapshots.delete(revisionId);
        return;
      }
    }
  }

  async getSnapshot(revisionId: string): Promise<RevisionSnapshot | null> {
    for (const state of this.workspaces.values()) {
      const snapshot = state.snapshots.get(revisionId);
      if (snapshot !== undefined) return snapshot;
    }
    return null;
  }

  async estimateSnapshotBytes(projectId: string, workspaceId: string): Promise<number> {
    const state = this.workspace(projectId, workspaceId);
    let bytes = 0;
    for (const id of state.order) {
      const revision = state.revisions.get(id);
      bytes += revision?.totalBytes ?? 0;
    }
    return bytes;
  }

  async createCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const state = this.workspace(checkpoint.projectId, checkpoint.workspaceId);
    state.checkpoints.set(checkpoint.id, checkpoint);
    state.checkpointOrder.unshift(checkpoint.id);
  }

  async getCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    for (const state of this.workspaces.values()) {
      const checkpoint = state.checkpoints.get(checkpointId);
      if (checkpoint !== undefined) return checkpoint;
    }
    return null;
  }

  async listCheckpoints(projectId: string, workspaceId: string): Promise<Checkpoint[]> {
    const state = this.workspace(projectId, workspaceId);
    return state.checkpointOrder.map((id) => state.checkpoints.get(id) as Checkpoint);
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    for (const state of this.workspaces.values()) {
      if (state.checkpoints.delete(checkpointId)) {
        state.checkpointOrder = state.checkpointOrder.filter((id) => id !== checkpointId);
        return;
      }
    }
  }

  async saveOperation(operation: RollbackOperation): Promise<void> {
    this.operations.set(operation.id, operation);
  }

  async getOperation(operationId: string): Promise<RollbackOperation | null> {
    return this.operations.get(operationId) ?? null;
  }
}

/** Builds a fresh in-memory store. */
export function createInMemoryRevisionStore(): InMemoryRevisionStore {
  return new InMemoryRevisionStore();
}
