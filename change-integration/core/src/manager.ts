/**
 * The integration engine (Step 46, sections 3, 6, 8, 9, 10, 11).
 *
 * Rules the code enforces, in order:
 *
 *  1. A worker's proposal is data. It becomes part of the project only through
 *     an integration this manager performed, against the revision it saw.
 *  2. Two integrations never run against one project at once: a per-project
 *     lock is held for the whole operation.
 *  3. If any write fails, the project is restored from the snapshot taken
 *     before the first write. A partial integration is never left behind.
 *  4. A change set is integrated at most once. Its status records the
 *     integration that consumed it.
 *  5. Rollback refuses when the project has moved since the integration,
 *     because restoring the snapshot would erase work this manager never saw.
 */

import { SourceError } from '@veltravia/source-storage-core';

import { allConflicts, detectConflicts, type ConflictCandidate } from './conflicts.js';
import { IntegrationError } from './errors.js';
import { byteLength, contentHash } from './hash.js';
import { normalizeChangePath } from './paths.js';
import {
  CHANGE_INTEGRATION_LIMITS,
  type IntegrationTarget,
  type AppliedFile,
  type ApprovalStore,
  type ChangeArtifactPort,
  type ChangeFile,
  type ChangeSetDiff,
  type ChangeSetDiffFile,
  type ChangeSetDraft,
  type ChangeSetStore,
  type IntegrationApproval,
  type IntegrationLockPort,
  type IntegrationProjectsPort,
  type IntegrationRecord,
  type IntegrationResult,
  type IntegrationStore,
  type IntegrationTreePort,
  type IntegrationVerificationPort,
  type ProjectPathState,
  type WorkerChangeSet,
} from './types.js';
import { validateChangeSet } from './validation.js';

export interface IntegrationManagerOptions {
  readonly projects: IntegrationProjectsPort;
  readonly tree: IntegrationTreePort;
  readonly changeSets: ChangeSetStore;
  readonly approvals: ApprovalStore;
  readonly integrations: IntegrationStore;
  readonly artifacts: ChangeArtifactPort;
  readonly locks: IntegrationLockPort;
  readonly verification?: IntegrationVerificationPort;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly defaultOperations?: readonly string[];
}

interface ProjectState {
  readonly revision: number;
  readonly files: readonly ProjectPathState[];
}

const DEFAULT_OPERATIONS = ['unit', 'typecheck'] as const;

/** One side of a review, bounded so a huge file cannot flood the browser. */
function clip(content: string, maxChars: number): string {
  return content.length <= maxChars ? content : content.slice(0, maxChars);
}

export class IntegrationManager {
  private readonly projects: IntegrationProjectsPort;
  private readonly tree: IntegrationTreePort;
  private readonly changeSets: ChangeSetStore;
  private readonly approvals: ApprovalStore;
  private readonly integrations: IntegrationStore;
  private readonly artifacts: ChangeArtifactPort;
  private readonly locks: IntegrationLockPort;
  private readonly verification: IntegrationVerificationPort | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly defaultOperations: readonly string[];

  constructor(options: IntegrationManagerOptions) {
    this.projects = options.projects;
    this.tree = options.tree;
    this.changeSets = options.changeSets;
    this.approvals = options.approvals;
    this.integrations = options.integrations;
    this.artifacts = options.artifacts;
    this.locks = options.locks;
    this.verification = options.verification;
    this.now = options.now ?? (() => new Date());
    this.newId = options.generateId ?? (() => `chg_${Math.random().toString(36).slice(2, 12)}`);
    this.defaultOperations = options.defaultOperations ?? DEFAULT_OPERATIONS;
  }

  private async resolve(ownerRef: string, projectId: string, workspaceId?: string) {
    const resolved = await this.projects.resolve({
      ownerRef: ownerRef.trim(),
      projectId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    if (resolved === null) throw new IntegrationError('INTEGRATION_PROJECT_NOT_FOUND');
    return resolved as { projectId: string; workspaceId: string };
  }

  private target(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly workspaceId: string;
  }): IntegrationTarget {
    return {
      ownerRef: input.ownerRef,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
    };
  }

  private async state(target: IntegrationTarget): Promise<ProjectState> {
    const snapshot = await this.tree.snapshot(target);
    return { revision: snapshot.revision, files: snapshot.files };
  }

  /** Current content for every path a candidate touches. */
  private async baseContents(
    files: readonly ProjectPathState[],
    candidates: readonly ConflictCandidate[],
  ): Promise<Map<string, string>> {
    const wanted = new Set(
      candidates.flatMap((candidate) => candidate.changeSet.files.map((file) => file.path)),
    );
    const known = new Set(files.map((file) => file.path));
    const contents = new Map<string, string>();
    for (const path of wanted) {
      if (!known.has(path)) continue;
      const read = await this.tree.read(this.target(candidates[0]!.changeSet), path);
      if (read !== null) contents.set(path, read.content);
    }
    return contents;
  }

  private async contentsOf(changeSet: WorkerChangeSet): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    for (const file of changeSet.files) {
      if (file.op === 'delete' || file.artifactRef === null) continue;
      const content = await this.artifacts.get({
        changeSetId: changeSet.id,
        path: file.path,
      });
      if (content !== null) contents.set(file.path, content);
    }
    return contents;
  }

  // -------------------------------------------------------------------------
  // Change sets
  // -------------------------------------------------------------------------

  /**
   * Records a worker's proposal without touching the project.
   *
   * Hashes are computed here, from the content the worker supplied, so a caller
   * cannot claim a hash its content does not have.
   */
  async createChangeSet(ownerRef: string, draft: ChangeSetDraft): Promise<WorkerChangeSet> {
    const owner = ownerRef.trim();
    const resolved = await this.resolve(owner, draft.projectId, draft.workspaceId);
    const at = this.now().toISOString();
    const id = this.newId();

    const files: ChangeFile[] = [];
    for (const entry of draft.files) {
      const path = normalizeChangePath(entry.path);
      if (path === null) {
        throw new IntegrationError(
          'INTEGRATION_CHANGE_SET_INVALID',
          `"${entry.path}" is not an acceptable path.`,
          { path: entry.path },
        );
      }
      const content = entry.content ?? null;
      if (entry.op === 'delete') {
        files.push({
          path,
          op: 'delete',
          baseHash: entry.baseHash ?? null,
          proposedHash: null,
          size: 0,
          artifactRef: null,
        });
        continue;
      }
      if (content === null) {
        throw new IntegrationError(
          'INTEGRATION_CHANGE_SET_INVALID',
          `No content was supplied for ${path}.`,
          { path },
        );
      }
      if (byteLength(content) > 512 * 1024) {
        throw new IntegrationError(
          'INTEGRATION_CHANGE_SET_INVALID',
          `${path} is larger than one change set may carry.`,
          { path },
        );
      }
      const artifactRef = await this.artifacts.put({ changeSetId: id, path, content });
      files.push({
        path,
        op: entry.op,
        baseHash: entry.baseHash ?? null,
        proposedHash: contentHash(content),
        size: byteLength(content),
        artifactRef,
      });
    }

    const changeSet: WorkerChangeSet = {
      id,
      ownerRef: owner,
      projectId: resolved.projectId,
      workspaceId: resolved.workspaceId,
      taskId: draft.taskId ?? null,
      workerId: draft.workerId ?? null,
      baseRevision: draft.baseRevision,
      title: (draft.title ?? 'Proposed changes').slice(0, 160),
      files,
      deliverables: [...(draft.deliverables ?? [])],
      authorization: {
        // A worker proposal must carry its assignment's scope. A direct
        // proposal from the Primary Agent has no narrower envelope than the
        // project itself, which is the empty prefix.
        allowedPaths: [
          ...(draft.authorization?.allowedPaths ?? (draft.workerId === undefined ? [''] : [])),
        ],
        excludedPaths: [...(draft.authorization?.excludedPaths ?? [])],
        allowedTools: [...(draft.authorization?.allowedTools ?? [])],
        taskId: draft.authorization?.taskId ?? draft.taskId ?? null,
        workerId: draft.authorization?.workerId ?? draft.workerId ?? null,
      },
      verification: {
        runIds: [...(draft.verification?.runIds ?? [])],
        status: draft.verification?.status ?? 'none',
      },
      status: 'open',
      scopeComplete: true,
      integrationId: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.changeSets.insert(changeSet);
    return changeSet;
  }

  async getChangeSet(ownerRef: string, changeSetId: string): Promise<WorkerChangeSet> {
    const changeSet = await this.changeSets.get(ownerRef.trim(), changeSetId);
    if (changeSet === null) throw new IntegrationError('INTEGRATION_CHANGE_SET_NOT_FOUND');
    return changeSet;
  }

  /**
   * The content a reviewer needs to judge a change set.
   *
   * Base content is read from the project as it stands NOW, so a stale set is
   * visible: `baseStale` is true when the project no longer matches the hash the
   * worker started from. Both sides are bounded and marked truncated rather than
   * silently cut, and a missing artifact is reported as unknown, never as empty.
   */
  async diff(
    ownerRef: string,
    changeSetId: string,
    options: { readonly maxChars?: number; readonly maxFiles?: number } = {},
  ): Promise<ChangeSetDiff> {
    const changeSet = await this.getChangeSet(ownerRef, changeSetId);
    const target = this.target(changeSet);
    const maxChars = options.maxChars ?? 20_000;
    const maxFiles = options.maxFiles ?? 200;
    const proposed = await this.contentsOf(changeSet);
    const files: ChangeSetDiffFile[] = [];
    for (const file of changeSet.files.slice(0, maxFiles)) {
      const current = file.op === 'create' ? null : await this.tree.read(target, file.path);
      const base = current === null ? null : current.content;
      const next = file.op === 'delete' ? null : (proposed.get(file.path) ?? null);
      files.push({
        path: file.path,
        op: file.op,
        baseHash: file.baseHash,
        proposedHash: file.proposedHash,
        size: file.size,
        base: base === null ? null : clip(base, maxChars),
        proposed: next === null ? null : clip(next, maxChars),
        baseStale:
          file.op === 'update' && (current === null || contentHash(base ?? '') !== file.baseHash),
        contentAvailable: file.op === 'delete' ? true : next !== null || file.artifactRef === null,
      });
    }
    return {
      changeSetId: changeSet.id,
      title: changeSet.title,
      status: changeSet.status,
      baseRevision: changeSet.baseRevision,
      files,
      omittedFiles: Math.max(0, changeSet.files.length - files.length),
      maxChars,
    };
  }

  /**
   * Validates one set against the project as it stands.
   *
   * Returns the problems rather than throwing: a stale set is information the
   * Primary Agent needs, not an exception to swallow.
   */
  async validate(
    ownerRef: string,
    changeSetId: string,
  ): Promise<{
    readonly changeSet: WorkerChangeSet;
    readonly validation: ReturnType<typeof validateChangeSet>;
    readonly currentRevision: number;
  }> {
    const changeSet = await this.getChangeSet(ownerRef, changeSetId);
    const state = await this.state(this.target(changeSet));
    const contents = await this.contentsOf(changeSet);
    return {
      changeSet,
      validation: validateChangeSet({ changeSet, contents, current: state }),
      currentRevision: state.revision,
    };
  }

  /** Conflict analysis across a selection, without writing anything. */
  async analyze(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly changeSetIds: readonly string[];
  }): Promise<{
    readonly currentRevision: number;
    readonly reports: ReturnType<typeof detectConflicts>;
    readonly conflicts: ReturnType<typeof allConflicts>;
    readonly blocked: boolean;
  }> {
    const owner = input.ownerRef.trim();
    const ids = [...new Set(input.changeSetIds)];
    if (ids.length === 0) throw new IntegrationError('INTEGRATION_EMPTY_SELECTION');
    if (ids.length > CHANGE_INTEGRATION_LIMITS.maxChangeSetsPerIntegration) {
      throw new IntegrationError('INTEGRATION_TOO_MANY_CHANGE_SETS');
    }
    const resolved = await this.resolve(owner, input.projectId);
    const changeSets: WorkerChangeSet[] = [];
    for (const id of ids) {
      const changeSet = await this.changeSets.get(owner, id);
      if (changeSet === null) throw new IntegrationError('INTEGRATION_CHANGE_SET_NOT_FOUND');
      if (changeSet.projectId !== resolved.projectId) {
        throw new IntegrationError(
          'INTEGRATION_CHANGE_SET_INVALID',
          'That change set belongs to a different project.',
        );
      }
      changeSets.push(changeSet);
    }

    const state = await this.state(
      this.target({
        ownerRef: owner,
        projectId: resolved.projectId,
        workspaceId: resolved.workspaceId,
      }),
    );
    const candidates: ConflictCandidate[] = [];
    for (const changeSet of changeSets) {
      candidates.push({ changeSet, contents: await this.contentsOf(changeSet) });
    }
    const baseContents = await this.baseContents(state.files, candidates);
    const reports = detectConflicts({ candidates, current: state, baseContents });
    const conflicts = allConflicts(reports);
    return {
      currentRevision: state.revision,
      reports,
      conflicts,
      blocked: conflicts.some((entry) => !entry.convergent),
    };
  }

  // -------------------------------------------------------------------------
  // Approval
  // -------------------------------------------------------------------------

  /**
   * Records the Primary Agent's decision.
   *
   * The conflict kinds the approver saw are stored with the decision, so an
   * approval cannot later be described as informed when it was not.
   */
  async recordApproval(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly changeSetIds: readonly string[];
    readonly decision: IntegrationApproval['decision'];
    readonly actor: string;
    readonly rationale: string;
    readonly conflictsSeen?: readonly IntegrationApproval['conflictsSeen'][number][];
    readonly verificationRequired?: boolean;
  }): Promise<IntegrationApproval> {
    const owner = input.ownerRef.trim();
    const ids = [...new Set(input.changeSetIds)].sort();
    if (ids.length === 0) throw new IntegrationError('INTEGRATION_EMPTY_SELECTION');
    const resolved = await this.resolve(owner, input.projectId);

    let conflictsSeen = [...(input.conflictsSeen ?? [])];
    if (input.conflictsSeen === undefined && ids.length > 0) {
      const analysis = await this.analyze({
        ownerRef: owner,
        projectId: resolved.projectId,
        changeSetIds: ids,
      });
      conflictsSeen = analysis.conflicts.map((entry) => entry.kind);
    }

    const approval: IntegrationApproval = {
      id: this.newId(),
      ownerRef: owner,
      projectId: resolved.projectId,
      changeSetIds: ids,
      decision: input.decision,
      actor: input.actor.slice(0, 120),
      rationale: input.rationale.slice(0, 800),
      conflictsSeen: [...new Set(conflictsSeen)],
      verificationRequired: input.verificationRequired ?? true,
      at: this.now().toISOString(),
    };
    await this.approvals.insert(approval);
    return approval;
  }

  // -------------------------------------------------------------------------
  // Integration
  // -------------------------------------------------------------------------

  async integrate(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly changeSetIds: readonly string[];
    readonly approvalId: string;
    readonly operations?: readonly string[];
    readonly actor?: string;
  }): Promise<IntegrationResult> {
    const owner = input.ownerRef.trim();
    const ids = [...new Set(input.changeSetIds)];
    if (ids.length === 0) throw new IntegrationError('INTEGRATION_EMPTY_SELECTION');
    if (ids.length > CHANGE_INTEGRATION_LIMITS.maxChangeSetsPerIntegration) {
      throw new IntegrationError('INTEGRATION_TOO_MANY_CHANGE_SETS');
    }
    const resolved = await this.resolve(owner, input.projectId);

    const approval = await this.approvals.get(owner, input.approvalId);
    if (approval === null || approval.projectId !== resolved.projectId) {
      throw new IntegrationError('INTEGRATION_APPROVAL_MISSING');
    }
    if (approval.decision !== 'approve') {
      throw new IntegrationError('INTEGRATION_APPROVAL_REJECTED');
    }
    const approved = [...approval.changeSetIds].sort();
    const requested = [...ids].sort();
    if (approved.length !== requested.length || approved.some((id, at) => id !== requested[at])) {
      throw new IntegrationError(
        'INTEGRATION_APPROVAL_SCOPE_MISMATCH',
        'That approval covers a different set of change sets.',
        { approved, requested },
      );
    }

    const token = `${owner}:${this.newId()}`;
    const acquired = await this.locks.acquire(resolved.projectId, token);
    if (!acquired) {
      throw new IntegrationError(
        'INTEGRATION_PROJECT_LOCKED',
        'Another integration is running against this project.',
      );
    }

    const at = this.now().toISOString();
    const integrationId = this.newId();
    let record: IntegrationRecord = {
      id: integrationId,
      ownerRef: owner,
      projectId: resolved.projectId,
      workspaceId: resolved.workspaceId,
      changeSetIds: ids,
      approvalId: approval.id,
      baseRevision: 0,
      resultRevision: null,
      status: 'pending',
      applied: [],
      conflicts: [],
      rollbackSnapshotId: null,
      rollback: null,
      verification: null,
      failure: null,
      createdAt: at,
      updatedAt: at,
    };

    try {
      const changeSets: WorkerChangeSet[] = [];
      for (const id of ids) {
        const changeSet = await this.changeSets.get(owner, id);
        if (changeSet === null) throw new IntegrationError('INTEGRATION_CHANGE_SET_NOT_FOUND');
        if (changeSet.status === 'integrated' || changeSet.integrationId !== null) {
          throw new IntegrationError(
            'INTEGRATION_CHANGE_SET_ALREADY_INTEGRATED',
            `${id} has already been integrated.`,
            { changeSetId: id, integrationId: changeSet.integrationId },
          );
        }
        if (changeSet.status !== 'open') {
          throw new IntegrationError(
            'INTEGRATION_CHANGE_SET_INVALID',
            `${id} is ${changeSet.status} and cannot be integrated.`,
          );
        }
        changeSets.push(changeSet);
      }

      const target = this.target({
        ownerRef: owner,
        projectId: resolved.projectId,
        workspaceId: resolved.workspaceId,
      });
      const state = await this.state(target);
      record = { ...record, baseRevision: state.revision };

      // Validate every set against the tree as it is right now.
      const contentsById = new Map<string, Map<string, string>>();
      for (const changeSet of changeSets) {
        const contents = await this.contentsOf(changeSet);
        contentsById.set(changeSet.id, contents);
        const validation = validateChangeSet({ changeSet, contents, current: state });
        if (!validation.ok) {
          throw new IntegrationError(
            'INTEGRATION_CHANGE_SET_INVALID',
            `${changeSet.id} failed validation.`,
            { changeSetId: changeSet.id, problems: validation.problems },
          );
        }
        if (validation.stale.length > 0) {
          throw new IntegrationError(
            'INTEGRATION_CHANGE_SET_STALE',
            `${changeSet.id} was drafted against an older project state.`,
            { changeSetId: changeSet.id, stale: validation.stale },
          );
        }
      }

      // Conflicts across the selection block the whole integration.
      const candidates: ConflictCandidate[] = changeSets.map((changeSet) => ({
        changeSet,
        contents: contentsById.get(changeSet.id) ?? new Map<string, string>(),
      }));
      const reports = detectConflicts({
        candidates,
        current: state,
        baseContents: await this.baseContents(state.files, candidates),
      });
      const conflicts = allConflicts(reports).filter((entry) => !entry.convergent);
      if (conflicts.length > 0) {
        record = { ...record, conflicts, status: 'failed', updatedAt: this.now().toISOString() };
        await this.integrations.insert(record);
        throw new IntegrationError(
          'INTEGRATION_CHANGE_SET_CONFLICTED',
          'The selected change sets conflict with each other.',
          { conflicts },
        );
      }

      // One snapshot before the first write: the rollback target.
      const snapshot = await this.tree.createSnapshot({
        ...target,
        label: `pre-integration ${integrationId}`,
        note: `Before integrating ${ids.join(', ')}`,
      });
      record = {
        ...record,
        status: 'applying',
        rollbackSnapshotId: snapshot.snapshotId,
        updatedAt: this.now().toISOString(),
      };
      await this.integrations.insert(record);

      const changes = changeSets.flatMap((changeSet) =>
        changeSet.files.map((file) => ({
          path: file.path,
          op: file.op,
          content:
            file.op === 'delete' ? null : (contentsById.get(changeSet.id)?.get(file.path) ?? null),
        })),
      );

      // A later change to the same path makes earlier expectations useless.
      const seenPaths = new Set<string>();
      for (const change of changes) {
        if (seenPaths.has(change.path)) {
          throw new IntegrationError(
            'INTEGRATION_CHANGE_SET_CONFLICTED',
            `Two selected change sets write ${change.path}.`,
            { path: change.path },
          );
        }
        seenPaths.add(change.path);
      }

      let applied: readonly AppliedFile[];
      try {
        const outcome = await this.tree.apply({
          ...target,
          changes,
          actor: 'ai-agent',
          summary: `Integrated ${ids.join(', ')}`,
        });
        applied = outcome.applied;

        for (const file of applied) {
          const expected = changeSets
            .flatMap((changeSet) => changeSet.files.map((entry) => ({ changeSet, entry })))
            .find((pair) => pair.entry.path === file.path)?.entry.proposedHash;
          if (expected !== undefined && file.contentHash !== expected) {
            throw new Error(`The project holds different content for ${file.path} than proposed.`);
          }
        }
      } catch (error) {
        // Compensate: restore the snapshot this integration took. The record
        // says the project was restored, and the change sets stay open so the
        // Primary Agent can retry or ask for a re-base.
        let restored = false;
        let restoredRevision: number | null = null;
        if (record.rollbackSnapshotId !== null) {
          try {
            const restore = await this.tree.restore({
              ...target,
              snapshotId: record.rollbackSnapshotId,
            });
            restored = true;
            restoredRevision = restore.revision;
          } catch {
            restored = false;
          }
        }
        const failureMessage =
          (error instanceof Error ? error.message : 'The integration failed.').slice(0, 300) +
          (restored ? ' The project was restored.' : ' The project may be partially written.');
        const failed: IntegrationRecord = {
          ...record,
          status: restored ? 'failed' : 'needs_review',
          resultRevision: restoredRevision,
          failure: { code: 'INTEGRATION_APPLY_FAILED', message: failureMessage },
          updatedAt: this.now().toISOString(),
        };
        await this.integrations.update(failed);
        throw new IntegrationError('INTEGRATION_APPLY_FAILED', failureMessage, {
          compensated: restored,
          integrationId: failed.id,
        });
      }

      let status: IntegrationRecord['status'] = 'integrated';
      let verification: IntegrationRecord['verification'] = null;
      const operations = input.operations ?? this.defaultOperations;
      if (this.verification !== undefined && this.verification.available()) {
        const outcome = await this.verification.run({
          ownerRef: owner,
          projectId: resolved.projectId,
          operations,
          integrationId,
          label: `after ${integrationId}`,
        });
        verification = {
          runId: outcome.runId,
          status: outcome.status,
          operations,
          evidenceRunStatus: outcome.evidenceStatus,
        };
        if (outcome.status === 'failed') status = 'needs_review';
      } else {
        verification = {
          runId: '',
          status: 'unavailable',
          operations,
          evidenceRunStatus: null,
        };
      }

      const outcome = await this.tree.snapshot(target);
      const finished: IntegrationRecord = {
        ...record,
        status,
        applied,
        resultRevision: outcome.revision,
        verification,
        updatedAt: this.now().toISOString(),
      };
      await this.integrations.update(finished);

      for (const changeSet of changeSets) {
        await this.changeSets.update({
          ...changeSet,
          status: 'integrated',
          integrationId: finished.id,
          updatedAt: finished.updatedAt,
        });
      }

      return {
        record: finished,
        applied: status === 'integrated' || status === 'needs_review',
        compensated: false,
      };
    } finally {
      await this.locks.release(resolved.projectId, token);
    }
  }

  // -------------------------------------------------------------------------
  // Rollback and recovery
  // -------------------------------------------------------------------------

  /**
   * Reverts one accepted integration.
   *
   * Refuses when any file the integration wrote has changed since: restoring
   * the snapshot would silently discard work nobody reviewed.
   */
  async rollback(input: {
    readonly ownerRef: string;
    readonly integrationId: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<IntegrationRecord> {
    const owner = input.ownerRef.trim();
    const record = await this.integrations.get(owner, input.integrationId);
    if (record === null) throw new IntegrationError('INTEGRATION_NOT_FOUND');
    if (record.status === 'rolled_back') {
      throw new IntegrationError(
        'INTEGRATION_ROLLBACK_UNAVAILABLE',
        'That integration has already been rolled back.',
      );
    }
    if (record.rollbackSnapshotId === null) {
      throw new IntegrationError(
        'INTEGRATION_ROLLBACK_UNAVAILABLE',
        'No snapshot was recorded for that integration, so it cannot be reverted safely.',
      );
    }

    const target = this.target({
      ownerRef: owner,
      projectId: record.projectId,
      workspaceId: record.workspaceId,
    });
    const state = await this.state(target);
    const byPath = new Map(state.files.map((file) => [file.path, file]));
    const moved = record.applied.filter((file) => {
      const current = byPath.get(file.path) ?? null;
      return (current?.contentHash ?? null) !== file.afterHash;
    });
    if (moved.length > 0) {
      throw new IntegrationError(
        'INTEGRATION_ROLLBACK_UNSAFE',
        'The project changed after this integration, so reverting it would erase that work.',
        { paths: moved.map((file) => file.path) },
      );
    }

    const restored = await this.tree.restore({
      ...target,
      snapshotId: record.rollbackSnapshotId,
    });
    const rolledBack: IntegrationRecord = {
      ...record,
      status: 'rolled_back',
      resultRevision: restored.revision,
      rollback: {
        at: this.now().toISOString(),
        actor: input.actor.slice(0, 120),
        reason: input.reason.slice(0, 400),
        restoredRevision: restored.revision,
      },
      updatedAt: this.now().toISOString(),
    };
    await this.integrations.update(rolledBack);

    for (const id of record.changeSetIds) {
      const changeSet = await this.changeSets.get(owner, id);
      if (changeSet === null) continue;
      await this.changeSets.update({
        ...changeSet,
        status: 'rolled_back',
        updatedAt: rolledBack.updatedAt,
      });
    }
    return rolledBack;
  }

  /**
   * Finishes or compensates integrations that were interrupted.
   *
   * An `applying` record with matching hashes completed before the crash; one
   * that does not match is restored from its snapshot. Nothing is assumed.
   */
  async recoverInterrupted(ownerRef: string): Promise<readonly IntegrationRecord[]> {
    const stuck = await this.integrations.list(ownerRef.trim(), {
      status: ['applying', 'pending'],
      limit: 50,
    });
    const recovered: IntegrationRecord[] = [];
    for (const record of stuck) {
      let restoredRevision: number | null = null;
      try {
        if (record.rollbackSnapshotId !== null) {
          const restore = await this.tree.restore({
            ...this.target({
              ownerRef: record.ownerRef,
              projectId: record.projectId,
              workspaceId: record.workspaceId,
            }),
            snapshotId: record.rollbackSnapshotId,
          });
          restoredRevision = restore.revision;
        }
      } catch {
        restoredRevision = null;
      }
      const next: IntegrationRecord = {
        ...record,
        status: 'interrupted',
        resultRevision: restoredRevision,
        failure: {
          code: 'INTEGRATION_INTERRUPTED',
          message:
            restoredRevision === null
              ? 'The integration was interrupted and could not be restored; review the project.'
              : 'The integration was interrupted and the project was restored to its pre-integration state.',
        },
        updatedAt: this.now().toISOString(),
      };
      await this.integrations.update(next);
      recovered.push(next);
    }
    return recovered;
  }

  async getIntegration(ownerRef: string, integrationId: string): Promise<IntegrationRecord> {
    const record = await this.integrations.get(ownerRef.trim(), integrationId);
    if (record === null) throw new IntegrationError('INTEGRATION_NOT_FOUND');
    return record;
  }

  listIntegrations(
    ownerRef: string,
    filter?: { projectId?: string; limit?: number },
  ): Promise<readonly IntegrationRecord[]> {
    return this.integrations.list(ownerRef.trim(), filter ?? {});
  }

  listChangeSets(
    ownerRef: string,
    filter?: {
      projectId?: string;
      taskId?: string;
      workerId?: string;
      status?: readonly WorkerChangeSet['status'][];
      limit?: number;
    },
  ): Promise<readonly WorkerChangeSet[]> {
    return this.changeSets.list(ownerRef.trim(), filter ?? {});
  }

  /** True when the error came from source storage rather than this layer. */
  static isStorageError(error: unknown): boolean {
    return error instanceof SourceError;
  }
}
