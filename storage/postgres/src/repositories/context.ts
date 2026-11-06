/**
 * Project context, config and integration references.
 *
 * These are small documents that belong to exactly one project. They are stored
 * as `jsonb` because their field set is defined by the engine, not by the
 * database, while the row that owns them (and therefore the owner check) stays
 * relational and cascades with the project.
 */

import {
  ProjectNotFoundError,
  type IntegrationReference,
  type ProjectConfig,
  type ProjectContext,
  type ProjectContextRepository,
  type IntegrationRepository,
} from '@veltravia/project-core';

import type { Queryable } from '../pool.js';
import { requireOwner } from '../owner-scope.js';

interface ContextRow {
  payload: unknown;
  revision: number;
}

export class PostgresProjectContextRepository implements ProjectContextRepository {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async getContext(projectId: string): Promise<ProjectContext | null> {
    const owner = requireOwner();
    const rows = await this.query.query<ContextRow>(
      'select payload, revision from project_contexts where project_id = $1 and owner_ref = $2',
      [projectId, owner],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return { ...(row.payload as Omit<ProjectContext, 'revision'>), revision: row.revision };
  }

  async saveContext(
    projectId: string,
    context: Omit<ProjectContext, 'revision' | 'updatedAt'>,
    updatedAt: string,
  ): Promise<ProjectContext> {
    const owner = requireOwner();
    const rows = await this.query.query<ContextRow>(
      `insert into project_contexts (project_id, owner_ref, payload, revision, updated_at)
       values ($1, $2, $3, 1, $4)
       on conflict (project_id) do update
         set payload = excluded.payload,
             revision = project_contexts.revision + 1,
             updated_at = excluded.updated_at
         where project_contexts.owner_ref = $2
       returning payload, revision`,
      [projectId, owner, JSON.stringify({ ...context, updatedAt }), updatedAt],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      // The project is not this owner's: report it exactly as a missing project.
      throw new ProjectNotFoundError(projectId);
    }
    return { ...(row.payload as Omit<ProjectContext, 'revision'>), revision: row.revision };
  }

  async getConfig(projectId: string): Promise<ProjectConfig | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown; revision: number; updated_at: Date }>(
      'select payload, revision, updated_at from project_configs where project_id = $1 and owner_ref = $2',
      [projectId, owner],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return {
      ...(row.payload as Record<string, unknown>),
      revision: row.revision,
      updatedAt: row.updated_at.toISOString(),
    } as ProjectConfig;
  }

  async saveConfig(
    projectId: string,
    config: Omit<ProjectConfig, 'revision' | 'updatedAt'>,
    updatedAt: string,
  ): Promise<ProjectConfig> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown; revision: number }>(
      `insert into project_configs (project_id, owner_ref, payload, revision, updated_at)
       values ($1, $2, $3, 1, $4)
       on conflict (project_id) do update
         set payload = excluded.payload,
             revision = project_configs.revision + 1,
             updated_at = excluded.updated_at
         where project_configs.owner_ref = $2
       returning payload, revision`,
      [projectId, owner, JSON.stringify(config), updatedAt],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new ProjectNotFoundError(projectId);
    return {
      ...(row.payload as Record<string, unknown>),
      revision: row.revision,
      updatedAt,
    } as ProjectConfig;
  }
}

export class PostgresIntegrationRepository implements IntegrationRepository {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  async upsert(
    projectId: string,
    reference: IntegrationReference,
    updatedAt: string,
  ): Promise<IntegrationReference> {
    const owner = requireOwner();
    const stored = { ...reference, linkedAt: updatedAt };
    await this.query.query(
      `insert into integration_refs (project_id, integration_ref, owner_ref, payload, updated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (project_id, integration_ref) do update
         set payload = excluded.payload, updated_at = excluded.updated_at
         where integration_refs.owner_ref = $3`,
      [projectId, reference.integrationRef, owner, JSON.stringify(stored), updatedAt],
    );
    return stored;
  }

  async list(projectId: string): Promise<IntegrationReference[]> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown }>(
      `select payload from integration_refs
        where project_id = $1 and owner_ref = $2 order by integration_ref asc`,
      [projectId, owner],
    );
    return rows.rows.map((row) => row.payload as IntegrationReference);
  }

  async get(projectId: string, integrationRef: string): Promise<IntegrationReference | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ payload: unknown }>(
      `select payload from integration_refs
        where project_id = $1 and integration_ref = $2 and owner_ref = $3`,
      [projectId, integrationRef, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : (row.payload as IntegrationReference);
  }

  async remove(projectId: string, integrationRef: string): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `delete from integration_refs
        where project_id = $1 and integration_ref = $2 and owner_ref = $3`,
      [projectId, integrationRef, owner],
    );
  }
}
