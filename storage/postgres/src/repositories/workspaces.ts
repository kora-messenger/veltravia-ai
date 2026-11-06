/**
 * Workspace storage.
 *
 * A workspace cannot be created under another owner's project: the composite
 * foreign key `(project_id, owner_ref)` makes that a database error, not an
 * application convention.
 */

import { randomUUID } from 'node:crypto';

import {
  type NewWorkspace,
  RevisionConflictError,
  type Workspace,
  type WorkspaceChangeSet,
  type WorkspaceRepository,
  WorkspaceNotFoundError,
  type WorkspaceStatus,
} from '@veltravia/project-core';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

interface WorkspaceRow {
  id: string;
  project_id: string;
  owner_ref: string;
  name: string;
  root: string;
  status: string;
  revision: number;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    root: row.root,
    status: row.status as WorkspaceStatus,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    metadata: Object.freeze((row.metadata ?? {}) as Record<string, unknown>),
  };
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  private readonly query: Queryable;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  constructor(query: Queryable, options: { generateId?: () => string; now?: () => Date } = {}) {
    this.query = query;
    this.generateId = options.generateId ?? (() => `ws_${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async create(input: NewWorkspace): Promise<Workspace> {
    const owner = requireOwner();
    const now = this.now();
    const rows = await this.query.query<WorkspaceRow>(
      `insert into workspaces
         (id, project_id, owner_ref, name, root, status, revision, metadata, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'active', 1, $6, $7, $7)
       returning *`,
      [
        this.generateId(),
        input.projectId,
        owner,
        input.name,
        input.root,
        JSON.stringify(input.metadata ?? {}),
        now,
      ],
    );
    return toWorkspace(rows.rows[0]!);
  }

  async get(workspaceId: string): Promise<Workspace | null> {
    const owner = requireOwner();
    const rows = await this.query.query<WorkspaceRow>(
      'select * from workspaces where id = $1 and owner_ref = $2',
      [workspaceId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toWorkspace(row);
  }

  async listByProject(projectId: string): Promise<Workspace[]> {
    const owner = requireOwner();
    const rows = await this.query.query<WorkspaceRow>(
      `select * from workspaces where project_id = $1 and owner_ref = $2
        order by created_at asc, id asc`,
      [projectId, owner],
    );
    return rows.rows.map(toWorkspace);
  }

  async update(workspaceId: string, change: WorkspaceChangeSet): Promise<Workspace> {
    const owner = requireOwner();
    const rows = await this.query.query<WorkspaceRow>(
      `update workspaces
          set name = coalesce($4, name),
              status = coalesce($5, status),
              metadata = coalesce($6::jsonb, metadata),
              revision = revision + 1,
              updated_at = $3
        where id = $1 and owner_ref = $2 and revision = $7
      returning *`,
      [
        workspaceId,
        owner,
        change.updatedAt,
        change.patch.name ?? null,
        change.patch.status ?? null,
        change.patch.metadata === undefined ? null : JSON.stringify(change.patch.metadata),
        change.expectedRevision,
      ],
    );
    const updated = rows.rows[0];
    if (updated !== undefined) return toWorkspace(updated);

    const existing = await this.query.query<{ revision: number }>(
      'select revision from workspaces where id = $1 and owner_ref = $2',
      [workspaceId, owner],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new WorkspaceNotFoundError(workspaceId);
    throw new RevisionConflictError('workspace', change.expectedRevision, row.revision);
  }

  async bumpRevision(workspaceId: string, updatedAt: string): Promise<Workspace> {
    const owner = requireOwner();
    const rows = await this.query.query<WorkspaceRow>(
      `update workspaces set revision = revision + 1, updated_at = $3
        where id = $1 and owner_ref = $2
      returning *`,
      [workspaceId, owner, updatedAt],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new WorkspaceNotFoundError(workspaceId);
    return toWorkspace(row);
  }
}
