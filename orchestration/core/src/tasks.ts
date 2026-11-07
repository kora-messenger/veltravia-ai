/**
 * The task manager: the only place a task changes.
 *
 * Rules this file enforces, in order:
 *  - every call names an owner, and a task is invisible to any other owner;
 *  - a task's project scope is verified by a server-side guard before the row
 *    is written, never taken from the request;
 *  - a status change is checked against the lifecycle table, and the two
 *    policy edges (retry, review) have their own methods;
 *  - a worker may not complete a task. Only a recorded review does that;
 *  - text that looks like a credential is refused rather than stored.
 */

import { containsSecretShaped } from './secrets.js';

import { assessCompletion, validateAssignment } from './assignment.js';
import type { CompletionEvidence } from './assignment.js';
import { OrchestrationError } from './errors.js';
import { assertTransition, isKnownStatus, transitionIsGuarded } from './lifecycle.js';
import type { TaskStore } from './store.js';
import type {
  AcceptanceCriterion,
  CheckpointReference,
  FailureSummary,
  ReviewStatus,
  StoredTask,
  TaskActor,
  TaskAssignment,
  TaskAttempt,
  TaskEvent,
  TaskEventType,
  TaskFilter,
  TaskProgress,
  TaskRecord,
  TaskResult,
  TaskStatus,
} from './types.js';
import { TASK_LIMITS } from './types.js';

/** Server-side verification of a task's project scope. */
export interface TaskScopeGuard {
  ownsProject(ownerRef: string, projectId: string): Promise<boolean>;
  workspaceBelongsToProject(
    ownerRef: string,
    projectId: string,
    workspaceId: string,
  ): Promise<boolean>;
}

export interface TaskManagerOptions {
  readonly store: TaskStore;
  readonly scope: TaskScopeGuard;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Injected so a test can prove a credential-shaped objective is refused. */
  readonly looksLikeSecret?: (text: string) => boolean;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly objective: string;
  readonly projectId: string | null;
  readonly workspaceId?: string | null;
  readonly chatId?: string | null;
  readonly parentTaskId?: string | null;
  readonly dependencies?: readonly string[];
  readonly assignment?: unknown;
  readonly acceptance?: readonly AcceptanceCriterion[];
  readonly createdBy?: 'primary_agent' | 'owner';
  readonly maxAttempts?: number;
  readonly checkpoint?: CheckpointReference | null;
}

export interface TaskView {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly chatId: string | null;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly status: TaskStatus;
  readonly reviewStatus: ReviewStatus | null;
  readonly assignment: TaskAssignment | null;
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly dependencies: readonly string[];
  readonly result: TaskResult | null;
  readonly failure: FailureSummary | null;
  readonly retry: TaskRecord['retry'];
  readonly checkpoint: CheckpointReference | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new OrchestrationError('TASK_INVALID', `${field} must be text.`);
  }
  const text = value.trim();
  if (text.length === 0) throw new OrchestrationError('TASK_INVALID', `${field} cannot be empty.`);
  if (text.length > max) {
    throw new OrchestrationError('TASK_INVALID', `${field} is longer than ${max} characters.`);
  }
  return text;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return cleanText(value, field, max);
}

const DEFAULT_SECRET_SCAN = containsSecretShaped;

export class TaskManager {
  private readonly store: TaskStore;
  private readonly scope: TaskScopeGuard;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly looksLikeSecret: (text: string) => boolean;

  constructor(options: TaskManagerOptions) {
    this.store = options.store;
    this.scope = options.scope;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `task_${randomId()}`);
    this.looksLikeSecret = options.looksLikeSecret ?? DEFAULT_SECRET_SCAN;
  }

  private guardText(text: string, field: string): string {
    if (this.looksLikeSecret(text)) {
      throw new OrchestrationError(
        'TASK_SECRET_REJECTED',
        `${field} looks like it contains a credential. Task records never store secrets.`,
      );
    }
    forbiddenKeys(text);
    return text;
  }

  private event(
    taskId: string,
    seq: number,
    type: TaskEventType,
    actor: TaskActor,
    fields: {
      fromStatus?: TaskStatus | null;
      toStatus?: TaskStatus | null;
      message?: string | null;
      detail?: Record<string, unknown> | null;
    } = {},
  ): TaskEvent {
    return {
      taskId,
      seq,
      type,
      actor,
      fromStatus: fields.fromStatus ?? null,
      toStatus: fields.toStatus ?? null,
      message: fields.message ?? null,
      detail: fields.detail ?? null,
      at: this.now().toISOString(),
    };
  }

  async createTask(ownerRef: string, input: CreateTaskInput): Promise<TaskView> {
    const owner = ownerRef.trim();
    if (owner.length === 0) throw new OrchestrationError('TASK_INVALID', 'A task needs an owner.');

    const title = this.guardText(
      cleanText(input.title, 'title', TASK_LIMITS.maxTitleLength),
      'title',
    );
    const objective = this.guardText(
      cleanText(input.objective, 'objective', TASK_LIMITS.maxObjectiveLength),
      'objective',
    );

    const projectId = input.projectId ?? null;
    const workspaceId = input.workspaceId ?? null;
    if (projectId === null) {
      throw new OrchestrationError('TASK_SCOPE_REQUIRED');
    }
    if (!(await this.scope.ownsProject(owner, projectId))) {
      throw new OrchestrationError('TASK_PROJECT_FORBIDDEN');
    }
    if (
      workspaceId !== null &&
      !(await this.scope.workspaceBelongsToProject(owner, projectId, workspaceId))
    ) {
      throw new OrchestrationError('TASK_PROJECT_FORBIDDEN');
    }

    const existing = await this.store.count(owner);
    if (existing >= TASK_LIMITS.maxTasksPerOwner) {
      throw new OrchestrationError('TASK_LIMIT_REACHED');
    }

    const chatId = optionalText(input.chatId, 'chatId', 128);
    const parentTaskId = optionalText(input.parentTaskId, 'parentTaskId', 128);
    if (parentTaskId !== null) {
      const parent = await this.store.read(owner, parentTaskId);
      if (parent === null || parent.task.projectId !== projectId) {
        throw new OrchestrationError(
          'TASK_DEPENDENCY_INVALID',
          'A parent task must be an existing task in the same project.',
        );
      }
    }

    const dependencies = [...new Set(input.dependencies ?? [])];
    if (dependencies.length > TASK_LIMITS.maxDependencies) {
      throw new OrchestrationError('TASK_DEPENDENCY_LIMIT');
    }
    for (const dependency of dependencies) {
      if (dependency === '' || dependency.length > 128) {
        throw new OrchestrationError('TASK_DEPENDENCY_INVALID');
      }
      const target = await this.store.read(owner, dependency);
      if (target === null || target.task.projectId !== projectId) {
        throw new OrchestrationError(
          'TASK_DEPENDENCY_INVALID',
          'A dependency must be an existing task in the same project.',
        );
      }
    }

    const assignment =
      input.assignment === undefined || input.assignment === null
        ? null
        : validateAssignment(input.assignment);
    if (assignment !== null) {
      this.guardText(assignment.objective, 'assignment objective');
      const scopeProject = assignment.scope.projectId;
      if (scopeProject !== null && scopeProject !== projectId) {
        throw new OrchestrationError(
          'ASSIGNMENT_INVALID',
          'An assignment cannot point at a different project than its task.',
        );
      }
    }

    const acceptance = input.acceptance ?? assignment?.acceptance ?? [];
    for (const criterion of acceptance) {
      this.guardText(criterion.statement, 'acceptance criterion');
    }

    const maxAttempts = Math.min(
      TASK_LIMITS.hardMaxAttempts,
      Math.max(1, input.maxAttempts ?? TASK_LIMITS.defaultMaxAttempts),
    );

    const at = this.now().toISOString();
    const id = this.newId();
    const task: TaskRecord = {
      id,
      ownerRef: owner,
      projectId,
      workspaceId,
      chatId,
      parentTaskId,
      title,
      objective,
      status: 'queued',
      reviewStatus: null,
      assignment,
      result: null,
      failure: null,
      retry: { attempts: 0, maxAttempts, lastFailure: null, lastRetriedAt: null },
      checkpoint: input.checkpoint ?? null,
      createdBy: input.createdBy ?? 'primary_agent',
      version: 1,
      eventSeq: 1,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      cancelledAt: null,
    };

    await this.store.insert({
      task,
      dependencies,
      events: [
        this.event(id, 1, 'created', input.createdBy === 'owner' ? 'owner' : 'primary_agent', {
          toStatus: 'queued',
          message: `Task created: ${title}`,
          detail: { projectId, workspaceId, chatId },
        }),
      ],
    });
    return this.toView({ task, dependencies });
  }

  async getTask(ownerRef: string, taskId: string): Promise<TaskView> {
    return this.toView(await this.requireTask(ownerRef, taskId));
  }

  async listTasks(ownerRef: string, filter: TaskFilter = {}): Promise<readonly TaskView[]> {
    const rows = await this.store.list(ownerRef.trim(), {
      ...filter,
      ...(filter.status === undefined || isKnownStatus(filter.status) ? {} : { status: undefined }),
    });
    return rows.map((row) => this.toView(row));
  }

  async transition(
    ownerRef: string,
    taskId: string,
    input: {
      readonly to: TaskStatus;
      readonly actor?: TaskActor;
      readonly message?: string | null;
      readonly expectedVersion?: number;
    },
  ): Promise<TaskView> {
    const actor = input.actor ?? 'primary_agent';
    const stored = await this.requireTask(ownerRef, taskId);
    const task = this.checkVersion(stored.task, input.expectedVersion);
    if (!isKnownStatus(input.to)) {
      throw new OrchestrationError('TASK_TRANSITION_INVALID', 'That is not a task status.');
    }
    assertTransition(task.status, input.to);
    if (transitionIsGuarded(task.status, input.to)) {
      throw new OrchestrationError(
        'TASK_TRANSITION_INVALID',
        input.to === 'queued'
          ? 'A failed task is retried through the retry action.'
          : 'A task is completed through a review decision, not a status change.',
      );
    }
    if (actor === 'worker' && input.to === 'completed') {
      throw new OrchestrationError(
        'TASK_TRANSITION_INVALID',
        'A worker cannot complete a task. Only the primary agent completes after review.',
      );
    }
    const message =
      input.message === undefined || input.message === null
        ? null
        : this.guardText(
            cleanText(input.message, 'message', TASK_LIMITS.maxSummaryLength),
            'message',
          );

    const at = this.now().toISOString();
    const next: TaskRecord = {
      ...task,
      status: input.to,
      version: task.version + 1,
      eventSeq: task.eventSeq + 1,
      updatedAt: at,
      ...(input.to === 'completed' ? { completedAt: at } : {}),
      ...(input.to === 'cancelled' ? { cancelledAt: at } : {}),
    };
    await this.save(next, task.version, [
      this.event(taskId, task.eventSeq + 1, 'status_changed', actor, {
        fromStatus: task.status,
        toStatus: input.to,
        message,
      }),
    ]);
    return this.getTask(ownerRef, taskId);
  }

  async setAssignment(ownerRef: string, taskId: string, value: unknown): Promise<TaskView> {
    const stored = await this.requireTask(ownerRef, taskId);
    const task = stored.task;
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new OrchestrationError('TASK_TRANSITION_INVALID', 'That task is finished.');
    }
    const assignment = validateAssignment(value);
    this.guardText(assignment.objective, 'assignment objective');
    if (assignment.scope.projectId !== null && assignment.scope.projectId !== task.projectId) {
      throw new OrchestrationError(
        'ASSIGNMENT_INVALID',
        'An assignment cannot point at a different project than its task.',
      );
    }
    const at = this.now().toISOString();
    const next: TaskRecord = {
      ...task,
      assignment,
      version: task.version + 1,
      eventSeq: task.eventSeq + 1,
      updatedAt: at,
    };
    await this.save(next, task.version, [
      this.event(taskId, task.eventSeq + 1, 'assignment_set', 'primary_agent', {
        message: `Assignment set for ${assignment.worker}`,
        detail: {
          worker: assignment.worker,
          outputs: assignment.expectedOutputs.length,
          criteria: assignment.acceptance.length,
          tools: assignment.allowedTools.length,
        },
      }),
    ]);
    return this.getTask(ownerRef, taskId);
  }

  async addDependency(
    ownerRef: string,
    taskId: string,
    dependsOnTaskId: string,
    options: { readonly required?: boolean } = {},
  ): Promise<TaskView> {
    const stored = await this.requireTask(ownerRef, taskId);
    if (dependsOnTaskId === taskId) {
      throw new OrchestrationError('TASK_DEPENDENCY_INVALID', 'A task cannot depend on itself.');
    }
    const target = await this.store.read(ownerRef.trim(), dependsOnTaskId);
    if (target === null || target.task.projectId !== stored.task.projectId) {
      throw new OrchestrationError(
        'TASK_DEPENDENCY_INVALID',
        'A dependency must be an existing task in the same project.',
      );
    }
    if (stored.dependencies.includes(dependsOnTaskId)) return this.toView(stored);
    if (stored.dependencies.length >= TASK_LIMITS.maxDependencies) {
      throw new OrchestrationError('TASK_DEPENDENCY_LIMIT');
    }
    await this.assertNoCycle(ownerRef.trim(), taskId, dependsOnTaskId);

    const at = this.now().toISOString();
    await this.store.addDependency({
      ownerRef: ownerRef.trim(),
      taskId,
      dependsOnTaskId,
      required: options.required ?? true,
      updatedAt: at,
      events: [
        this.event(taskId, stored.task.eventSeq + 1, 'dependency_added', 'primary_agent', {
          message: `Depends on ${dependsOnTaskId}`,
          detail: { dependsOnTaskId, required: options.required ?? true },
        }),
      ],
    });
    return this.getTask(ownerRef, taskId);
  }

  async removeDependency(
    ownerRef: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<TaskView> {
    const stored = await this.requireTask(ownerRef, taskId);
    if (!stored.dependencies.includes(dependsOnTaskId)) return this.toView(stored);
    await this.store.removeDependency({
      ownerRef: ownerRef.trim(),
      taskId,
      dependsOnTaskId,
      updatedAt: this.now().toISOString(),
      events: [
        this.event(taskId, stored.task.eventSeq + 1, 'dependency_removed', 'primary_agent', {
          message: `No longer depends on ${dependsOnTaskId}`,
          detail: { dependsOnTaskId },
        }),
      ],
    });
    return this.getTask(ownerRef, taskId);
  }

  async recordProgress(ownerRef: string, taskId: string, progress: TaskProgress): Promise<void> {
    const stored = await this.requireTask(ownerRef, taskId);
    const step = this.guardText(cleanText(progress.step, 'step', 200), 'step');
    const message =
      progress.message === null || progress.message === undefined
        ? null
        : this.guardText(cleanText(progress.message, 'message', 500), 'message');
    const percent =
      progress.percent === null || progress.percent === undefined
        ? null
        : Math.max(0, Math.min(100, Math.round(progress.percent)));

    await this.store.appendEvents({
      ownerRef: ownerRef.trim(),
      taskId,
      updatedAt: this.now().toISOString(),
      events: [
        this.event(taskId, stored.task.eventSeq + 1, 'progress', 'worker', {
          message: step,
          detail: { step, message, percent },
        }),
      ],
    });
  }

  async linkCheckpoint(
    ownerRef: string,
    taskId: string,
    checkpoint: CheckpointReference,
  ): Promise<TaskView> {
    const stored = await this.requireTask(ownerRef, taskId);
    const task = stored.task;
    if (checkpoint.id.trim().length === 0) {
      throw new OrchestrationError('TASK_INVALID', 'A checkpoint reference needs an id.');
    }
    if (!['revision', 'snapshot', 'manual'].includes(checkpoint.kind)) {
      throw new OrchestrationError('TASK_INVALID', 'That checkpoint kind is not known.');
    }
    const next: TaskRecord = {
      ...task,
      checkpoint: {
        kind: checkpoint.kind,
        id: checkpoint.id.slice(0, 128),
        note:
          checkpoint.note === null
            ? null
            : this.guardText(cleanText(checkpoint.note, 'note', 500), 'note'),
      },
      version: task.version + 1,
      eventSeq: task.eventSeq + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.save(next, task.version, [
      this.event(taskId, task.eventSeq + 1, 'checkpoint_linked', 'primary_agent', {
        message: `Checkpoint ${checkpoint.kind} linked`,
        detail: { checkpointId: checkpoint.id },
      }),
    ]);
    return this.getTask(ownerRef, taskId);
  }

  /** Records that an attempt has begun. The run id identifies the attempt. */
  async startAttempt(
    ownerRef: string,
    taskId: string,
    input: { readonly runId?: string | null; readonly worker?: string } = {},
  ): Promise<TaskAttempt> {
    const stored = await this.requireTask(ownerRef, taskId);
    const task = stored.task;
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new OrchestrationError('TASK_TRANSITION_INVALID', 'That task is finished.');
    }
    if (task.status !== 'running' && task.status !== 'assigned') {
      assertTransition(task.status, 'running');
    }
    const attemptNumber = task.retry.attempts + 1;
    if (attemptNumber > task.retry.maxAttempts) {
      throw new OrchestrationError(
        'TASK_RETRY_REFUSED',
        'This task has used every attempt it was allowed.',
      );
    }
    const at = this.now().toISOString();
    const attempt: TaskAttempt = {
      taskId,
      attempt: attemptNumber,
      runId: input.runId ?? null,
      worker: input.worker ?? 'primary_agent',
      status: 'running',
      startedAt: at,
      endedAt: null,
      summary: null,
      failure: null,
    };
    const next: TaskRecord = {
      ...task,
      status: 'running',
      retry: { ...task.retry, attempts: attemptNumber },
      version: task.version + 1,
      eventSeq: task.eventSeq + 1,
      updatedAt: at,
    };
    const save = await this.store.save({
      task: next,
      expectedVersion: task.version,
      events: [
        this.event(taskId, task.eventSeq + 1, 'attempt_started', 'primary_agent', {
          fromStatus: task.status,
          toStatus: 'running',
          message: `Attempt ${attemptNumber} started`,
          detail: { attempt: attemptNumber, runId: attempt.runId, worker: attempt.worker },
        }),
      ],
    });
    if (!save) throw new OrchestrationError('TASK_VERSION_CONFLICT');
    await this.store.saveAttempt({ ownerRef: ownerRef.trim(), attempt });
    return attempt;
  }

  /**
   * Records what an attempt produced and lets the primary agent's own rule judge
   * it. Nothing here completes a task: a judged result waits for review.
   */
  async finishAttempt(
    ownerRef: string,
    taskId: string,
    input: {
      readonly attempt: number;
      readonly summary: string;
      readonly evidence: CompletionEvidence;
      readonly expectedVersion?: number;
    },
  ): Promise<TaskView> {
    const stored = await this.requireTask(ownerRef, taskId);
    const task = this.checkVersion(stored.task, input.expectedVersion);
    const summary = this.guardText(
      cleanText(input.summary, 'summary', TASK_LIMITS.maxSummaryLength),
      'summary',
    );
    const at = this.now().toISOString();
    const attempts = await this.store.attempts(ownerRef.trim(), taskId);
    const current = attempts.find((entry) => entry.attempt === input.attempt);
    if (current === undefined || current.endedAt !== null) {
      throw new OrchestrationError('TASK_INVALID', 'That attempt is not open.');
    }

    const assessment =
      task.assignment === null ? null : assessCompletion(task.assignment, input.evidence);

    let status: TaskStatus;
    let failure: FailureSummary | null = null;
    let result: TaskResult | null = null;
    if (input.evidence.failure !== undefined && input.evidence.failure !== null) {
      status = 'failed';
      failure = {
        code: input.evidence.failure.code.slice(0, 64),
        message: input.evidence.failure.message.slice(0, 500),
        retryable: task.retry.attempts < task.retry.maxAttempts,
      };
    } else if (assessment !== null && assessment.verdict === 'blocked') {
      status = 'blocked';
    } else {
      status = 'awaiting_review';
      result = { summary, outputs: [...input.evidence.outputs], finishedAt: at };
    }
    assertTransition(task.status, status);

    const next: TaskRecord = {
      ...task,
      status,
      result,
      failure,
      reviewStatus: status === 'awaiting_review' ? 'pending' : task.reviewStatus,
      retry: failure === null ? task.retry : { ...task.retry, lastFailure: failure },
      version: task.version + 1,
      eventSeq: task.eventSeq + 2,
      updatedAt: at,
    };
    const save = await this.store.save({
      task: next,
      expectedVersion: task.version,
      events: [
        this.event(taskId, task.eventSeq + 1, 'attempt_finished', 'worker', {
          fromStatus: task.status,
          toStatus: status,
          message: summary,
          detail: {
            attempt: input.attempt,
            verdict: assessment?.verdict ?? 'unassigned',
            missingOutputs: assessment?.missingOutputs ?? [],
            unmetCriteria: assessment?.unmetCriteria ?? [],
            unverifiedCriteria: assessment?.unverifiedCriteria ?? [],
          },
        }),
        this.event(taskId, task.eventSeq + 2, 'status_changed', 'primary_agent', {
          fromStatus: task.status,
          toStatus: status,
          message: null,
        }),
      ],
    });
    if (!save) throw new OrchestrationError('TASK_VERSION_CONFLICT');
    await this.store.saveAttempt({
      ownerRef: ownerRef.trim(),
      attempt: {
        ...current,
        status: status === 'failed' ? 'failed' : 'completed',
        endedAt: at,
        summary,
        failure,
      },
    });
    return this.getTask(ownerRef, taskId);
  }

  async review(
    ownerRef: string,
    taskId: string,
    input: {
      readonly decision: 'accept' | 'reject';
      readonly summary: string;
      readonly expectedVersion?: number;
    },
  ): Promise<TaskView> {
    const stored = await this.requireTask(ownerRef, taskId);
    const task = this.checkVersion(stored.task, input.expectedVersion);
    if (task.status !== 'awaiting_review') {
      throw new OrchestrationError(
        'TASK_REVIEW_INVALID',
        'Only a task awaiting review is accepted or sent back.',
      );
    }
    const summary = this.guardText(
      cleanText(input.summary, 'summary', TASK_LIMITS.maxSummaryLength),
      'summary',
    );
    const at = this.now().toISOString();
    const accepted = input.decision === 'accept';
    const next: TaskRecord = {
      ...task,
      status: accepted ? 'completed' : 'running',
      reviewStatus: accepted ? 'accepted' : 'rejected',
      version: task.version + 1,
      eventSeq: task.eventSeq + 2,
      updatedAt: at,
      ...(accepted ? { completedAt: at } : {}),
    };
    const save = await this.store.save({
      task: next,
      expectedVersion: task.version,
      events: [
        this.event(taskId, task.eventSeq + 1, 'review_recorded', 'primary_agent', {
          message: summary,
          detail: { decision: input.decision },
        }),
        this.event(taskId, task.eventSeq + 2, 'status_changed', 'primary_agent', {
          fromStatus: 'awaiting_review',
          toStatus: accepted ? 'completed' : 'running',
          message: null,
        }),
      ],
    });
    if (!save) throw new OrchestrationError('TASK_VERSION_CONFLICT');
    return this.getTask(ownerRef, taskId);
  }

  async cancel(ownerRef: string, taskId: string, reason: string): Promise<TaskView> {
    const stored = await this.requireTask(ownerRef, taskId);
    const task = stored.task;
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new OrchestrationError('TASK_TRANSITION_INVALID', 'That task is already finished.');
    }
    const message = this.guardText(cleanText(reason, 'reason', 500), 'reason');
    const at = this.now().toISOString();
    const next: TaskRecord = {
      ...task,
      status: 'cancelled',
      version: task.version + 1,
      eventSeq: task.eventSeq + 2,
      updatedAt: at,
      cancelledAt: at,
    };
    await this.save(next, task.version, [
      this.event(taskId, task.eventSeq + 1, 'cancelled', 'primary_agent', {
        fromStatus: task.status,
        toStatus: 'cancelled',
        message,
      }),
      this.event(taskId, task.eventSeq + 2, 'status_changed', 'primary_agent', {
        fromStatus: task.status,
        toStatus: 'cancelled',
        message: null,
      }),
    ]);
    return this.getTask(ownerRef, taskId);
  }

  async retry(ownerRef: string, taskId: string, reason: string): Promise<TaskView> {
    const stored = await this.requireTask(ownerRef, taskId);
    const task = stored.task;
    if (task.status !== 'failed' && task.status !== 'partially_completed') {
      throw new OrchestrationError(
        'TASK_RETRY_REFUSED',
        'Only a failed or partially completed task is retried.',
      );
    }
    if (task.retry.attempts >= task.retry.maxAttempts) {
      throw new OrchestrationError(
        'TASK_RETRY_REFUSED',
        'This task has used every attempt it was allowed.',
      );
    }
    const message = this.guardText(cleanText(reason, 'reason', 500), 'reason');
    const at = this.now().toISOString();
    const next: TaskRecord = {
      ...task,
      status: 'queued',
      reviewStatus: null,
      version: task.version + 1,
      eventSeq: task.eventSeq + 2,
      updatedAt: at,
      retry: { ...task.retry, lastRetriedAt: at },
    };
    await this.save(next, task.version, [
      this.event(taskId, task.eventSeq + 1, 'retry_scheduled', 'primary_agent', {
        fromStatus: task.status,
        toStatus: 'queued',
        message,
        detail: { attempts: task.retry.attempts, maxAttempts: task.retry.maxAttempts },
      }),
      this.event(taskId, task.eventSeq + 2, 'status_changed', 'primary_agent', {
        fromStatus: task.status,
        toStatus: 'queued',
        message: null,
      }),
    ]);
    return this.getTask(ownerRef, taskId);
  }

  async events(
    ownerRef: string,
    taskId: string,
    options: { readonly after?: number; readonly limit?: number } = {},
  ): Promise<readonly TaskEvent[]> {
    await this.requireTask(ownerRef, taskId);
    const limit = Math.min(
      TASK_LIMITS.maxEventsPerRead,
      Math.max(1, options.limit ?? TASK_LIMITS.maxEventsPerRead),
    );
    return this.store.events(ownerRef.trim(), taskId, options.after ?? 0, limit);
  }

  async attempts(ownerRef: string, taskId: string): Promise<readonly TaskAttempt[]> {
    await this.requireTask(ownerRef, taskId);
    return this.store.attempts(ownerRef.trim(), taskId);
  }

  private async requireTask(ownerRef: string, taskId: string): Promise<StoredTask> {
    const owner = ownerRef.trim();
    if (owner.length === 0) throw new OrchestrationError('TASK_INVALID', 'A task needs an owner.');
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 128) {
      throw new OrchestrationError('TASK_NOT_FOUND');
    }
    const stored = await this.store.read(owner, taskId);
    // Another owner's task and a task that never existed answer the same.
    if (stored === null || stored.task.ownerRef !== owner) {
      throw new OrchestrationError('TASK_NOT_FOUND');
    }
    return stored;
  }

  private checkVersion(task: TaskRecord, expected: number | undefined): TaskRecord {
    if (expected !== undefined && expected !== task.version) {
      throw new OrchestrationError('TASK_VERSION_CONFLICT');
    }
    return task;
  }

  private async save(
    task: TaskRecord,
    expectedVersion: number,
    events: readonly TaskEvent[],
  ): Promise<void> {
    const saved = await this.store.save({ task, expectedVersion, events });
    if (!saved) throw new OrchestrationError('TASK_VERSION_CONFLICT');
  }

  private async assertNoCycle(
    ownerRef: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<void> {
    const seen = new Set<string>();
    const queue = [dependsOnTaskId];
    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === taskId) {
        throw new OrchestrationError(
          'TASK_DEPENDENCY_CYCLE',
          'That dependency would create a loop.',
        );
      }
      if (seen.has(current)) continue;
      seen.add(current);
      visited += 1;
      if (visited > TASK_LIMITS.maxDependencyChain) {
        throw new OrchestrationError(
          'TASK_DEPENDENCY_LIMIT',
          'The dependency chain is too long to inspect safely.',
        );
      }
      const stored = await this.store.read(ownerRef, current);
      if (stored !== null) queue.push(...stored.dependencies);
    }
  }

  private toView(stored: StoredTask): TaskView {
    const { task } = stored;
    return {
      id: task.id,
      ownerRef: task.ownerRef,
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      chatId: task.chatId,
      parentTaskId: task.parentTaskId,
      title: task.title,
      objective: task.objective,
      status: task.status,
      reviewStatus: task.reviewStatus,
      assignment: task.assignment,
      acceptance: task.assignment?.acceptance ?? [],
      dependencies: [...stored.dependencies],
      result: task.result,
      failure: task.failure,
      retry: task.retry,
      checkpoint: task.checkpoint,
      version: task.version,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      cancelledAt: task.cancelledAt,
    };
  }
}

/** Role markers used to keep model-facing text from looking like instructions. */
function forbiddenKeys(text: string): void {
  // Nothing to strip: task text is data the primary agent wrote. The check
  // below exists so an accidental role prefix cannot pass as a system turn.
  if (/^\s*(system|assistant)\s*:/i.test(text)) {
    throw new OrchestrationError('TASK_INVALID', 'Task text cannot start with a role prefix.');
  }
}

function randomId(): string {
  // 8 chars of entropy is enough to avoid a collision inside one owner's list;
  // the store's primary key is the real guarantee.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let index = 0; index < 12; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
