/**
 * Version history: revisions, their snapshots, checkpoints, rollback
 * operations and branches.
 *
 * A revision and its snapshot are written in one transaction, because a
 * revision record without its snapshot is a restore that can never succeed.
 * Snapshots are `jsonb` here: they are already a bounded, content-addressed
 * manifest produced by the version-control core, and keeping them beside the
 * revision record keeps listing and restoring a single read.
 */

import {
  type ActiveBranch,
  type Branch,
  type BranchStore,
  type Checkpoint,
  type ProjectRevision,
  type RevisionSnapshot,
  type RevisionStore,
  type RollbackOperation,
  type StoreRevisionQuery,
} from '@veltravia/version-core';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

interface RevisionRow {
  payload: unknown;
  snapshot: unknown;
}

interface BranchRow {
  payload: unknown;
}

export class PostgresRevisionStore implements RevisionStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async createRevision(revision: ProjectRevision, snapshot: RevisionSnapshot): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into revisions
         (id, project_id, workspace_id, owner_ref, revision_number, payload, snapshot, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        revision.id,
        revision.projectId,
        revision.workspaceId,
        owner,
        revision.revisionNumber,
        JSON.stringify(revision),
        JSON.stringify(snapshot),
        revision.createdAt,
      ],
    );
  }

  async getRevision(revisionId: string): Promise<ProjectRevision | null> {
    const owner = requireOwner();
    const rows = await this.query.query<RevisionRow>(
      'select payload, snapshot from revisions where id = $1 and owner_ref = $2',
      [revisionId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.payload as ProjectRevision);
  }

  async listRevisions(query: StoreRevisionQuery): Promise<{
    revisions: ProjectRevision[];
    total: number;
    hasMore: boolean;
  }> {
    const owner = requireOwner();
    const total = await this.query.query<{ total: number }>(
      `select count(*)::int as total from revisions
        where project_id = $1 and workspace_id = $2 and owner_ref = $3`,
      [query.projectId, query.workspaceId, owner],
    );
    const rows = await this.query.query<RevisionRow>(
      `select payload, snapshot from revisions
        where project_id = $1 and workspace_id = $2 and owner_ref = $3
        order by revision_number desc, created_at desc
        limit $4 offset $5`,
      [query.projectId, query.workspaceId, owner, query.limit, query.skip],
    );
    const totalCount = Number(total.rows[0]?.total ?? 0);
    return {
      revisions: rows.rows.map((row) => row.payload as ProjectRevision),
      total: totalCount,
      hasMore: query.skip + rows.rows.length < totalCount,
    };
  }

  async getLatestRevision(projectId: string, workspaceId: string): Promise<ProjectRevision | null> {
    const owner = requireOwner();
    const rows = await this.query.query<RevisionRow>(
      `select payload, snapshot from revisions
        where project_id = $1 and workspace_id = $2 and owner_ref = $3
        order by revision_number desc, created_at desc
        limit 1`,
      [projectId, workspaceId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.payload as ProjectRevision);
  }

  async listRetentionCandidates(
    projectId: string,
    workspaceId: string,
  ): Promise<ProjectRevision[]> {
    const owner = requireOwner();
    const rows = await this.query.query<RevisionRow>(
      `select payload, snapshot from revisions
        where project_id = $1 and workspace_id = $2 and owner_ref = $3
        order by revision_number asc, created_at asc`,
      [projectId, workspaceId, owner],
    );
    return rows.rows.map((row) => row.payload as ProjectRevision);
  }

  async deleteRevision(revisionId: string): Promise<void> {
    const owner = requireOwner();
    await this.query.query('delete from revisions where id = $1 and owner_ref = $2', [
      revisionId,
      owner,
    ]);
  }

  async getSnapshot(revisionId: string): Promise<RevisionSnapshot | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ snapshot: unknown }>(
      'select snapshot from revisions where id = $1 and owner_ref = $2',
      [revisionId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.snapshot as RevisionSnapshot);
  }

  async estimateSnapshotBytes(projectId: string, workspaceId: string): Promise<number> {
    const owner = requireOwner();
    // Uses the byte total recorded on each revision rather than measuring the
    // stored jsonb, so retention accounting matches what the manifest reports.
    const rows = await this.query.query<{ bytes: string | number | null }>(
      `select coalesce(sum((payload->>'totalBytes')::bigint), 0) as bytes
         from revisions
        where project_id = $1 and workspace_id = $2 and owner_ref = $3`,
      [projectId, workspaceId, owner],
    );
    return Number(rows.rows[0]?.bytes ?? 0);
  }

  async createCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into checkpoints (id, project_id, workspace_id, owner_ref, payload, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        checkpoint.id,
        checkpoint.projectId,
        checkpoint.workspaceId,
        owner,
        JSON.stringify(checkpoint),
        checkpoint.createdAt,
      ],
    );
  }

  async getCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown }>(
      'select payload from checkpoints where id = $1 and owner_ref = $2',
      [checkpointId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.payload as Checkpoint);
  }

  async listCheckpoints(projectId: string, workspaceId: string): Promise<Checkpoint[]> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown }>(
      `select payload from checkpoints
        where project_id = $1 and workspace_id = $2 and owner_ref = $3
        order by created_at asc, id asc`,
      [projectId, workspaceId, owner],
    );
    return rows.rows.map((row) => row.payload as Checkpoint);
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    const owner = requireOwner();
    await this.query.query('delete from checkpoints where id = $1 and owner_ref = $2', [
      checkpointId,
      owner,
    ]);
  }

  async saveOperation(operation: RollbackOperation): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into rollback_operations (id, project_id, workspace_id, owner_ref, payload, created_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update
         set payload = excluded.payload
         where rollback_operations.owner_ref = $4`,
      [
        operation.id,
        operation.request.projectId,
        operation.request.workspaceId,
        owner,
        JSON.stringify(operation),
        operation.createdAt,
      ],
    );
  }

  async getOperation(operationId: string): Promise<RollbackOperation | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown }>(
      'select payload from rollback_operations where id = $1 and owner_ref = $2',
      [operationId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.payload as RollbackOperation);
  }
}

export class PostgresBranchStore implements BranchStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async createBranch(branch: Branch): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into branches
         (id, project_id, owner_ref, workspace_id, name, archived, payload, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        branch.id,
        branch.projectId,
        owner,
        branch.workspaceId,
        branch.name,
        branch.state === 'archived',
        JSON.stringify(branch),
        new Date().toISOString(),
      ],
    );
  }

  async getBranch(branchId: string): Promise<Branch | null> {
    const owner = requireOwner();
    const rows = await this.query.query<BranchRow>(
      'select payload from branches where id = $1 and owner_ref = $2',
      [branchId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.payload as Branch);
  }

  async listBranches(projectId: string): Promise<Branch[]> {
    const owner = requireOwner();
    const rows = await this.query.query<BranchRow>(
      `select payload from branches
        where project_id = $1 and owner_ref = $2 order by name asc, id asc`,
      [projectId, owner],
    );
    return rows.rows.map((row) => row.payload as Branch);
  }

  async updateBranch(branch: Branch): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `update branches
          set name = $3, workspace_id = $4, archived = $5, payload = $6, updated_at = $7
        where id = $1 and owner_ref = $2`,
      [
        branch.id,
        owner,
        branch.name,
        branch.workspaceId,
        branch.state === 'archived',
        JSON.stringify(branch),
        new Date().toISOString(),
      ],
    );
  }

  async deleteBranch(branchId: string): Promise<void> {
    const owner = requireOwner();
    await this.query.query('delete from branches where id = $1 and owner_ref = $2', [
      branchId,
      owner,
    ]);
  }

  async getActive(projectId: string): Promise<ActiveBranch | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown }>(
      'select payload from active_branches where project_id = $1 and owner_ref = $2',
      [projectId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.payload as ActiveBranch);
  }

  async setActive(active: ActiveBranch): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into active_branches (project_id, owner_ref, payload, updated_at)
       values ($1, $2, $3, $4)
       on conflict (project_id, owner_ref) do update
         set payload = excluded.payload, updated_at = excluded.updated_at`,
      [active.projectId, owner, JSON.stringify(active), active.switchedAt],
    );
  }

  async findByWorkspace(workspaceId: string): Promise<Branch | null> {
    const owner = requireOwner();
    const rows = await this.query.query<BranchRow>(
      'select payload from branches where workspace_id = $1 and owner_ref = $2 limit 1',
      [workspaceId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.payload as Branch);
  }
}
