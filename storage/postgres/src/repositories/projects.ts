/**
 * Project storage.
 *
 * Every statement carries the owner predicate and the caller's owner comes from
 * the async scope, never from the request body. `update` locks the row inside a
 * transaction so two writers cannot both pass the revision check and then
 * overwrite each other - the second one loses with the same
 * `RevisionConflictError` the in-memory repository throws, so the API contract
 * is unchanged.
 */

import { randomUUID } from 'node:crypto';

import {
  ProjectNotFoundError,
  RevisionConflictError,
  type NewProject,
  type Project,
  type ProjectChangeSet,
  type ProjectRepository,
  type ProjectStatus,
} from '@veltravia/project-core';

import type { Queryable } from '../pool.js';
import { assertOwnerMatch, requireOwner } from '../owner-scope.js';

export interface ProjectRow {
  id: string;
  owner_ref: string;
  name: string;
  description: string;
  status: string;
  project_type: string;
  version: string;
  workspace_id: string | null;
  revision: number;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    projectType: row.project_type as Project['projectType'],
    ownerRef: row.owner_ref,
    workspaceId: row.workspace_id,
    version: row.version,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    metadata: Object.freeze((row.metadata ?? {}) as Record<string, unknown>),
  };
}

export interface PostgresProjectRepositoryOptions {
  readonly generateId?: () => string;
  readonly now?: () => Date;
}

export class PostgresProjectRepository implements ProjectRepository {
  private readonly query: Queryable;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  constructor(query: Queryable, options: PostgresProjectRepositoryOptions = {}) {
    this.query = query;
    this.generateId = options.generateId ?? (() => `prj_${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async create(input: NewProject): Promise<Project> {
    const owner = assertOwnerMatch(input.ownerRef);
    const id = this.generateId();
    const now = this.now();
    const rows = await this.query.query<ProjectRow>(
      `insert into projects
         (id, owner_ref, name, description, status, project_type, version,
          workspace_id, revision, metadata, created_at, updated_at)
       values ($1, $2, $3, $4, 'active', $5, $6, null, 1, $7, $8, $8)
       returning *`,
      [
        id,
        owner,
        input.name,
        input.description,
        input.projectType,
        input.version,
        JSON.stringify(input.metadata ?? {}),
        now,
      ],
    );
    return toProject(rows.rows[0]!);
  }

  async get(projectId: string): Promise<Project | null> {
    const owner = requireOwner();
    const rows = await this.query.query<ProjectRow>(
      'select * from projects where id = $1 and owner_ref = $2',
      [projectId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toProject(row);
  }

  async list(options?: {
    readonly includeDeleted?: boolean;
    readonly ownerRef?: string;
  }): Promise<Project[]> {
    const owner = requireOwner();
    if (options?.ownerRef !== undefined && options.ownerRef !== owner) return [];
    const includeDeleted = options?.includeDeleted ?? false;
    const rows = await this.query.query<ProjectRow>(
      `select * from projects
        where owner_ref = $1 ${includeDeleted ? '' : "and status <> 'deleted'"}
        order by created_at asc, id asc`,
      [owner],
    );
    return rows.rows.map(toProject);
  }

  async update(projectId: string, change: ProjectChangeSet): Promise<Project> {
    const owner = requireOwner();
    // Compare-and-swap in one statement: the row is only written when it still
    // carries the caller's revision, so a concurrent writer cannot be
    // overwritten by a stale one.
    const rows = await this.query.query<ProjectRow>(
      `update projects
          set name = coalesce($4, name),
              description = coalesce($5, description),
              status = coalesce($6, status),
              version = coalesce($7, version),
              workspace_id = case when $8::boolean then $9 else workspace_id end,
              metadata = coalesce($10::jsonb, metadata),
              revision = revision + 1,
              updated_at = $3
        where id = $1 and owner_ref = $2 and revision = $11
      returning *`,
      [
        projectId,
        owner,
        change.updatedAt,
        change.patch.name ?? null,
        change.patch.description ?? null,
        change.patch.status ?? null,
        change.patch.version ?? null,
        change.patch.workspaceId !== undefined,
        change.patch.workspaceId ?? null,
        change.patch.metadata === undefined ? null : JSON.stringify(change.patch.metadata),
        change.expectedRevision,
      ],
    );
    const updated = rows.rows[0];
    if (updated !== undefined) return toProject(updated);

    // Nothing was written. Distinguish "not yours / not there" from a lost
    // revision race without confirming whether another owner holds the id.
    const existing = await this.query.query<{ revision: number }>(
      'select revision from projects where id = $1 and owner_ref = $2',
      [projectId, owner],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new ProjectNotFoundError(projectId);
    throw new RevisionConflictError('project', change.expectedRevision, row.revision);
  }
}
