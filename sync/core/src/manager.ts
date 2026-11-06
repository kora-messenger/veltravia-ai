import { randomBytes } from 'node:crypto';

import { assertSafeExportPath } from '@veltravia/export-core';

import { SyncError } from './errors.js';
import { contentSha } from './hash.js';
import { buildPlan } from './planner.js';
import type { LocalProjectPort, RemotePort } from './ports.js';
import { screenFile } from './screen.js';
import type { PlanRecord, SyncStore } from './store.js';
import { InMemorySyncStore } from './store.js';
import {
  SYNC_LIMITS,
  type BranchChoice,
  type Conflict,
  type ConflictResolution,
  type HistoryOutcome,
  type RepositoryChoice,
  type SyncConnection,
  type SyncHistoryEntry,
  type SyncPlan,
} from './types.js';

export interface SyncManagerOptions {
  readonly local: LocalProjectPort;
  readonly remote: RemotePort;
  readonly store?: SyncStore;
  readonly now?: () => Date;
}

/** What `status` reports. */
export interface SyncStatus {
  readonly connected: boolean;
  readonly connection: SyncConnection | null;
  /** Plans still waiting for a decision. */
  readonly openPlans: readonly SyncPlan[];
  readonly hasUnresolvedConflicts: boolean;
  /** Plain statement about what persists. */
  readonly persistence: 'memory';
}

const randomId = (prefix: string): string => `${prefix}_${randomBytes(15).toString('base64url')}`;

/**
 * Owner-scoped GitHub synchronisation.
 *
 * Every public method takes the owner first. A project that is missing or
 * belongs to someone else, and a plan or conflict that is missing or belongs to
 * someone else, all answer the same way, so ids cannot be probed.
 *
 * Nothing here talks to GitHub except through RemotePort (the existing
 * connector) and nothing reads the project except through LocalProjectPort.
 * The manager never sees a token.
 */
export class SyncManager {
  private readonly local: LocalProjectPort;
  private readonly remote: RemotePort;
  private readonly store: SyncStore;
  private readonly now: () => Date;

  constructor(options: SyncManagerOptions) {
    this.local = options.local;
    this.remote = options.remote;
    this.store = options.store ?? new InMemorySyncStore();
    this.now = options.now ?? (() => new Date());
  }

  // ==== discovery ===========================================================

  /** Repositories the connector may touch. Any project owner may see the list. */
  async listRepositories(): Promise<readonly RepositoryChoice[]> {
    return this.guarded(() => this.remote.listRepositories());
  }

  async listBranches(
    ownerRef: string,
    input: {
      projectId?: string;
      owner: string;
      repository: string;
    },
  ): Promise<readonly BranchChoice[]> {
    if (input.projectId !== undefined) await this.project(ownerRef, input.projectId);
    await this.requireAllowed(input.owner, input.repository);
    return this.guarded(() => this.remote.listBranches(input.owner, input.repository));
  }

  // ==== connection ==========================================================

  status(ownerRef: string, projectId: string): SyncStatus {
    const connection = this.store.getConnection(ownerRef, projectId) ?? null;
    const open = this.openPlans(ownerRef, projectId).map((r) => r.plan);
    return {
      connected: connection !== null,
      connection,
      openPlans: open,
      hasUnresolvedConflicts: this.openPlans(ownerRef, projectId).some((r) =>
        r.conflicts.some((c) => c.resolution === null),
      ),
      persistence: 'memory',
    };
  }

  async connect(
    ownerRef: string,
    input: {
      projectId: string;
      owner: string;
      repository: string;
      branch: string;
    },
  ): Promise<SyncConnection> {
    await this.project(ownerRef, input.projectId);
    if (this.store.getConnection(ownerRef, input.projectId) !== undefined) {
      throw new SyncError(
        'SYNC_ALREADY_CONNECTED',
        'This project is already connected to a repository. Disconnect it first.',
      );
    }
    await this.requireAllowed(input.owner, input.repository);
    const branches = await this.guarded(() =>
      this.remote.listBranches(input.owner, input.repository),
    );
    if (!branches.some((b) => b.name === input.branch)) {
      throw new SyncError('SYNC_BRANCH_NOT_FOUND', 'That branch does not exist in the repository.');
    }
    const connection: SyncConnection = {
      projectId: input.projectId,
      owner: input.owner,
      repository: input.repository,
      branch: input.branch,
      connectedAt: this.now().toISOString(),
      lastSyncedCommit: null,
      lastSyncedAt: null,
    };
    this.store.putConnection(ownerRef, connection);
    // A fresh connection has agreed nothing yet: no base.
    this.store.deleteBase(ownerRef, input.projectId);
    return connection;
  }

  /**
   * Forget the link. Nothing remote is touched or deleted, and the project's
   * files, revisions and checkpoints are untouched.
   */
  disconnect(ownerRef: string, projectId: string): void {
    if (this.store.getConnection(ownerRef, projectId) === undefined) {
      throw new SyncError('SYNC_NOT_CONNECTED', 'This project is not connected to a repository.');
    }
    for (const record of this.store.plansFor(ownerRef, projectId)) {
      this.store.deletePlan(record.plan.planId);
    }
    this.store.deleteConnection(ownerRef, projectId);
    this.store.deleteBase(ownerRef, projectId);
  }

  // ==== planning ============================================================

  /** Compare the project with the branch. Writes nothing anywhere. */
  async plan(ownerRef: string, input: { projectId: string; message?: string }): Promise<SyncPlan> {
    const project = await this.project(ownerRef, input.projectId);
    const connection = this.requireConnection(ownerRef, input.projectId);
    const message = this.cleanMessage(input.message);

    const [snapshot, remote] = await Promise.all([
      this.local.readSnapshot(project.workspaceId),
      this.guarded(() =>
        this.remote.readSnapshot(connection.owner, connection.repository, connection.branch),
      ),
    ]);
    if (remote.truncated) {
      // A partial file list would make files look deleted. Refuse instead.
      throw new SyncError(
        'SYNC_REMOTE_TRUNCATED',
        'The repository is too large to compare completely, so nothing was planned.',
      );
    }
    if (remote.files.length > SYNC_LIMITS.maxRemoteFiles) {
      throw new SyncError(
        'SYNC_UNSUPPORTED',
        'The repository holds too many files to synchronise.',
      );
    }

    const branches = await this.guarded(() =>
      this.remote.listBranches(connection.owner, connection.repository),
    );
    const branchIsDefault = branches.find((b) => b.name === connection.branch)?.isDefault === true;

    const base = this.store.getBase(ownerRef, input.projectId) ?? null;
    const body = buildPlan({
      local: snapshot.files,
      remote: remote.files,
      base,
      branchIsDefault,
      remoteSkippedCount: remote.skipped,
    });

    if (body.push.length > SYNC_LIMITS.maxChangesPerCommit) {
      throw new SyncError(
        'SYNC_TOO_MANY_CHANGES',
        `This sync changes more than ${SYNC_LIMITS.maxChangesPerCommit} files. Sync a smaller set.`,
      );
    }

    // Conflicts keep BOTH versions' text until a person decides.
    const conflicts: Conflict[] = [];
    const bodies = new Map<string, { local: string | null; remote: string | null }>();
    const localText = new Map(snapshot.files.map((f) => [f.path, f.content]));
    for (const found of body.conflicts) {
      const remoteText =
        found.remoteHash === null
          ? null
          : await this.guarded(() =>
              this.remote.readText(
                connection.owner,
                connection.repository,
                connection.branch,
                found.path,
              ),
            );
      conflicts.push({ ...found, id: randomId('cfl'), resolution: null });
      bodies.set(found.path, { local: localText.get(found.path) ?? null, remote: remoteText });
    }

    // Content to publish, by path.
    const pushContent = new Map<string, string | null>();
    for (const change of body.push) {
      pushContent.set(
        change.path,
        change.kind === 'delete' ? null : (localText.get(change.path) ?? null),
      );
      if (change.kind === 'rename' && change.fromPath !== undefined) {
        pushContent.set(change.fromPath, null);
      }
    }

    // Inbound files are screened on their TEXT, now that it is fetched.
    const skipped = [...body.skipped];
    const pull = [];
    const pullContent = new Map<string, string | null>();
    for (const change of body.pull) {
      if (change.kind === 'delete') {
        pull.push(change);
        pullContent.set(change.path, null);
        continue;
      }
      const text = await this.guarded(() =>
        this.remote.readText(
          connection.owner,
          connection.repository,
          connection.branch,
          change.path,
        ),
      );
      if (text === null) {
        skipped.push({
          path: change.path,
          side: 'remote',
          reason: 'not-text',
          detail: 'This remote file is not text, so it was not brought into the project.',
        });
        continue;
      }
      const screened = screenFile({ side: 'remote', path: change.path, content: text });
      if (!screened.ok && screened.skip !== undefined) {
        skipped.push(screened.skip);
        continue;
      }
      pull.push(change);
      pullContent.set(change.path, text);
    }

    const createdAt = this.now();
    const needsApproval = body.approvalReasons.length > 0;
    const status: SyncPlan['status'] =
      conflicts.length > 0
        ? 'conflicts'
        : body.push.length === 0 && pull.length === 0
          ? 'in-sync'
          : needsApproval
            ? 'needs-approval'
            : 'ready';

    const planned: SyncPlan = {
      planId: randomId('plan'),
      projectId: input.projectId,
      owner: connection.owner,
      repository: connection.repository,
      branch: connection.branch,
      status,
      mode: body.mode,
      remoteHead: remote.headSha,
      localRevision: snapshot.revision,
      push: body.push,
      pull,
      conflicts,
      skipped,
      unchanged: body.unchanged,
      approvalReasons: body.approvalReasons,
      approved: false,
      message: message ?? defaultMessage(body.mode, body.push, project.name),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + SYNC_LIMITS.planTtlMs).toISOString(),
      failure: null,
    };
    // Supersede any earlier open plan for this project: only one is live.
    for (const old of this.openPlans(ownerRef, input.projectId))
      this.store.deletePlan(old.plan.planId);

    const record: PlanRecord = {
      ownerRef,
      plan: planned,
      conflicts,
      bodies,
      pushContent,
      manual: new Map(),
      cancelled: false,
    };
    // Pull content rides along on the push map under a separate key space.
    for (const [path, text] of pullContent) record.pushContent.set(`pull:${path}`, text);
    this.store.putPlan(record);
    return planned;
  }

  // ==== approval and conflicts ==================================================

  getPlan(ownerRef: string, planId: string): SyncPlan {
    return this.record(ownerRef, planId).plan;
  }

  /** The two versions of a conflicted file. Screened again before they leave. */
  viewConflict(
    ownerRef: string,
    planId: string,
    conflictId: string,
  ): {
    conflict: Conflict;
    local: string | null;
    remote: string | null;
    withheld: boolean;
  } {
    const record = this.record(ownerRef, planId);
    const conflict = record.conflicts.find((c) => c.id === conflictId);
    if (conflict === undefined)
      throw new SyncError('SYNC_NOT_FOUND', 'That conflict was not found.');
    const bodies = record.bodies.get(conflict.path) ?? { local: null, remote: null };
    // A secret must not reach a response even through a conflict view.
    const safe = (text: string | null) =>
      text !== null && screenFile({ side: 'local', path: conflict.path, content: text }).ok
        ? text
        : null;
    const local = safe(bodies.local);
    const remote = safe(bodies.remote);
    return {
      conflict,
      local,
      remote,
      withheld:
        (bodies.local !== null && local === null) || (bodies.remote !== null && remote === null),
    };
  }

  resolveConflict(
    ownerRef: string,
    planId: string,
    conflictId: string,
    input: {
      resolution: ConflictResolution;
      manualContent?: string;
    },
  ): SyncPlan {
    const record = this.activeRecord(ownerRef, planId);
    const index = record.conflicts.findIndex((c) => c.id === conflictId);
    const conflict = record.conflicts[index];
    if (conflict === undefined)
      throw new SyncError('SYNC_NOT_FOUND', 'That conflict was not found.');

    if (input.resolution === 'manual') {
      if (typeof input.manualContent !== 'string') {
        throw new SyncError('SYNC_INVALID_REQUEST', 'Manual resolution needs the merged text.');
      }
      const screened = screenFile({
        side: 'local',
        path: conflict.path,
        content: input.manualContent,
      });
      if (!screened.ok) {
        // A distinguishable state: the request was well formed, its CONTENT was
        // refused. (400 would tell a client to fix its JSON, which is wrong.)
        throw new SyncError(
          'SYNC_SECRET_REJECTED',
          'The merged text looks like it contains a credential and cannot be synchronised.',
        );
      }
      record.manual.set(conflict.path, input.manualContent);
    } else {
      record.manual.delete(conflict.path);
    }
    record.conflicts[index] = { ...conflict, resolution: input.resolution };
    return this.refresh(record);
  }

  /**
   * A person's approval of exactly this plan. Re-planning discards it, so an
   * approval can never carry over to different changes.
   */
  approve(ownerRef: string, planId: string): SyncPlan {
    const record = this.activeRecord(ownerRef, planId);
    if (record.conflicts.some((c) => c.resolution === null)) {
      throw new SyncError('SYNC_CONFLICTS_UNRESOLVED', 'Resolve every conflict before approving.');
    }
    record.plan = { ...record.plan, approved: true };
    return this.refresh(record);
  }

  cancel(ownerRef: string, planId: string): SyncPlan {
    const record = this.record(ownerRef, planId);
    if (record.plan.status === 'applied') {
      throw new SyncError('SYNC_PLAN_NOT_ACTIVE', 'That sync has already been applied.');
    }
    record.cancelled = true;
    record.plan = { ...record.plan, status: 'cancelled' };
    this.logHistory(
      ownerRef,
      record.plan,
      'cancelled',
      null,
      record.plan.approved ? 'approved' : 'declined',
    );
    return record.plan;
  }

  // ==== apply ===============================================================

  async apply(
    ownerRef: string,
    planId: string,
  ): Promise<{ plan: SyncPlan; commitSha: string | null }> {
    const record = this.activeRecord(ownerRef, planId);
    const plan = record.plan;
    const connection = this.requireConnection(ownerRef, plan.projectId);
    const project = await this.project(ownerRef, plan.projectId);

    if (record.conflicts.some((c) => c.resolution === null)) {
      this.logHistory(ownerRef, plan, 'conflicts', null, 'declined');
      throw new SyncError('SYNC_CONFLICTS_UNRESOLVED', 'Resolve every conflict before applying.');
    }
    const needs = this.approvalReasonsNow(record);
    if (needs.length > 0 && !plan.approved) {
      throw new SyncError('SYNC_APPROVAL_REQUIRED', 'A person must approve this sync first.');
    }
    // The world must still be what the plan was made against.
    if ((await this.local.currentRevision(project.workspaceId)) !== plan.localRevision) {
      throw new SyncError(
        'SYNC_PLAN_STALE',
        'The project changed since this plan was made. Plan again.',
      );
    }

    // -- what goes to the remote ------------------------------------------
    const changes = new Map<string, string | null>();
    for (const change of plan.push) {
      if (change.kind === 'rename' && change.fromPath !== undefined)
        changes.set(change.fromPath, null);
      changes.set(change.path, record.pushContent.get(change.path) ?? null);
    }
    // -- what comes into the project -----------------------------------------
    const incoming = new Map<string, string | null>();
    for (const change of plan.pull) {
      incoming.set(change.path, record.pushContent.get(`pull:${change.path}`) ?? null);
    }
    // -- conflict resolutions ----------------------------------------------------
    for (const conflict of record.conflicts) {
      const bodies = record.bodies.get(conflict.path) ?? { local: null, remote: null };
      if (conflict.resolution === 'keep-local') {
        changes.set(conflict.path, bodies.local); // null deletes remotely
      } else if (conflict.resolution === 'keep-remote') {
        incoming.set(conflict.path, bodies.remote); // null deletes locally
      } else if (conflict.resolution === 'manual') {
        const merged = record.manual.get(conflict.path) ?? null;
        changes.set(conflict.path, merged);
        incoming.set(conflict.path, merged);
      }
    }

    if (changes.size > SYNC_LIMITS.maxChangesPerCommit) {
      throw new SyncError(
        'SYNC_TOO_MANY_CHANGES',
        'This sync changes too many files for one commit.',
      );
    }

    let commitSha: string | null = null;
    try {
      if (record.cancelled) throw new SyncError('SYNC_CANCELLED', 'This sync was cancelled.');
      if (changes.size > 0) {
        const result = await this.guarded(() =>
          this.remote.publish({
            owner: connection.owner,
            repository: connection.repository,
            branch: connection.branch,
            expectedHeadSha: plan.remoteHead,
            message: plan.message,
            changes: [...changes].map(([path, content]) => ({ path, content })),
          }),
        );
        commitSha = result.commitSha;
      }
      if (record.cancelled) {
        // Cancelled after the remote commit: report it honestly, do not undo it.
        throw new SyncError(
          'SYNC_CANCELLED',
          'This sync was cancelled after the commit was published.',
        );
      }
      for (const [path, content] of incoming) {
        if (content === null) await this.local.deleteFile(project.workspaceId, path);
        else await this.local.writeFile(project.workspaceId, path, content);
      }
    } catch (error) {
      const failure = toFailure(error);
      record.plan = { ...plan, status: 'failed', failure };
      this.logHistory(
        ownerRef,
        record.plan,
        'failure',
        commitSha,
        plan.approved ? 'approved' : 'not-required',
        failure.code,
      );
      throw error instanceof SyncError
        ? error
        : new SyncError('SYNC_INTERNAL', 'The sync could not be completed.');
    }

    // The new base is the state both sides now share.
    const newBase = await this.newBase(ownerRef, plan, project.workspaceId, changes, incoming);
    this.store.putBase(ownerRef, plan.projectId, newBase);
    const head = commitSha ?? plan.remoteHead;
    this.store.putConnection(ownerRef, {
      ...connection,
      lastSyncedCommit: head,
      lastSyncedAt: this.now().toISOString(),
    });

    record.plan = { ...plan, status: 'applied' };
    this.logHistory(
      ownerRef,
      record.plan,
      'success',
      commitSha,
      needs.length > 0 ? 'approved' : 'not-required',
    );
    // Content is no longer needed; drop both versions of every resolved conflict.
    record.bodies.clear();
    record.pushContent.clear();
    record.manual.clear();
    return { plan: record.plan, commitSha };
  }

  // ==== history =============================================================

  history(ownerRef: string, projectId: string): readonly SyncHistoryEntry[] {
    return this.store.history(ownerRef, projectId);
  }

  // ==== internals ===========================================================

  private async newBase(
    ownerRef: string,
    plan: SyncPlan,
    workspaceId: string,
    changes: Map<string, string | null>,
    incoming: Map<string, string | null>,
  ): Promise<Map<string, string>> {
    // Re-read both sides' agreed state from what was just applied.
    const base = new Map(this.store.getBase(ownerRef, plan.projectId) ?? []);
    for (const [path, content] of changes) {
      if (content === null) base.delete(path);
      else base.set(path, contentSha(content));
    }
    for (const [path, content] of incoming) {
      if (content === null) base.delete(path);
      else base.set(path, contentSha(content));
    }
    // Files that were identical on both sides join the base too.
    const snapshot = await this.local.readSnapshot(workspaceId);
    const remote = await this.guarded(() =>
      this.remote.readSnapshot(plan.owner, plan.repository, plan.branch),
    );
    const remoteHashes = new Map(remote.files.map((f) => [f.path, f.hashOfText]));
    for (const file of snapshot.files) {
      const h = contentSha(file.content);
      if (remoteHashes.get(file.path) === h) base.set(file.path, h);
    }
    return base;
  }

  private approvalReasonsNow(record: PlanRecord): SyncPlan['approvalReasons'] {
    const reasons = [...record.plan.approvalReasons];
    if (record.conflicts.some((c) => c.resolution === 'keep-local' || c.resolution === 'manual')) {
      if (!reasons.includes('conflict-resolution')) reasons.push('conflict-resolution');
    }
    return reasons;
  }

  private refresh(record: PlanRecord): SyncPlan {
    const reasons = this.approvalReasonsNow(record);
    const unresolved = record.conflicts.some((c) => c.resolution === null);
    const nothing =
      record.plan.push.length === 0 &&
      record.plan.pull.length === 0 &&
      record.conflicts.length === 0;
    const status: SyncPlan['status'] = unresolved
      ? 'conflicts'
      : nothing
        ? 'in-sync'
        : reasons.length > 0 && !record.plan.approved
          ? 'needs-approval'
          : 'ready';
    // Resolving a conflict changes what would be published: approval starts over.
    record.plan = { ...record.plan, status, approvalReasons: reasons };
    this.store.putPlan(record);
    return record.plan;
  }

  private openPlans(ownerRef: string, projectId: string): PlanRecord[] {
    this.expire(ownerRef, projectId);
    return this.store
      .plansFor(ownerRef, projectId)
      .filter((r) => !['applied', 'cancelled', 'expired', 'failed'].includes(r.plan.status));
  }

  private expire(ownerRef: string, projectId: string): void {
    const nowMs = this.now().getTime();
    for (const record of this.store.plansFor(ownerRef, projectId)) {
      if (
        !['applied', 'cancelled', 'expired', 'failed'].includes(record.plan.status) &&
        Date.parse(record.plan.expiresAt) <= nowMs
      ) {
        record.plan = { ...record.plan, status: 'expired' };
        record.bodies.clear();
        record.pushContent.clear();
      }
    }
  }

  private record(ownerRef: string, planId: string): PlanRecord {
    const record = this.store.getPlan(planId);
    if (record === undefined || record.ownerRef !== ownerRef) {
      throw new SyncError('SYNC_NOT_FOUND', 'That sync plan was not found.');
    }
    this.expire(ownerRef, record.plan.projectId);
    return record;
  }

  private activeRecord(ownerRef: string, planId: string): PlanRecord {
    const record = this.record(ownerRef, planId);
    if (record.plan.status === 'expired') {
      throw new SyncError('SYNC_PLAN_EXPIRED', 'That sync plan expired. Plan again.');
    }
    if (['applied', 'cancelled', 'failed'].includes(record.plan.status)) {
      throw new SyncError('SYNC_PLAN_NOT_ACTIVE', 'That sync plan is no longer active.');
    }
    return record;
  }

  private async project(ownerRef: string, projectId: unknown) {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
      throw new SyncError('SYNC_INVALID_REQUEST', 'projectId is not a valid project id.');
    }
    const project = await this.local.resolveProject({ ownerRef, projectId });
    if (project === null) throw new SyncError('SYNC_NOT_FOUND', 'That project was not found.');
    return project;
  }

  private requireConnection(ownerRef: string, projectId: string): SyncConnection {
    const connection = this.store.getConnection(ownerRef, projectId);
    if (connection === undefined) {
      throw new SyncError('SYNC_NOT_CONNECTED', 'This project is not connected to a repository.');
    }
    return connection;
  }

  /** A repository is usable only if the connector itself lists it. */
  private async requireAllowed(owner: string, repository: string): Promise<void> {
    const allowed = await this.guarded(() => this.remote.listRepositories());
    const found = allowed.some(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.repository.toLowerCase() === repository.toLowerCase(),
    );
    if (!found) {
      throw new SyncError(
        'SYNC_REPOSITORY_NOT_ALLOWED',
        'That repository is not available to Veltravia.',
      );
    }
  }

  private cleanMessage(message: string | undefined): string | null {
    if (message === undefined) return null;
    const trimmed = message.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > SYNC_LIMITS.maxMessageLength) {
      throw new SyncError('SYNC_INVALID_REQUEST', 'The commit message is too long.');
    }
    return trimmed;
  }

  /** Wraps a remote call so a connector failure becomes a clean, non-leaking SyncError. */
  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof SyncError) throw error;
      const code = (error as { code?: unknown }).code;
      if (code === 'GITHUB_SCOPE_DENIED') {
        throw new SyncError(
          'SYNC_REPOSITORY_NOT_ALLOWED',
          'That repository is not available to Veltravia.',
        );
      }
      if (code === 'GITHUB_CONFLICT' || code === 'GITHUB_VALIDATION') {
        throw new SyncError(
          'SYNC_REMOTE_CHANGED',
          'The branch changed on GitHub while syncing. Nothing was overwritten; plan again.',
        );
      }
      if (code === 'GITHUB_NOT_FOUND') {
        throw new SyncError('SYNC_BRANCH_NOT_FOUND', 'The repository or branch was not found.');
      }
      // Never forward the connector's message: it can carry paths and bodies.
      throw new SyncError(
        'SYNC_GITHUB_FAILED',
        'GitHub could not be reached or refused the request.',
      );
    }
  }

  private logHistory(
    ownerRef: string,
    plan: SyncPlan,
    outcome: HistoryOutcome,
    commitSha: string | null,
    approval: SyncHistoryEntry['approval'],
    failureCode: string | null = null,
  ): void {
    this.store.addHistory(ownerRef, {
      entryId: randomId('hist'),
      projectId: plan.projectId,
      owner: plan.owner,
      repository: plan.repository,
      branch: plan.branch,
      outcome,
      commitSha,
      message: plan.message,
      at: this.now().toISOString(),
      added: plan.push.filter((c) => c.kind === 'add' || c.kind === 'rename').map((c) => c.path),
      modified: plan.push.filter((c) => c.kind === 'modify').map((c) => c.path),
      deleted: plan.push.filter((c) => c.kind === 'delete').map((c) => c.path),
      pulled: plan.pull.length,
      conflicts: plan.conflicts.length,
      approval,
      failureCode,
    });
  }
}

function defaultMessage(
  mode: 'initial' | 'update',
  push: readonly { kind: string }[],
  name: string,
): string {
  const count = (k: string) => push.filter((c) => c.kind === k).length;
  if (mode === 'initial')
    return push.length === 0
      ? 'Initial sync from Veltravia: nothing to publish'
      : `Initial sync from Veltravia: ${String(push.length)} file${push.length === 1 ? '' : 's'}`;
  const parts = [
    count('add') > 0 ? `${count('add')} added` : '',
    count('modify') > 0 ? `${count('modify')} changed` : '',
    count('delete') > 0 ? `${count('delete')} removed` : '',
    count('rename') > 0 ? `${count('rename')} renamed` : '',
  ].filter(Boolean);
  void name;
  return `Sync from Veltravia: ${parts.join(', ') || 'no file changes'}`;
}

function toFailure(error: unknown): { code: string; message: string } {
  if (error instanceof SyncError) return { code: error.code, message: error.message };
  return { code: 'SYNC_INTERNAL', message: 'The sync could not be completed.' };
}

export { assertSafeExportPath };
