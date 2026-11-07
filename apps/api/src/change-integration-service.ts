/**
 * Change integration service (Step 46).
 *
 * Wires `@veltravia/change-integration-core` to what this server already has:
 * the project engine, the Step 31 source layer (snapshots + atomic change
 * sets), the Step 45 verification runner, and Postgres when it is configured.
 *
 * The integration engine itself never touches a file. Every write goes through
 * `source.changeSet`, which is the same atomic path the rest of the product
 * uses, and a snapshot taken before that write is the rollback target.
 */

import {
  InMemoryApprovalStore,
  InMemoryChangeArtifacts,
  InMemoryChangeSetStore,
  InMemoryIntegrationLocks,
  InMemoryIntegrationStore,
  IntegrationManager,
  contentHash,
  type ChangeArtifactPort,
  type ChangeOp,
  type ChangeSetStore,
  type IntegrationApproval,
  type IntegrationLockPort,
  type IntegrationRecord,
  type IntegrationProjectsPort,
  type IntegrationStore,
  type IntegrationTarget,
  type IntegrationTreePort,
  type IntegrationVerificationPort,
  type IntegrationVerificationStatus,
  type ProjectPathState,
} from '@veltravia/change-integration-core';
import type { ProjectEngine } from '@veltravia/project-core';
import type { ChangeOperation, SourceRepositoryManager } from '@veltravia/source-storage-core';

import type { Persistence } from './persistence.js';
import { createSourceProjectsPort } from './source-service.js';
import type { VerificationService } from './verification.js';

/**
 * The source layer stores hashes as `sha256:<hex>`; this package compares bare
 * hex. Normalising inside the port keeps every comparison on one format.
 */
function bareHash(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  return raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw;
}

export interface ChangeIntegrationService {
  readonly manager: IntegrationManager;
  readonly durability: 'memory' | 'postgres';
  /** Read side of the change sets, for evidence reads outside the engine. */
  readonly changeSets: ChangeSetStore;
  readonly integrations: IntegrationStore;
  /** True when a real verification runtime can execute a command. */
  readonly canVerify: boolean;
}

/** Step 31's tree, expressed as the integration engine's port. */
export function createIntegrationTreePort(source: SourceRepositoryManager): IntegrationTreePort {
  return {
    async snapshot(target: IntegrationTarget) {
      const tree = await source.tree(target.ownerRef, {
        projectId: target.projectId,
        workspaceId: target.workspaceId,
      });
      const files: ProjectPathState[] = tree.files
        .filter((file) => file.type === 'file')
        .map((file) => ({
          path: file.path,
          contentHash: bareHash(file.contentHash) ?? '',
          revision: file.revision,
          size: file.size,
        }));
      return { revision: tree.rootRevision, files };
    },

    async read(target: IntegrationTarget, path: string) {
      try {
        const file = await source.readFile(target.ownerRef, {
          projectId: target.projectId,
          workspaceId: target.workspaceId,
          path,
        });
        return { content: file.content };
      } catch {
        return null;
      }
    },

    async apply(input) {
      // Base hashes come from the tree as it is right now, so the record says
      // what this integration actually replaced.
      const before = new Map<string, string | null>();
      const revisions = new Map<string, number>();
      for (const change of input.changes) {
        try {
          const file = await source.readFile(input.ownerRef, {
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            path: change.path,
          });
          before.set(change.path, bareHash(file.contentHash));
          revisions.set(change.path, file.revision);
        } catch {
          before.set(change.path, null);
        }
      }

      const operations: ChangeOperation[] = [];
      for (const change of input.changes) {
        if (change.op === 'delete') {
          operations.push({ op: 'delete', path: change.path });
          continue;
        }
        if (change.op === 'create') {
          operations.push({ op: 'create', path: change.path, content: change.content ?? '' });
          continue;
        }
        const revision = revisions.get(change.path);
        if (revision === undefined) {
          // The file vanished between validation and the write; let the create
          // path fail loudly rather than silently re-creating it.
          throw new Error(`${change.path} is no longer in the project.`);
        }
        operations.push({
          op: 'update',
          path: change.path,
          content: change.content ?? '',
          expectedRevision: revision,
        });
      }

      const result = await source.changeSet(input.ownerRef, {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        operations,
        summary: input.summary,
      });

      // Read every written file back and hash what is actually there: the
      // record must describe the tree, not the intent.
      const applied = await Promise.all(
        input.changes.map(async (change) => {
          const op: ChangeOp = change.op;
          let afterHash: string | null;
          try {
            const file = await source.readFile(input.ownerRef, {
              projectId: input.projectId,
              workspaceId: input.workspaceId,
              path: change.path,
            });
            afterHash = bareHash(contentHash(file.content));
          } catch {
            afterHash = null;
          }
          return {
            path: change.path,
            op,
            baseHash: before.get(change.path) ?? null,
            contentHash: afterHash,
            afterHash,
          };
        }),
      );

      return { revision: result.rootRevision, applied };
    },

    async restore(input) {
      await source.restoreSnapshot(input.ownerRef, {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        snapshotId: input.snapshotId,
      });
      const tree = await source.tree(input.ownerRef, {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      });
      return { revision: tree.rootRevision };
    },

    async createSnapshot(input) {
      const snapshot = await source.createSnapshot(input.ownerRef, {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        kind: 'automatic',
        label: input.label,
        note: input.note,
      });
      return { snapshotId: snapshot.id };
    },
  };
}

/**
 * Post-integration verification over Step 45.
 *
 * `available()` is false when no runtime is configured, and the integration
 * record then says verification was unavailable rather than "passed".
 */
export function createIntegrationVerificationPort(
  verification: VerificationService,
): IntegrationVerificationPort {
  const runtimeAvailable = verification.execution.runtimeId !== null;
  return {
    available: () => runtimeAvailable,
    async run(input) {
      const run = await verification.runner.run({
        ownerRef: input.ownerRef,
        projectId: input.projectId,
        operations: input.operations,
        authorized: null,
        attempt: 0,
      });
      const status: IntegrationVerificationStatus =
        run.status === 'passed'
          ? 'passed'
          : run.status === 'failed'
            ? 'failed'
            : run.status === 'blocked'
              ? 'unavailable'
              : 'incomplete';
      const executed = run.results.some((result) => result.status !== 'blocked');
      return {
        runId: run.id,
        status,
        executed,
        evidenceStatus: run.status,
      };
    },
  };
}

export interface ChangeIntegrationServiceOptions {
  readonly projects: ProjectEngine;
  readonly source: SourceRepositoryManager;
  readonly verification?: VerificationService | undefined;
  readonly persistence?: Persistence | undefined;
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

export function createChangeIntegrationService(
  options: ChangeIntegrationServiceOptions,
): ChangeIntegrationService {
  const stores = options.persistence?.stores;
  const changeSets: ChangeSetStore =
    (stores?.changeSets as ChangeSetStore | undefined) ?? new InMemoryChangeSetStore();
  const artifacts: ChangeArtifactPort =
    (stores?.changeArtifacts as ChangeArtifactPort | undefined) ?? new InMemoryChangeArtifacts();
  const approvals =
    (stores?.integrationApprovals as unknown as
      | {
          insert(approval: IntegrationApproval): Promise<void>;
          get(ownerRef: string, id: string): Promise<IntegrationApproval | null>;
          list(ownerRef: string, projectId?: string): Promise<readonly IntegrationApproval[]>;
        }
      | undefined) ?? new InMemoryApprovalStore();
  const integrations: IntegrationStore =
    (stores?.changeIntegrations as IntegrationStore | undefined) ?? new InMemoryIntegrationStore();
  const locks: IntegrationLockPort =
    (stores?.integrationLocks as IntegrationLockPort | undefined) ?? new InMemoryIntegrationLocks();

  const sourceProjects = createSourceProjectsPort(options.projects);
  const projects: IntegrationProjectsPort = {
    async resolve(input) {
      return sourceProjects.resolveRepository({
        ownerRef: input.ownerRef,
        projectId: input.projectId,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      });
    },
  };
  const verificationPort =
    options.verification === undefined
      ? undefined
      : createIntegrationVerificationPort(options.verification);

  const manager = new IntegrationManager({
    projects,
    tree: createIntegrationTreePort(options.source),
    changeSets,
    approvals,
    integrations,
    artifacts,
    locks,
    ...(verificationPort === undefined ? {} : { verification: verificationPort }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.generateId === undefined ? {} : { generateId: options.generateId }),
  });

  const durable = stores?.changeSets !== undefined;
  return {
    manager,
    changeSets,
    integrations,
    durability: durable ? 'postgres' : 'memory',
    canVerify:
      options.verification !== undefined && options.verification.execution.runtimeId !== null,
  };
}

/** Change sets a worker's staging holds, expressed as a draft. */
export function draftFromStaging(input: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly workerId: string;
  readonly baseRevision: number;
  readonly files: readonly {
    readonly path: string;
    readonly op: 'create' | 'update';
    readonly baseHash: string | null;
    readonly content: string;
  }[];
  readonly authorization: {
    readonly allowedPaths: readonly string[];
    readonly excludedPaths: readonly string[];
    readonly allowedTools: readonly string[];
  };
  readonly title?: string;
  readonly verificationRunIds?: readonly string[];
}): {
  projectId: string;
  workspaceId: string;
  taskId: string;
  workerId: string;
  baseRevision: number;
  title: string;
  files: { path: string; op: 'create' | 'update'; baseHash: string | null; content: string }[];
  authorization: {
    allowedPaths: string[];
    excludedPaths: string[];
    allowedTools: string[];
  };
  verification: { runIds: string[] };
} {
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    taskId: input.taskId ?? '',
    workerId: input.workerId,
    baseRevision: input.baseRevision,
    title: input.title ?? `Changes from ${input.workerId}`,
    files: input.files.map((file) => ({
      path: file.path,
      op: file.op,
      baseHash: file.baseHash,
      content: file.content,
    })),
    authorization: {
      allowedPaths: [...input.authorization.allowedPaths],
      excludedPaths: [...input.authorization.excludedPaths],
      allowedTools: [...input.authorization.allowedTools],
    },
    verification: { runIds: [...(input.verificationRunIds ?? [])] },
  };
}

export type { IntegrationRecord };
