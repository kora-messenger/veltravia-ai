/**
 * PostgreSQL persistence for Veltravia AI.
 *
 * Layering: application services depend on the ports exposed by the domain
 * packages (`ProjectRepository`, `RevisionStore`, `MemoryRepository`, ...).
 * This package is one adapter set for those ports. Swapping the database, or
 * moving archives to object storage, does not touch a service.
 */

import { PostgresTaskStore } from './repositories/tasks.js';
import { PostgresWorkerStore } from './repositories/workers.js';
import { PostgresVerificationStore } from './repositories/verification.js';
import { PostgresExecutionStore } from './repositories/executions.js';
import {
  PostgresEventInbox,
  PostgresIdempotencyStore,
  PostgresLeaseStore,
  PostgresOrchestrationRecoveryStore,
} from './repositories/reliability.js';
import { PostgresUsageStore } from './repositories/usage.js';
import { PostgresWalletStore } from './repositories/wallet.js';

import { PostgresRecoveryStore } from './repositories/recovery.js';
import {
  PostgresChangeArtifacts,
  PostgresChangeSetStore,
  PostgresIntegrationApprovalStore,
  PostgresIntegrationLocks,
  PostgresIntegrationRecordStore,
} from './repositories/change-integration.js';

export { PostgresTaskStore };
export { PostgresWorkerStore };
export { PostgresVerificationStore };
export { PostgresExecutionStore };
export { PostgresRecoveryStore };

export {
  type DatabaseConfig,
  type DatabaseSslMode,
  DatabaseConfigurationError,
  describeDatabaseConfig,
  parseDatabaseUrl,
  readDatabaseConfig,
} from './config.js';

export {
  DatabaseError,
  OwnerScopeMissingError,
  OwnerScopeMismatchError,
  type DatabaseErrorCategory,
  databaseHttpStatus,
  toDatabaseError,
} from './errors.js';

export {
  assertOwnerMatch,
  currentOwner,
  requireOwner,
  runWithOwner,
  type OwnerScope,
} from './owner-scope.js';

export {
  type CreateDatabaseOptions,
  type Database,
  type DatabaseHealth,
  type Queryable,
  createDatabase,
} from './pool.js';

export {
  type AppliedMigration,
  MIGRATIONS,
  type Migration,
  MigrationError,
  type MigrationResult,
  type SchemaStatus,
  type MigrateOptions,
  migrate,
  schemaStatus,
} from './migrations.js';

export { PostgresProjectRepository } from './repositories/projects.js';
export { PostgresWorkspaceRepository } from './repositories/workspaces.js';
export { PostgresFileRepository } from './repositories/files.js';
export {
  PostgresIntegrationRepository,
  PostgresProjectContextRepository,
} from './repositories/context.js';
export { PostgresMemoryRepository } from './repositories/memory.js';
export { PostgresBranchStore, PostgresRevisionStore } from './repositories/versions.js';
export {
  type ListRunRecordsQuery,
  PostgresRunRecordStore,
  type RunRecord,
  type RunRecordBody,
  type SaveRunRecordInput,
} from './repositories/runs.js';
export {
  type ExportJobRecord,
  LocalObjectStore,
  type ObjectStore,
  PostgresExportJobStore,
  type PutObjectInput,
  type SaveExportJobInput,
  type StoredObjectRecord,
  archiveKey,
} from './repositories/exports.js';
export {
  PostgresSyncStore,
  type SyncConnectionRecord,
  type SyncHistoryRecord,
  type SyncPlanRecord,
} from './repositories/sync.js';

import { WorkspaceManager, FileTreeManager, ProjectManager } from '@veltravia/project-core';
import type { ProjectEngine } from '@veltravia/project-core';
import type { MemoryRepository } from '@veltravia/memory-core';
import type { BranchStore, RevisionStore } from '@veltravia/version-core';

import type { Database } from './pool.js';
import { PostgresProjectRepository } from './repositories/projects.js';
import { PostgresWorkspaceRepository } from './repositories/workspaces.js';
import { PostgresFileRepository } from './repositories/files.js';
import {
  PostgresIntegrationRepository,
  PostgresProjectContextRepository,
} from './repositories/context.js';
import { PostgresMemoryRepository } from './repositories/memory.js';
import { PostgresBranchStore, PostgresRevisionStore } from './repositories/versions.js';
import { PostgresRunRecordStore } from './repositories/runs.js';
import { PostgresExportJobStore } from './repositories/exports.js';
import { PostgresSyncStore } from './repositories/sync.js';

/** Every repository the platform needs, bound to one database handle. */
export interface PostgresStores {
  readonly projects: PostgresProjectRepository;
  readonly workspaces: PostgresWorkspaceRepository;
  readonly files: PostgresFileRepository;
  readonly context: PostgresProjectContextRepository;
  readonly integrations: PostgresIntegrationRepository;
  readonly memory: MemoryRepository;
  readonly revisions: RevisionStore;
  readonly branches: BranchStore;
  readonly runs: PostgresRunRecordStore;
  readonly exports: PostgresExportJobStore;
  readonly sync: PostgresSyncStore;
  readonly tasks: PostgresTaskStore;
  readonly workers: PostgresWorkerStore;
  readonly verification: PostgresVerificationStore;
  readonly changeSets: PostgresChangeSetStore;
  readonly changeArtifacts: PostgresChangeArtifacts;
  readonly integrationApprovals: PostgresIntegrationApprovalStore;
  readonly changeIntegrations: PostgresIntegrationRecordStore;
  readonly integrationLocks: PostgresIntegrationLocks;
  readonly recovery: PostgresRecoveryStore;
  readonly executions: PostgresExecutionStore;
  readonly idempotency: PostgresIdempotencyStore;
  readonly leases: PostgresLeaseStore;
  readonly inbox: PostgresEventInbox;
  readonly orchestratorRecoveries: PostgresOrchestrationRecoveryStore;
  readonly usage: PostgresUsageStore;
  readonly wallet: PostgresWalletStore;
}

export function createPostgresStores(database: Database): PostgresStores {
  return {
    projects: new PostgresProjectRepository(database),
    workspaces: new PostgresWorkspaceRepository(database),
    files: new PostgresFileRepository(database),
    context: new PostgresProjectContextRepository(database),
    integrations: new PostgresIntegrationRepository(database),
    memory: new PostgresMemoryRepository(database),
    revisions: new PostgresRevisionStore(database),
    branches: new PostgresBranchStore(database),
    runs: new PostgresRunRecordStore(database),
    exports: new PostgresExportJobStore(database),
    sync: new PostgresSyncStore(database),
    tasks: new PostgresTaskStore(database),
    workers: new PostgresWorkerStore(database),
    verification: new PostgresVerificationStore(database),
    changeSets: new PostgresChangeSetStore(database),
    changeArtifacts: new PostgresChangeArtifacts(database),
    integrationApprovals: new PostgresIntegrationApprovalStore(database),
    changeIntegrations: new PostgresIntegrationRecordStore(database),
    integrationLocks: new PostgresIntegrationLocks(database),
    recovery: new PostgresRecoveryStore(database),
    executions: new PostgresExecutionStore(database),
    idempotency: new PostgresIdempotencyStore(database),
    leases: new PostgresLeaseStore(database),
    inbox: new PostgresEventInbox(database),
    orchestratorRecoveries: new PostgresOrchestrationRecoveryStore(database),
    usage: new PostgresUsageStore(database),
    wallet: new PostgresWalletStore(database),
  };
}

/**
 * Assembles the Project Engine over Postgres repositories. Same managers, same
 * validation and same error types as the in-memory engine, so every route above
 * it is unchanged.
 */
export function createPostgresProjectEngine(
  stores: Pick<PostgresStores, 'projects' | 'workspaces' | 'files' | 'context' | 'integrations'>,
  options: { now?: () => Date } = {},
): ProjectEngine {
  const now = options.now ?? (() => new Date());
  return {
    projects: new ProjectManager({
      projects: stores.projects,
      workspaces: stores.workspaces,
      files: stores.files,
      context: stores.context,
      integrations: stores.integrations,
      now,
    }),
    workspaces: new WorkspaceManager({
      projects: stores.projects,
      workspaces: stores.workspaces,
      now,
    }),
    files: new FileTreeManager({
      projects: stores.projects,
      workspaces: stores.workspaces,
      files: stores.files,
      now,
    }),
  };
}

export { prepareIsolatedTestSchema, testSchemaName } from './test-schema.js';
