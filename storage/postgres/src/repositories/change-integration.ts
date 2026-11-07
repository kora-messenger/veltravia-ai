/**
 * Change sets, approvals, integrations, artifacts and locks over PostgreSQL
 * (Step 46).
 *
 * The manager already resolved ownership through the project port; these
 * stores still scope every statement to the request's owner, so a caller that
 * passes another owner's id reads nothing.
 */

import type {
  ApprovalStore,
  ChangeArtifactPort,
  ChangeSetStore,
  ChangeSetStatus,
  IntegrationApproval,
  IntegrationLockPort,
  IntegrationRecord,
  IntegrationStatus,
  IntegrationStore,
  WorkerChangeSet,
} from '@veltravia/change-integration-core';

import { requireOwner } from '../owner-scope.js';
import type { Queryable } from '../pool.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class PostgresChangeSetStore implements ChangeSetStore {
  constructor(private readonly query: Queryable) {}

  async insert(changeSet: WorkerChangeSet): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into change_sets
         (id, owner_ref, project_id, workspace_id, task_id, worker_id, status,
          base_revision, integration_id, record)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id, owner_ref) do update
         set status = excluded.status,
             integration_id = excluded.integration_id,
             record = excluded.record,
             updated_at = now()
         where change_sets.owner_ref = $2`,
      [
        changeSet.id,
        owner,
        changeSet.projectId,
        changeSet.workspaceId,
        changeSet.taskId,
        changeSet.workerId,
        changeSet.status,
        changeSet.baseRevision,
        changeSet.integrationId,
        JSON.stringify(changeSet),
      ],
    );
    for (const file of changeSet.files) {
      await this.query.query(
        `insert into change_set_files
           (change_set_id, owner_ref, path, op, base_hash, proposed_hash, size, artifact_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (change_set_id, owner_ref, path) do update
           set op = excluded.op,
               base_hash = excluded.base_hash,
               proposed_hash = excluded.proposed_hash,
               size = excluded.size,
               artifact_ref = excluded.artifact_ref`,
        [
          changeSet.id,
          owner,
          file.path,
          file.op,
          file.baseHash,
          file.proposedHash,
          file.size,
          file.artifactRef,
        ],
      );
    }
  }

  async update(changeSet: WorkerChangeSet): Promise<void> {
    return this.insert(changeSet);
  }

  async get(ownerRef: string, changeSetId: string): Promise<WorkerChangeSet | null> {
    const owner = requireOwner();
    if (ownerRef.trim() !== owner) return null;
    const rows = await this.query.query<{ record: unknown }>(
      `select record from change_sets where id = $1 and owner_ref = $2`,
      [changeSetId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : clone(row.record as WorkerChangeSet);
  }

  async list(
    ownerRef: string,
    filter: {
      projectId?: string;
      taskId?: string;
      workerId?: string;
      status?: readonly ChangeSetStatus[];
      limit?: number;
    } = {},
  ): Promise<readonly WorkerChangeSet[]> {
    const owner = requireOwner();
    if (ownerRef.trim() !== owner) return [];
    const rows = await this.query.query<{ record: unknown }>(
      `select record from change_sets
        where owner_ref = $1
          and ($2::text is null or project_id = $2)
          and ($3::text is null or task_id = $3)
          and ($4::text is null or worker_id = $4)
          and ($5::text[] is null or status = any($5))
        order by created_at desc
        limit $6`,
      [
        owner,
        filter.projectId ?? null,
        filter.taskId ?? null,
        filter.workerId ?? null,
        filter.status === undefined ? null : [...filter.status],
        filter.limit ?? 100,
      ],
    );
    return rows.rows.map((row) => clone(row.record as WorkerChangeSet));
  }
}

export class PostgresChangeArtifacts implements ChangeArtifactPort {
  constructor(private readonly query: Queryable) {}

  async put(input: { changeSetId: string; path: string; content: string }): Promise<string> {
    const owner = requireOwner();
    await this.query.query(
      `insert into change_artifacts (change_set_id, owner_ref, path, content)
       values ($1, $2, $3, $4)
       on conflict (change_set_id, owner_ref, path) do update set content = excluded.content`,
      [input.changeSetId, owner, input.path, input.content],
    );
    return `${input.changeSetId}::${input.path}`;
  }

  async get(input: { changeSetId: string; path: string }): Promise<string | null> {
    const owner = requireOwner();
    const rows = await this.query.query<{ content: string }>(
      `select content from change_artifacts
        where change_set_id = $1 and owner_ref = $2 and path = $3`,
      [input.changeSetId, owner, input.path],
    );
    return rows.rows[0]?.content ?? null;
  }

  async delete(changeSetId: string): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `delete from change_artifacts where change_set_id = $1 and owner_ref = $2`,
      [changeSetId, owner],
    );
  }
}

export class PostgresIntegrationApprovalStore implements ApprovalStore {
  constructor(private readonly query: Queryable) {}

  async insert(approval: IntegrationApproval): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into integration_approvals (id, owner_ref, project_id, decision, record)
       values ($1, $2, $3, $4, $5)
       on conflict (id, owner_ref) do nothing`,
      [approval.id, owner, approval.projectId, approval.decision, JSON.stringify(approval)],
    );
  }

  async get(ownerRef: string, approvalId: string): Promise<IntegrationApproval | null> {
    const owner = requireOwner();
    if (ownerRef.trim() !== owner) return null;
    const rows = await this.query.query<{ record: unknown }>(
      `select record from integration_approvals where id = $1 and owner_ref = $2`,
      [approvalId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : clone(row.record as IntegrationApproval);
  }

  async list(ownerRef: string, projectId?: string): Promise<readonly IntegrationApproval[]> {
    const owner = requireOwner();
    if (ownerRef.trim() !== owner) return [];
    const rows = await this.query.query<{ record: unknown }>(
      `select record from integration_approvals
        where owner_ref = $1 and ($2::text is null or project_id = $2)
        order by created_at desc limit 100`,
      [owner, projectId ?? null],
    );
    return rows.rows.map((row) => clone(row.record as IntegrationApproval));
  }
}

export class PostgresIntegrationRecordStore implements IntegrationStore {
  constructor(private readonly query: Queryable) {}

  async insert(record: IntegrationRecord): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `insert into change_integrations
         (id, owner_ref, project_id, workspace_id, approval_id, status,
          base_revision, result_revision, rollback_snapshot_id, record)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id, owner_ref) do nothing`,
      [
        record.id,
        owner,
        record.projectId,
        record.workspaceId,
        record.approvalId,
        record.status,
        record.baseRevision,
        record.resultRevision,
        record.rollbackSnapshotId,
        JSON.stringify(record),
      ],
    );
  }

  async update(record: IntegrationRecord): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `update change_integrations
          set status = $3, result_revision = $4, rollback_snapshot_id = $5,
              record = $6, updated_at = now()
        where id = $1 and owner_ref = $2`,
      [
        record.id,
        owner,
        record.status,
        record.resultRevision,
        record.rollbackSnapshotId,
        JSON.stringify(record),
      ],
    );
  }

  async get(ownerRef: string, integrationId: string): Promise<IntegrationRecord | null> {
    const owner = requireOwner();
    if (ownerRef.trim() !== owner) return null;
    const rows = await this.query.query<{ record: unknown }>(
      `select record from change_integrations where id = $1 and owner_ref = $2`,
      [integrationId, owner],
    );
    const row = rows.rows[0];
    return row === undefined ? null : clone(row.record as IntegrationRecord);
  }

  async list(
    ownerRef: string,
    filter: { projectId?: string; status?: readonly IntegrationStatus[]; limit?: number } = {},
  ): Promise<readonly IntegrationRecord[]> {
    const owner = requireOwner();
    if (ownerRef.trim() !== owner) return [];
    const rows = await this.query.query<{ record: unknown }>(
      `select record from change_integrations
        where owner_ref = $1
          and ($2::text is null or project_id = $2)
          and ($3::text[] is null or status = any($3))
        order by created_at desc
        limit $4`,
      [
        owner,
        filter.projectId ?? null,
        filter.status === undefined ? null : [...filter.status],
        filter.limit ?? 100,
      ],
    );
    return rows.rows.map((row) => clone(row.record as IntegrationRecord));
  }
}

/**
 * Cross-process project exclusion.
 *
 * `insert ... on conflict` only wins when the existing lease has expired, so
 * the decision is made by the database rather than by a read followed by a
 * write.
 */
export class PostgresIntegrationLocks implements IntegrationLockPort {
  constructor(
    private readonly query: Queryable,
    private readonly ttlMs = 60_000,
  ) {}

  async acquire(projectId: string, token: string): Promise<boolean> {
    const owner = requireOwner();
    const rows = await this.query.query<{ token: string }>(
      `insert into project_integration_locks (project_id, owner_ref, token, expires_at)
       values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
       on conflict (project_id) do update
         set owner_ref = excluded.owner_ref,
             token = excluded.token,
             acquired_at = now(),
             expires_at = excluded.expires_at
         where project_integration_locks.expires_at < now()
            or project_integration_locks.token = excluded.token
       returning token`,
      [projectId, owner, token, String(this.ttlMs)],
    );
    return rows.rows[0]?.token === token;
  }

  async release(projectId: string, token: string): Promise<void> {
    const owner = requireOwner();
    await this.query.query(
      `delete from project_integration_locks
        where project_id = $1 and owner_ref = $2 and token = $3`,
      [projectId, owner, token],
    );
  }

  async held(projectId: string): Promise<string | null> {
    requireOwner();
    const rows = await this.query.query<{ token: string }>(
      `select token from project_integration_locks
        where project_id = $1 and expires_at > now()`,
      [projectId],
    );
    return rows.rows[0]?.token ?? null;
  }
}
