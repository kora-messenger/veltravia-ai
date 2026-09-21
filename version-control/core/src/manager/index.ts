/**
 * VersionControlManager (Step 18).
 *
 * Coordinates immutable revisions, snapshots, checkpoints, diffs, and
 * rollback with the Project Engine through the gateway port. The engine
 * remains the authority for tree state; the manager only observes (capture)
 * and issues validated restore plans through the gateway.
 *
 * Rollback ALWAYS creates a NEW revision. Historical revisions are never
 * mutated and never deleted by rollback. Every restore verifies the
 * resulting tree against the target snapshot's manifest hash before any
 * success is reported - failures fail closed.
 */

import {
  CorruptedSnapshotError,
  ForeignProjectRevisionError,
  ForeignWorkspaceRevisionError,
  InvalidRollbackTargetError,
  OperationAlreadyResolvedError,
  RevisionConflictError,
  RevisionNotFoundError,
  RestoreVerificationError,
  SecretRejectedVersionError,
  VersionError,
} from '../errors/index.js';
import { DEFAULT_RETENTION_POLICY, clampPolicy, type RetentionPolicy } from '../retention/index.js';
import type {
  Checkpoint,
  ProjectRevision,
  RevisionChange,
  RevisionComparison,
  RevisionSnapshot,
  RollbackOperation,
  RollbackOperationState,
  RollbackRequest,
  RollbackResult,
  SnapshotNode,
} from '../types/index.js';
import { isRevisionSource, type RevisionSource } from '../types/index.js';
import type { RevisionStore } from '../store/index.js';
import type { RestoreStep, VersionWorkspaceGateway } from '../gateway/index.js';
import { changeCounts, compareSnapshots } from '../diff/index.js';
import { manifestHashFromGateway, manifestHashOf, hashNodeContent } from '../integrity/index.js';
import { containsSecretShapedContent } from '../secrets/index.js';
import {
  scrubMetadata,
  type VersionAuditEventType,
  type VersionAuditSink,
} from '../audit/index.js';

export const VERSION_INPUT_LIMITS = {
  maxMessageLength: 500,
  maxReasonLength: 500,
  maxCheckpointNameLength: 200,
  maxCheckpointDescriptionLength: 1000,
  maxListLimit: 100,
  defaultListLimit: 25,
} as const;

export interface VersionControlManagerOptions {
  readonly store: RevisionStore;
  readonly gateway: VersionWorkspaceGateway;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly auditSink?: VersionAuditSink;
  readonly policy?: Partial<RetentionPolicy>;
  readonly createdBy?: string;
}

export interface CaptureRevisionInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly source: RevisionSource;
  readonly message?: string | null;
  readonly createdBy?: string;
  /** Rollback lineage: the revision whose state this capture restores. */
  readonly restoredFromRevisionId?: string | null;
}

export interface CreateCheckpointInput {
  readonly projectId: string;
  readonly workspaceId: string;
  /** Existing revision to pin, or omit to capture a fresh one first. */
  readonly revisionId?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly createdBy?: string;
}

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export class VersionControlManager {
  private readonly store: RevisionStore;
  private readonly gateway: VersionWorkspaceGateway;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly audit: VersionAuditSink;
  private readonly policy: RetentionPolicy;
  private readonly defaultCreatedBy: string;
  private readonly operations: Map<string, RollbackOperation> = new Map();

  constructor(options: VersionControlManagerOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.now = options.now ?? (() => new Date());
    this.generateId =
      options.generateId ??
      (() =>
        globalThis.crypto?.randomUUID?.() ??
        `rev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    this.audit =
      options.auditSink ??
      (() => {
        // No sink - audit is a deployment concern, never a correctness one.
      });
    this.policy = options.policy ? clampPolicy(options.policy) : DEFAULT_RETENTION_POLICY;
    this.defaultCreatedBy = options.createdBy ?? 'api';
  }

  // ------------------------------------------------------------------
  // Revisions
  // ------------------------------------------------------------------

  /**
   * Captures the CURRENT workspace tree as a new immutable revision.
   * Fails closed on secret-shaped file content, cross-boundary access, or
   * unknown ids. History is capped by the retention policy.
   */
  async captureRevision(input: CaptureRevisionInput): Promise<ProjectRevision> {
    if (!isRevisionSource(input.source)) {
      throw new VersionError('VERSION_INVALID_REQUEST', 'Unknown revision source.');
    }
    const message = isNonEmpty(input.message)
      ? input.message.trim().slice(0, VERSION_INPUT_LIMITS.maxMessageLength)
      : null;
    if (message !== null && containsSecretShapedContent(message)) {
      throw new SecretRejectedVersionError(['<message>']);
    }
    const workspace = await this.gateway.getWorkspace(input.workspaceId);
    if (workspace.projectId !== input.projectId) {
      throw new ForeignProjectRevisionError();
    }
    if (workspace.status === 'deleted') {
      throw new VersionError('VERSION_INVALID_REQUEST', 'The workspace is deleted.');
    }

    const gatewayNodes = await this.gateway.listNodes(input.workspaceId);
    const secretPaths: string[] = [];
    for (const node of gatewayNodes) {
      if (
        node.type === 'file' &&
        node.content !== null &&
        containsSecretShapedContent(node.content)
      ) {
        secretPaths.push(node.path);
      }
    }
    if (secretPaths.length > 0) {
      this.emit('integrity_failure', input, {
        reason: 'secret_shaped_content',
        paths: secretPaths.length,
      });
      throw new SecretRejectedVersionError(secretPaths);
    }

    const { hash, totalBytes, snapshotNodes } = manifestHashFromGateway(gatewayNodes);
    const previous = await this.store.getLatestRevision(input.projectId, input.workspaceId);
    let change: RevisionChange = {
      added: filesOf(snapshotNodes),
      modified: 0,
      deleted: 0,
      total: filesOf(snapshotNodes),
    };
    if (previous !== null) {
      const previousSnapshot = await this.store.getSnapshot(previous.id);
      const counts = changeCounts(previousSnapshot?.nodes ?? [], snapshotNodes);
      change = {
        added: counts.added,
        modified: counts.modified,
        deleted: counts.deleted,
        total: counts.added + counts.modified + counts.deleted,
      };
    }

    const revisionId = this.generateId();
    const revision: ProjectRevision = {
      id: revisionId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      revisionNumber: workspace.revision,
      parentRevisionId: previous?.id ?? null,
      createdAt: this.now().toISOString(),
      createdBy: input.createdBy ?? this.defaultCreatedBy,
      source: input.source,
      status: 'active',
      change,
      fileCount: filesOf(snapshotNodes),
      totalBytes,
      manifestHash: hash,
      message,
      restoredFromRevisionId: input.restoredFromRevisionId ?? null,
    };
    const snapshot: RevisionSnapshot = {
      revisionId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      manifestHash: hash,
      nodes: snapshotNodes,
      capturedAt: revision.createdAt,
      totalBytes,
    };
    await this.store.createRevision(revision, snapshot);
    this.emit('revision_created', input, {
      revisionId,
      revisionNumber: revision.revisionNumber,
      source: revision.source,
      files: revision.fileCount,
      bytes: revision.totalBytes,
      changeTotal: change.total,
    });
    await this.enforceRevisionRetention(input.projectId, input.workspaceId);
    return revision;
  }

  async getRevision(
    projectId: string,
    workspaceId: string,
    revisionId: string,
  ): Promise<ProjectRevision> {
    const revision = await this.store.getRevision(revisionId);
    if (revision === null) throw new RevisionNotFoundError(revisionId);
    if (revision.projectId !== projectId) throw new ForeignProjectRevisionError();
    if (revision.workspaceId !== workspaceId) throw new ForeignWorkspaceRevisionError();
    return revision;
  }

  async listRevisions(
    projectId: string,
    workspaceId: string,
    rawLimit?: number,
    rawSkip?: number,
  ): Promise<{ revisions: ProjectRevision[]; total: number; hasMore: boolean }> {
    const limit = Math.min(
      Math.max(rawLimit ?? VERSION_INPUT_LIMITS.defaultListLimit, 1),
      VERSION_INPUT_LIMITS.maxListLimit,
    );
    const skip = Math.max(rawSkip ?? 0, 0);
    const page = await this.store.listRevisions({ projectId, workspaceId, limit, skip });
    this.emit('revision_listed', { projectId, workspaceId }, { limit, skip, total: page.total });
    return page;
  }

  async getLatestRevision(projectId: string, workspaceId: string): Promise<ProjectRevision | null> {
    return this.store.getLatestRevision(projectId, workspaceId);
  }

  /** Diff of one revision against its parent (first revision: everything added). */
  async getRevisionDiff(
    projectId: string,
    workspaceId: string,
    revisionId: string,
  ): Promise<RevisionComparison> {
    const revision = await this.getRevision(projectId, workspaceId, revisionId);
    const snapshot = await this.requireSnapshot(revision);
    const parent =
      revision.parentRevisionId !== null
        ? await this.getRevision(projectId, workspaceId, revision.parentRevisionId)
        : null;
    const parentSnapshot = parent !== null ? await this.requireSnapshot(parent) : null;
    const comparison = compareSnapshots(parentSnapshot?.nodes ?? [], snapshot.nodes);
    this.emit(
      'revision_compared',
      { projectId, workspaceId },
      {
        from: parent?.id ?? 'root',
        to: revisionId,
        changedFiles:
          comparison.added + comparison.modified + comparison.deleted + comparison.renamed,
      },
    );
    return { ...comparison, fromRevisionId: parent?.id ?? '', toRevisionId: revision.id };
  }

  /** Structured comparison of two revisions (from = older, to = newer by id, not number). */
  async compareRevisions(
    projectId: string,
    workspaceId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<RevisionComparison> {
    const from = await this.getRevision(projectId, workspaceId, fromRevisionId);
    const to = await this.getRevision(projectId, workspaceId, toRevisionId);
    const fromSnapshot = await this.requireSnapshot(from);
    const toSnapshot = await this.requireSnapshot(to);
    const comparison = compareSnapshots(fromSnapshot.nodes, toSnapshot.nodes);
    this.emit(
      'revision_compared',
      { projectId, workspaceId },
      {
        from: fromRevisionId,
        to: toRevisionId,
        changedFiles:
          comparison.added + comparison.modified + comparison.deleted + comparison.renamed,
      },
    );
    return { ...comparison, fromRevisionId: from.id, toRevisionId: to.id };
  }

  // ------------------------------------------------------------------
  // Checkpoints
  // ------------------------------------------------------------------

  async createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
    const name = isNonEmpty(input.name)
      ? input.name.trim().slice(0, VERSION_INPUT_LIMITS.maxCheckpointNameLength)
      : '';
    if (name === '') {
      throw new VersionError('VERSION_INVALID_REQUEST', 'Checkpoint name is required.');
    }
    if (containsSecretShapedContent(name)) {
      throw new SecretRejectedVersionError(['<name>']);
    }
    const description = isNonEmpty(input.description)
      ? input.description.trim().slice(0, VERSION_INPUT_LIMITS.maxCheckpointDescriptionLength)
      : null;
    if (description !== null && containsSecretShapedContent(description)) {
      throw new SecretRejectedVersionError(['<description>']);
    }
    let revision: ProjectRevision;
    if (input.revisionId !== undefined) {
      revision = await this.getRevision(input.projectId, input.workspaceId, input.revisionId);
    } else {
      revision = await this.captureRevision({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        source: 'manual',
        message: `Checkpoint: ${name}`,
        createdBy: input.createdBy,
      });
    }
    const checkpoint: Checkpoint = {
      id: this.generateId(),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      revisionId: revision.id,
      name,
      description,
      createdAt: this.now().toISOString(),
      createdBy: input.createdBy ?? this.defaultCreatedBy,
    };
    await this.store.createCheckpoint(checkpoint);
    this.emit('checkpoint_created', input, {
      checkpointId: checkpoint.id,
      revisionId: revision.id,
      name,
    });
    await this.enforceCheckpointRetention(input.projectId, input.workspaceId);
    return checkpoint;
  }

  async getCheckpoint(
    projectId: string,
    workspaceId: string,
    checkpointId: string,
  ): Promise<Checkpoint> {
    const checkpoint = await this.store.getCheckpoint(checkpointId);
    if (checkpoint === null) {
      throw new VersionError(
        'VERSION_CHECKPOINT_NOT_FOUND',
        `Checkpoint "${checkpointId}" was not found.`,
        {
          checkpointId,
        },
      );
    }
    if (checkpoint.projectId !== projectId) throw new ForeignProjectRevisionError();
    if (checkpoint.workspaceId !== workspaceId) throw new ForeignWorkspaceRevisionError();
    return checkpoint;
  }

  async listCheckpoints(projectId: string, workspaceId: string): Promise<Checkpoint[]> {
    return this.store.listCheckpoints(projectId, workspaceId);
  }

  async deleteCheckpoint(
    projectId: string,
    workspaceId: string,
    checkpointId: string,
  ): Promise<void> {
    const checkpoint = await this.getCheckpoint(projectId, workspaceId, checkpointId);
    await this.store.deleteCheckpoint(checkpoint.id);
    this.emit('checkpoint_deleted', { projectId, workspaceId }, { checkpointId: checkpoint.id });
  }

  // ------------------------------------------------------------------
  // Rollback operations
  // ------------------------------------------------------------------

  /**
   * Pre-validates a rollback request WITHOUT mutating anything. The API
   * layer runs this before asking the Tool System for a human confirmation
   * bound to the exact request input.
   */
  async validateRollbackTarget(request: RollbackRequest): Promise<{
    target: ProjectRevision;
    currentRevision: number;
    filesChanged: number;
  }> {
    const workspace = await this.gateway.getWorkspace(request.workspaceId);
    if (workspace.projectId !== request.projectId) throw new ForeignProjectRevisionError();
    if (request.expectedCurrentRevision !== workspace.revision) {
      this.emit('revision_conflict', request, {
        expected: request.expectedCurrentRevision,
        actual: workspace.revision,
      });
      throw new RevisionConflictError(request.expectedCurrentRevision, workspace.revision);
    }
    const target = await this.getRevision(
      request.projectId,
      request.workspaceId,
      request.targetRevisionId,
    );
    if (
      target.id === (await this.store.getLatestRevision(request.projectId, request.workspaceId))?.id
    ) {
      // Rolling back to the current state is a no-op with side effects - refuse it.
      throw new InvalidRollbackTargetError('the target is already the latest revision.');
    }
    const snapshot = await this.requireIntactSnapshot(target);
    const current = await this.gateway.listNodes(request.workspaceId);
    const { snapshotNodes } = manifestHashFromGateway(current);
    const counts = changeCounts(snapshot.nodes, snapshotNodes);
    const filesChanged = counts.added + counts.modified + counts.deleted;
    return { target, currentRevision: workspace.revision, filesChanged };
  }

  /** Registers a pending rollback operation (single-use, confirmation-bound). */
  async registerOperation(
    request: RollbackRequest,
    confirmationId: string | null,
  ): Promise<RollbackOperation> {
    const reason = isNonEmpty(request.reason)
      ? request.reason.trim().slice(0, VERSION_INPUT_LIMITS.maxReasonLength)
      : null;
    if (reason !== null && containsSecretShapedContent(reason)) {
      throw new SecretRejectedVersionError(['<reason>']);
    }
    const operation: RollbackOperation = {
      id: this.generateId(),
      request: { ...request, reason },
      state: 'pending_confirmation',
      createdAt: this.now().toISOString(),
      confirmationId,
      decidedAt: null,
      completedAt: null,
      failureCode: null,
      failureMessage: null,
      result: null,
    };
    this.operations.set(operation.id, operation);
    this.emit('rollback_requested', request, { operationId: operation.id });
    return operation;
  }

  async getOperation(operationId: string): Promise<RollbackOperation> {
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      throw new VersionError(
        'VERSION_OPERATION_NOT_FOUND',
        `Rollback operation "${operationId}" was not found.`,
        {
          operationId,
        },
      );
    }
    return operation;
  }

  /** Single-use transition guard. */
  private assertTransition(operation: RollbackOperation, from: RollbackOperationState): void {
    if (operation.state !== from) {
      throw new OperationAlreadyResolvedError(operation.id);
    }
  }

  /** Marks the operation rejected (human said no, or confirmation expired). */
  async rejectOperation(operationId: string): Promise<RollbackOperation> {
    const operation = await this.getOperation(operationId);
    this.assertTransition(operation, 'pending_confirmation');
    const next: RollbackOperation = {
      ...operation,
      state: 'rejected',
      decidedAt: this.now().toISOString(),
    };
    this.operations.set(operationId, next);
    this.emit('rollback_rejected', operation.request, { operationId });
    return next;
  }

  /** Marks the operation approved (decision recorded; execution follows). */
  async approveOperation(operationId: string): Promise<RollbackOperation> {
    const operation = await this.getOperation(operationId);
    this.assertTransition(operation, 'pending_confirmation');
    const next: RollbackOperation = {
      ...operation,
      state: 'approved',
      decidedAt: this.now().toISOString(),
    };
    this.operations.set(operationId, next);
    this.emit('rollback_confirmed', operation.request, { operationId });
    return next;
  }

  /**
   * Executes an APPROVED rollback. Re-validates everything from scratch
   * (concurrency, ownership, integrity), restores through the gateway,
   * verifies the resulting tree, and captures the NEW revision.
   * Only ever called by the Tool System's `project.rollback` implementation.
   */
  async executeRollback(request: RollbackRequest): Promise<RollbackResult> {
    const workspace = await this.gateway.getWorkspace(request.workspaceId);
    if (workspace.projectId !== request.projectId) throw new ForeignProjectRevisionError();
    if (request.expectedCurrentRevision !== workspace.revision) {
      this.emit('revision_conflict', request, {
        expected: request.expectedCurrentRevision,
        actual: workspace.revision,
      });
      throw new RevisionConflictError(request.expectedCurrentRevision, workspace.revision);
    }
    const target = await this.getRevision(
      request.projectId,
      request.workspaceId,
      request.targetRevisionId,
    );
    const snapshot = await this.requireIntactSnapshot(target);

    // Build the restore plan against the live tree.
    const current = await this.gateway.listNodes(request.workspaceId);
    const currentByPath = new Map(current.map((node) => [node.path, node]));
    const targetByPath = new Map(snapshot.nodes.map((node) => [node.path, node]));
    const steps: RestoreStep[] = [];
    // Directories first (shallow-to-deep), then files.
    const directoriesToCreate = snapshot.nodes
      .filter((node) => node.type === 'directory' && !currentByPath.has(node.path))
      .sort((a, b) => depth(a.path) - depth(b.path));
    for (const node of directoriesToCreate) {
      steps.push({ kind: 'create_directory', path: node.path });
    }
    for (const node of snapshot.nodes) {
      if (node.type !== 'file') continue;
      const existing = currentByPath.get(node.path);
      if (existing === undefined) {
        steps.push({ kind: 'create_file', path: node.path, content: node.content });
      } else if (existing.type === 'file' && existing.content !== node.content) {
        steps.push({ kind: 'update_file', path: node.path, content: node.content });
      }
    }
    // Delete current files not in the target, then extra directories (deep-first).
    const currentFiles = current
      .filter((node) => node.type === 'file' && !targetByPath.has(node.path))
      .sort((a, b) => depth(a.path) - depth(b.path));
    for (const node of currentFiles) {
      steps.push({ kind: 'delete_file', path: node.path });
    }
    const currentDirs = current
      .filter((node) => node.type === 'directory' && !targetByPath.has(node.path))
      .sort((a, b) => depth(b.path) - depth(a.path));
    for (const node of currentDirs) {
      steps.push({ kind: 'delete_directory', path: node.path });
    }

    this.emit('rollback_started', request, { operationTarget: target.id, steps: steps.length });
    await this.gateway.applyRestore(request.workspaceId, steps);

    // Verify the resulting tree before any success is reported.
    const restored = await this.gateway.listNodes(request.workspaceId);
    const { hash, snapshotNodes } = manifestHashFromGateway(restored);
    if (hash !== snapshot.manifestHash || !manifestsEqual(snapshotNodes, snapshot.nodes)) {
      this.emit('integrity_failure', request, {
        reason: 'restore_verification_failed',
        revisionId: target.id,
      });
      throw new RestoreVerificationError(target.id);
    }

    // A rollback ALWAYS creates a NEW revision; history stays intact.
    const revision = await this.captureRevision({
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      source: 'rollback',
      message: `Rollback to revision ${target.revisionNumber} (restored state of ${target.id})`,
      createdBy: 'rollback',
      restoredFromRevisionId: target.id,
    });

    const result: RollbackResult = {
      newRevisionId: revision.id,
      newRevisionNumber: revision.revisionNumber,
      restoredFromRevisionId: target.id,
      restoredFromRevisionNumber: target.revisionNumber,
      filesChanged: steps.length,
    };
    this.emit('rollback_completed', request, {
      newRevisionId: result.newRevisionId,
      restoredFromRevisionId: target.id,
      steps: steps.length,
    });
    return result;
  }

  async completeOperation(operationId: string, result: RollbackResult): Promise<RollbackOperation> {
    const operation = await this.getOperation(operationId);
    if (operation.state !== 'approved' && operation.state !== 'pending_confirmation') {
      throw new OperationAlreadyResolvedError(operationId);
    }
    const next: RollbackOperation = {
      ...operation,
      state: 'completed',
      completedAt: this.now().toISOString(),
      result,
    };
    this.operations.set(operationId, next);
    return next;
  }

  async failOperation(
    operationId: string,
    code: string,
    message: string,
  ): Promise<RollbackOperation> {
    const operation = await this.getOperation(operationId);
    if (
      operation.state === 'completed' ||
      operation.state === 'failed' ||
      operation.state === 'rejected'
    ) {
      throw new OperationAlreadyResolvedError(operationId);
    }
    const next: RollbackOperation = {
      ...operation,
      state: 'failed',
      completedAt: this.now().toISOString(),
      failureCode: code,
      failureMessage: message.slice(0, 500),
    };
    this.operations.set(operationId, next);
    this.emit('rollback_failed', operation.request, { operationId, code });
    return next;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async requireSnapshot(revision: ProjectRevision): Promise<RevisionSnapshot> {
    const snapshot = await this.store.getSnapshot(revision.id);
    if (snapshot === null) {
      throw new VersionError(
        'VERSION_SNAPSHOT_NOT_FOUND',
        `The snapshot for revision "${revision.id}" is not available.`,
        { revisionId: revision.id },
      );
    }
    return snapshot;
  }

  /** Integrity check: manifest hash + per-file content hashes. Fails closed. */
  private async requireIntactSnapshot(revision: ProjectRevision): Promise<RevisionSnapshot> {
    const snapshot = await this.requireSnapshot(revision);
    if (manifestHashOf(snapshot.nodes) !== snapshot.manifestHash) {
      this.emit(
        'integrity_failure',
        { projectId: revision.projectId, workspaceId: revision.workspaceId },
        {
          reason: 'manifest_hash_mismatch',
          revisionId: revision.id,
        },
      );
      throw new CorruptedSnapshotError(revision.id);
    }
    for (const node of snapshot.nodes) {
      if (node.type === 'file' && hashNodeContent(node) !== node.contentHash) {
        this.emit(
          'integrity_failure',
          { projectId: revision.projectId, workspaceId: revision.workspaceId },
          {
            reason: 'content_hash_mismatch',
            revisionId: revision.id,
          },
        );
        throw new CorruptedSnapshotError(revision.id);
      }
    }
    return snapshot;
  }

  /** Revision ids that retention must NEVER evict. */
  private async protectedRevisionIds(projectId: string, workspaceId: string): Promise<Set<string>> {
    const protectedIds = new Set<string>();
    for (const checkpoint of await this.store.listCheckpoints(projectId, workspaceId)) {
      protectedIds.add(checkpoint.revisionId);
    }
    const latest = await this.store.getLatestRevision(projectId, workspaceId);
    if (latest !== null) protectedIds.add(latest.id);
    for (const operation of this.operations.values()) {
      if (
        operation.request.projectId === projectId &&
        operation.request.workspaceId === workspaceId
      ) {
        if (operation.state === 'pending_confirmation' || operation.state === 'approved') {
          protectedIds.add(operation.request.targetRevisionId);
        }
      }
    }
    return protectedIds;
  }

  private async enforceRevisionRetention(projectId: string, workspaceId: string): Promise<void> {
    const candidates = await this.store.listRetentionCandidates(projectId, workspaceId);
    if (candidates.length <= this.policy.maxRevisionsPerWorkspace) return;
    const protectedIds = await this.protectedRevisionIds(projectId, workspaceId);
    let excess = candidates.length - this.policy.maxRevisionsPerWorkspace;
    const bytes = await this.store.estimateSnapshotBytes(projectId, workspaceId);
    let overBytes = bytes > this.policy.maxSnapshotBytesPerWorkspace;
    for (const candidate of candidates) {
      if (excess <= 0 && !overBytes) break;
      if (protectedIds.has(candidate.id)) continue;
      await this.store.deleteRevision(candidate.id);
      this.emit(
        'revision_retention_deleted',
        { projectId, workspaceId },
        {
          revisionId: candidate.id,
        },
      );
      excess -= 1;
      overBytes =
        overBytes && bytes - candidate.totalBytes > this.policy.maxSnapshotBytesPerWorkspace;
    }
  }

  /**
   * Checkpoint markers are advisory recovery points: evicting the OLDEST
   * markers beyond the cap never deletes revisions or snapshots, so rollback
   * guarantees survive. Markers pinned by still-open rollback operations are
   * never evicted.
   */
  private async enforceCheckpointRetention(projectId: string, workspaceId: string): Promise<void> {
    const checkpoints = await this.store.listCheckpoints(projectId, workspaceId);
    if (checkpoints.length <= this.policy.maxCheckpointsPerWorkspace) return;
    const pinnedIds = new Set<string>();
    for (const operation of this.operations.values()) {
      if (
        operation.request.projectId === projectId &&
        operation.request.workspaceId === workspaceId &&
        (operation.state === 'pending_confirmation' || operation.state === 'approved')
      ) {
        pinnedIds.add(operation.request.targetRevisionId);
      }
    }
    const removable = checkpoints
      .filter((checkpoint) => !pinnedIds.has(checkpoint.revisionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let excess = checkpoints.length - this.policy.maxCheckpointsPerWorkspace;
    for (const checkpoint of removable) {
      if (excess <= 0) break;
      await this.store.deleteCheckpoint(checkpoint.id);
      this.emit('checkpoint_deleted', { projectId, workspaceId }, { checkpointId: checkpoint.id });
      excess -= 1;
    }
  }

  private emit(
    type: VersionAuditEventType,
    scope: { projectId: string; workspaceId: string },
    metadata: Record<string, string | number | boolean | null>,
  ): void {
    this.audit({
      type,
      at: this.now().toISOString(),
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      metadata: scrubMetadata(metadata),
    });
  }
}

function filesOf(nodes: readonly SnapshotNode[]): number {
  return nodes.filter((node) => node.type === 'file').length;
}

function depth(path: string): number {
  return path.split('/').length;
}

function manifestsEqual(a: readonly SnapshotNode[], b: readonly SnapshotNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left: SnapshotNode | undefined = a[index];
    const right: SnapshotNode | undefined = b[index];
    if (left === undefined || right === undefined) return false;
    if (left.path !== right.path) return false;
    if (left.type !== right.type) return false;
    if (left.contentHash !== right.contentHash) return false;
    if (left.size !== right.size) return false;
  }
  return true;
}
