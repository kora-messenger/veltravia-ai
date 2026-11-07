/**
 * Running a bounded worker.
 *
 * What this class guarantees:
 *  - a worker is created only against an assignment that validates, on a task
 *    the caller owns, with no other active worker on that task and no
 *    conflicting claim on its paths;
 *  - the task's own attempt record is opened and closed by the Step 42 task
 *    manager, so attempts and retries have one source of truth;
 *  - the execution is cancelled on timeout, and the abort is cooperative: an
 *    executor that ignores it is still stopped from being awaited forever;
 *  - a worker can never complete its own work. `review` is the only door to
 *    `completed`, and it runs the checks in review.ts before the task manager is
 *    asked to accept the task.
 *
 * What it does NOT guarantee: that the executor is doing real work. The
 * executor is a port; the shipped one is a simulation and says so on every
 * result it produces.
 */

import { TaskManager, containsSecretShaped, type TaskView } from '@veltravia/orchestration-core';

import { claimsFor, validateAssignment, workerTypeOf } from './assignment.js';
import { fromOrchestrationError, WorkerError } from './errors.js';
import {
  assertWorkerTransition,
  isActiveWorkerStatus,
  isTerminalWorkerStatus,
} from './lifecycle.js';
import { findConflict } from './resources.js';
import { reviewWorkerResult } from './review.js';
import type { WorkerStore } from './store.js';
import type {
  ResourceClaim,
  ReviewCheck,
  WorkerAssignment,
  WorkerEvent,
  WorkerEventType,
  WorkerRecord,
  WorkerResult,
  WorkerStatus,
  WorkerType,
} from './types.js';
import { WORKER_LIMITS } from './types.js';

export interface WorkerExecutorInput {
  readonly workerId: string;
  readonly ownerRef: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly workerType: WorkerType;
  readonly assignment: WorkerAssignment;
  readonly signal: AbortSignal;
  readonly report: (event: { readonly message: string; readonly percent?: number }) => void;
}

export interface WorkerExecution {
  readonly outcome: 'completed' | 'partial' | 'blocked' | 'failed';
  readonly summary: string;
  readonly deliverables: WorkerResult['deliverables'];
  readonly evidence: WorkerResult['evidence'];
  readonly notes?: string | null;
  readonly blockedReason?: string | null;
  readonly failure?: { readonly code: string; readonly message: string } | null;
  /** What the execution cost, when a model ran. */
  readonly usage?: WorkerResult['usage'];
}

export interface WorkerExecutor {
  /** False only for an executor that really performs the assigned work. */
  readonly simulated: boolean;
  run(input: WorkerExecutorInput): Promise<WorkerExecution>;
}

export interface WorkerManagerOptions {
  readonly workers: WorkerStore;
  readonly tasks: TaskManager;
  readonly executor: WorkerExecutor;
  /** Tool names this deployment offers; an assignment may only name these. */
  readonly toolCatalog: readonly string[];
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly looksLikeSecret?: (text: string) => boolean;
  /** Ceiling for a single execution when the assignment asks for more. */
  readonly maxDurationMs?: number;
  readonly stallAfterMs?: number;
}

export interface DelegateInput {
  readonly taskId: string;
  readonly workerType: string;
  readonly assignment: unknown;
  readonly parentTaskId?: string | null;
}

export interface WorkerProgressReport {
  readonly taskId: string;
  readonly taskStatus: string;
  readonly active: readonly {
    readonly workerId: string;
    readonly workerType: WorkerType;
    readonly status: WorkerStatus;
    readonly objective: string;
    readonly claims: readonly string[];
    readonly startedAt: string | null;
  }[];
  readonly deliverables: readonly {
    readonly workerId: string;
    readonly name: string;
    readonly path: string | null;
  }[];
  readonly blocked: readonly { readonly workerId: string; readonly reason: string }[];
  readonly failedAttempts: readonly {
    readonly workerId: string;
    readonly code: string;
    readonly at: string;
  }[];
  readonly awaitingReview: readonly string[];
  readonly reviewStatus: string | null;
}

interface RunningHandle {
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  timedOut: boolean;
  cancelled: boolean;
}

export class WorkerManager {
  private readonly workers: WorkerStore;
  private readonly tasks: TaskManager;
  private readonly executor: WorkerExecutor;
  private readonly toolCatalog: readonly string[];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly looksLikeSecret: (text: string) => boolean;
  private readonly maxDurationMs: number;
  private readonly stallAfterMs: number;
  /** True when the attached executor only pretends to do the work. */
  readonly simulated: boolean;
  /** Live executions in THIS process. Other instances cannot see these. */
  private readonly handles = new Map<string, RunningHandle>();
  /** Workers a cancel has claimed, whether or not an executor is attached yet. */
  private readonly cancelling = new Set<string>();

  constructor(options: WorkerManagerOptions) {
    this.workers = options.workers;
    this.tasks = options.tasks;
    this.executor = options.executor;
    this.toolCatalog = options.toolCatalog;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `wkr_${Math.random().toString(36).slice(2, 12)}`);
    this.looksLikeSecret = options.looksLikeSecret ?? containsSecretShaped;
    this.maxDurationMs = options.maxDurationMs ?? WORKER_LIMITS.maxDurationMs;
    this.stallAfterMs = options.stallAfterMs ?? WORKER_LIMITS.stallAfterMs;
    this.simulated = this.executor.simulated;
  }

  private event(
    workerId: string,
    seq: number,
    type: WorkerEventType,
    actor: WorkerEvent['actor'],
    fields: {
      readonly fromStatus?: WorkerStatus | null;
      readonly toStatus?: WorkerStatus | null;
      readonly message?: string | null;
      readonly detail?: Record<string, unknown>;
    } = {},
  ): WorkerEvent {
    return {
      workerId,
      seq,
      type,
      actor,
      at: this.now().toISOString(),
      fromStatus: fields.fromStatus ?? null,
      toStatus: fields.toStatus ?? null,
      message: fields.message ?? null,
      ...(fields.detail === undefined ? {} : { detail: fields.detail }),
    };
  }

  async get(ownerRef: string, workerId: string): Promise<WorkerRecord> {
    const worker = await this.workers.read(ownerRef.trim(), workerId);
    if (worker === null) throw new WorkerError('WORKER_NOT_FOUND');
    return worker;
  }

  async list(
    ownerRef: string,
    filter: {
      readonly taskId?: string;
      readonly status?: readonly WorkerStatus[];
      readonly activeOnly?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<readonly WorkerRecord[]> {
    return this.workers.list(ownerRef.trim(), filter);
  }

  events(
    ownerRef: string,
    workerId: string,
    afterSeq = 0,
    limit = 100,
  ): Promise<readonly WorkerEvent[]> {
    return this.workers.events(ownerRef.trim(), workerId, afterSeq, limit);
  }

  decisions(ownerRef: string, limit = 20) {
    return this.workers.decisions(ownerRef.trim(), limit);
  }

  /**
   * Creates a bounded worker for a task.
   *
   * The task must exist for this owner, be open, and have no active worker. The
   * assignment must validate, and its claims must not conflict with anything
   * already running.
   */
  async delegate(ownerRef: string, input: DelegateInput): Promise<WorkerRecord> {
    const owner = ownerRef.trim();
    const task: TaskView = await this.tasks.getTask(owner, input.taskId).catch((error: unknown) => {
      // Another owner's task is reported exactly like a missing one.
      throw fromOrchestrationError(error) ?? error;
    });
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new WorkerError('WORKER_TRANSITION_INVALID', 'That task is already finished.');
    }
    const workerType = workerTypeOf(input.workerType);
    const assignment = validateAssignment(input.assignment, {
      allowedTools: this.toolCatalog,
      looksLikeSecret: this.looksLikeSecret,
    });
    const claims = claimsFor(assignment);

    const active = await this.workers.list(owner, { activeOnly: true });
    if (active.some((worker: WorkerRecord) => worker.taskId === task.id)) {
      throw new WorkerError('WORKER_DUPLICATE_ASSIGNMENT', undefined, { taskId: task.id });
    }
    const conflict = findConflict(
      claims,
      active.map((worker: WorkerRecord) => ({ workerId: worker.id, claims: worker.resources })),
    );
    if (conflict !== null) {
      throw new WorkerError(
        'WORKER_RESOURCE_CONFLICT',
        `${conflict.workerId} already holds ${conflict.claim.path}.`,
        { workerId: conflict.workerId, path: conflict.claim.path },
      );
    }

    const at = this.now().toISOString();
    const worker: WorkerRecord = {
      id: this.newId(),
      ownerRef: owner,
      taskId: task.id,
      parentTaskId: input.parentTaskId ?? task.parentTaskId,
      primaryRunId: assignment.primaryRunId,
      workerType,
      status: 'queued',
      assignment,
      resources: claims,
      result: null,
      review: null,
      failure: null,
      attempts: 0,
      retryNotBefore: null,
      startedAt: null,
      endedAt: null,
      lastHeartbeatAt: null,
      createdAt: at,
      updatedAt: at,
      version: 1,
      eventSeq: 1,
    };
    await this.workers.insert(worker, [
      this.event(worker.id, 1, 'created', 'primary_agent', {
        toStatus: 'queued',
        message: 'Worker created',
        detail: { taskId: task.id, workerType, claims: claims.map((claim) => claim.path) },
      }),
    ]);
    await this.tasks.recordProgress(owner, task.id, {
      step: 'delegation',
      message: `${workerType} worker ${worker.id} created`,
      percent: 0,
    });
    return worker;
  }

  /**
   * Runs a queued worker to a verdict.
   *
   * Never throws for an executor failure: a crash, a timeout and a refusal all
   * end in a recorded state the Primary Agent can act on.
   */
  async start(ownerRef: string, workerId: string): Promise<WorkerRecord> {
    const owner = ownerRef.trim();
    let worker = await this.get(owner, workerId);
    if (this.handles.has(worker.id)) {
      throw new WorkerError('WORKER_DUPLICATE_ASSIGNMENT', 'That worker is already running here.');
    }
    if (worker.status === 'blocked') {
      worker = await this.move(owner, worker, 'starting', 'primary_agent', 'Resuming blocked work');
    } else if (worker.status === 'queued') {
      worker = await this.move(owner, worker, 'assigned', 'primary_agent', 'Assigned');
      worker = await this.move(owner, worker, 'starting', 'primary_agent', 'Starting');
    } else if (worker.status !== 'assigned') {
      throw new WorkerError(
        'WORKER_TRANSITION_INVALID',
        `A worker in ${worker.status} cannot be started.`,
      );
    }

    // Read once so a finished task is refused before an attempt is opened.
    const task = await this.tasks.getTask(owner, worker.taskId);
    const attempt = await this.tasks.startAttempt(owner, worker.taskId, {
      runId: worker.id,
      worker: worker.workerType,
    });

    const startedAt = this.now().toISOString();
    const duration = Math.min(worker.assignment.limits.maxDurationMs, this.maxDurationMs);
    const controller = new AbortController();
    // The flag lives outside the handle map so it survives the cleanup below.
    const timeoutFlag = { hit: false };
    const timer = setTimeout(() => {
      timeoutFlag.hit = true;
      controller.abort();
    }, duration);
    const handle: RunningHandle = { controller, timer, timedOut: false, cancelled: false };
    this.handles.set(worker.id, handle);

    if (this.cancelling.has(worker.id)) {
      // Cancelled between the attempt opening and the run starting.
      if (timer !== undefined) clearTimeout(timer);
      this.handles.delete(worker.id);
      return this.markCancelled(owner, worker.id, 'Cancelled before it started');
    }

    worker = await this.save(
      owner,
      {
        ...worker,
        status: 'running',
        attempts: attempt.attempt,
        startedAt: worker.startedAt ?? startedAt,
        lastHeartbeatAt: startedAt,
        updatedAt: startedAt,
      },
      'status_changed',
      'worker',
      {
        fromStatus: worker.status,
        toStatus: 'running',
        message: `Attempt ${attempt.attempt} started`,
        detail: { attempt: attempt.attempt, durationMs: duration },
      },
    );

    // The executor is raced against the timer: an executor that ignores the
    // abort signal must not be able to hold the worker open forever.
    const timedOutPromise = new Promise<null>((resolve) => {
      const wait = setInterval(() => {
        if (timeoutFlag.hit) {
          clearInterval(wait);
          resolve(null);
        }
      }, 10);
      wait.unref?.();
    });

    let execution: WorkerExecution | null = null;
    let crash: WorkerError | null;
    try {
      execution = await Promise.race([
        this.executor.run({
          workerId: worker.id,
          ownerRef: owner,
          taskId: worker.taskId,
          projectId: task?.projectId ?? null,
          workerType: worker.workerType,
          assignment: worker.assignment,
          signal: controller.signal,
          report: (event) => {
            void this.reportProgress(owner, worker.id, event.message, event.percent);
          },
        }),
        timedOutPromise,
      ]);
    } catch (error) {
      crash = error instanceof WorkerError ? error : null;
      if (crash === null) {
        void error;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.handles.delete(worker.id);
    }

    const timedOut = timeoutFlag.hit || controller.signal.reason === 'timeout';
    const current = await this.get(owner, worker.id);
    if (handle.cancelled || this.cancelling.has(worker.id)) {
      // Cancelled while it ran. Whichever path gets here first writes it, and
      // the write is idempotent, so the record cannot end up as a timeout.
      return this.markCancelled(owner, current.id, 'Cancelled while it ran');
    }
    if (isTerminalWorkerStatus(current.status)) {
      // Something else already finished this worker; leave its record alone.
      return current;
    }
    if (timedOut || controller.signal.aborted) {
      return this.failWorker(owner, current, attempt.attempt, {
        status: 'timed_out',
        failure: {
          code: 'WORKER_TIMEOUT',
          message: 'The worker exceeded its time budget and was stopped.',
          retryable: true,
        },
      });
    }
    if (execution === null) {
      return this.failWorker(owner, current, attempt.attempt, {
        status: 'failed',
        failure: {
          code: 'WORKER_CRASHED',
          message: 'The worker ended without producing a result.',
          retryable: true,
        },
      });
    }

    const finishedAt = this.now().toISOString();
    const result: WorkerResult = {
      summary: execution.summary.slice(0, 800),
      deliverables: execution.deliverables,
      evidence: execution.evidence,
      notes: execution.notes ?? null,
      finishedAt,
      simulated: this.executor.simulated,
      ...(execution.usage === undefined || execution.usage === null
        ? {}
        : { usage: execution.usage }),
    };
    const status: WorkerStatus =
      execution.outcome === 'completed' || execution.outcome === 'partial'
        ? 'awaiting_review'
        : execution.outcome === 'blocked'
          ? 'blocked'
          : 'failed';
    const failure =
      execution.failure === undefined || execution.failure === null
        ? null
        : {
            code: execution.failure.code.slice(0, 64),
            message: execution.failure.message.slice(0, 300),
            retryable: current.attempts < WORKER_LIMITS.maxAttempts,
            at: finishedAt,
          };

    try {
      await this.tasks.finishAttempt(owner, worker.taskId, {
        attempt: attempt.attempt,
        summary: result.summary,
        evidence: {
          outputs: result.deliverables.map((deliverable) => deliverable.name),
          acceptance: [],
          ...(execution.blockedReason === undefined
            ? {}
            : { blockedReason: execution.blockedReason }),
          ...(failure === null
            ? {}
            : { failure: { code: failure.code, message: failure.message } }),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'OrchestrationError') {
        // The task moved on (cancelled by the owner). Record it on the worker.
      } else {
        throw error;
      }
    }

    return this.saveTolerant(
      owner,
      {
        ...current,
        status,
        result,
        failure,
        endedAt: status === 'failed' ? finishedAt : null,
        updatedAt: finishedAt,
      },
      'status_changed',
      'worker',
      {
        fromStatus: current.status,
        toStatus: status,
        message: result.summary,
        detail: { outcome: execution.outcome, deliverables: result.deliverables.length },
      },
    );
  }

  /**
   * The Primary Agent's review.
   *
   * Only this method can complete a worker, and it completes the parent task
   * through the task manager's own review door.
   */
  async review(
    ownerRef: string,
    workerId: string,
    input: {
      readonly decision?: 'accept' | 'reject' | 'request_revision';
      readonly summary: string;
      readonly criteriaResults: readonly (boolean | null)[];
      readonly changedPaths?: readonly string[];
      readonly integratedPaths?: readonly string[];
    },
  ): Promise<{ readonly worker: WorkerRecord; readonly checks: readonly ReviewCheck[] }> {
    const owner = ownerRef.trim();
    const worker = await this.get(owner, workerId);
    if (worker.status !== 'awaiting_review') {
      throw new WorkerError(
        'WORKER_REVIEW_REFUSED',
        'Only a worker whose work is awaiting review can be reviewed.',
      );
    }
    if (this.looksLikeSecret(input.summary)) {
      throw new WorkerError('WORKER_SECRET_REJECTED');
    }
    const outcome = reviewWorkerResult(worker, {
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      summary: input.summary,
      criteriaResults: input.criteriaResults,
      ...(input.changedPaths === undefined ? {} : { changedPaths: input.changedPaths }),
      ...(input.integratedPaths === undefined ? {} : { integratedPaths: input.integratedPaths }),
    });
    // The caller asked to accept and the checks say no: refuse, and write
    // nothing. Silently turning the accept into a rejection would hide both.
    if (input.decision === 'accept' && outcome.decision !== 'accept') {
      throw new WorkerError(
        'WORKER_REVIEW_REFUSED',
        `The review found blocking problems: ${outcome.blockingFailures.join(', ')}.`,
      );
    }
    const at = this.now().toISOString();
    const accepted = outcome.decision === 'accept';

    if (accepted) {
      await this.tasks.review(owner, worker.taskId, {
        decision: 'accept',
        summary: input.summary.slice(0, 300),
      });
    } else {
      await this.tasks.review(owner, worker.taskId, {
        decision: 'reject',
        summary: input.summary.slice(0, 300),
      });
    }

    const updated = await this.save(
      owner,
      {
        ...worker,
        status: accepted ? 'completed' : 'failed',
        review: {
          decision: outcome.decision,
          reviewer: 'primary_agent',
          summary: input.summary.slice(0, 500),
          checks: outcome.checks,
          at,
        },
        failure: accepted
          ? worker.failure
          : {
              code: 'REVIEW_REJECTED',
              message: outcome.blockingFailures.join(', ').slice(0, 300) || 'rejected by review',
              retryable: worker.attempts < WORKER_LIMITS.maxAttempts,
              at,
            },
        endedAt: at,
        updatedAt: at,
      },
      'reviewed',
      'primary_agent',
      {
        fromStatus: worker.status,
        toStatus: accepted ? 'completed' : 'failed',
        message: outcome.decision,
        detail: {
          blocking: outcome.blockingFailures,
          checks: outcome.checks.map((entry) => ({ name: entry.name, passed: entry.passed })),
        },
      },
    );
    return { worker: updated, checks: outcome.checks };
  }

  /**
   * Writes the cancelled record once. Called by `cancel` and by a run that was
   * aborted mid-flight, so cancellation never loses a race with a timeout.
   */
  private async markCancelled(
    ownerRef: string,
    workerId: string,
    reason: string,
  ): Promise<WorkerRecord> {
    const fresh = await this.get(ownerRef, workerId);
    if (isTerminalWorkerStatus(fresh.status)) return fresh;
    const at = this.now().toISOString();
    return this.saveTolerant(
      ownerRef,
      { ...fresh, status: 'cancelled', endedAt: at, updatedAt: at },
      'cancelled',
      'primary_agent',
      { fromStatus: fresh.status, toStatus: 'cancelled', message: reason.slice(0, 300) },
    );
  }

  /** Cooperative cancellation. The executor is aborted; the record is final. */
  async cancel(ownerRef: string, workerId: string, reason: string): Promise<WorkerRecord> {
    const owner = ownerRef.trim();
    const worker = await this.get(owner, workerId);
    if (isTerminalWorkerStatus(worker.status)) {
      throw new WorkerError('WORKER_NOT_CANCELLABLE');
    }
    this.cancelling.add(worker.id);
    const handle = this.handles.get(worker.id);
    if (handle !== undefined) {
      handle.cancelled = true;
      handle.controller.abort();
      if (handle.timer !== undefined) clearTimeout(handle.timer);
      this.handles.delete(worker.id);
    }
    try {
      await this.tasks.cancel(owner, worker.taskId, reason.slice(0, 200));
    } catch {
      // The task may already be finished; cancelling the worker still stands.
    }
    return this.markCancelled(owner, worker.id, reason);
  }

  /**
   * Controlled retry with doubling backoff.
   *
   * Refused once the worker has used every attempt it was allowed, so nothing
   * here can spin.
   */
  async requeue(ownerRef: string, workerId: string, reason: string): Promise<WorkerRecord> {
    const owner = ownerRef.trim();
    const worker = await this.get(owner, workerId);
    if (worker.status !== 'failed' && worker.status !== 'timed_out') {
      throw new WorkerError(
        'WORKER_RETRY_REFUSED',
        'Only failed or timed-out work can be re-queued.',
      );
    }
    if (worker.attempts >= WORKER_LIMITS.maxAttempts) {
      throw new WorkerError('WORKER_RETRY_REFUSED');
    }
    const exponent = Math.max(0, worker.attempts - 1);
    const delay = Math.min(
      WORKER_LIMITS.retryBackoffMs * 2 ** exponent,
      WORKER_LIMITS.retryBackoffCeilingMs,
    );
    const notBefore = new Date(this.now().getTime() + delay).toISOString();
    const at = this.now().toISOString();
    try {
      // The task has to be re-queued too, or its own lifecycle refuses the next
      // attempt. The task manager owns that rule; this only asks it.
      await this.tasks.retry(owner, worker.taskId, reason.slice(0, 200));
    } catch {
      // Already queued, or out of attempts; the worker-side budget decides.
    }
    return this.save(
      owner,
      {
        ...worker,
        status: 'queued',
        retryNotBefore: notBefore,
        failure: null,
        result: null,
        endedAt: null,
        updatedAt: at,
      },
      'retried',
      'primary_agent',
      {
        fromStatus: worker.status,
        toStatus: 'queued',
        message: reason.slice(0, 300),
        detail: { retryNotBefore: notBefore, attempts: worker.attempts },
      },
    );
  }

  /**
   * Marks workers that stopped reporting as timed out.
   *
   * This is how a crashed process is noticed: the record says running, but no
   * heartbeat has arrived for longer than the stall window. It is a recovery
   * rule, not a guarantee that every crash is caught instantly.
   */
  async recoverStalled(
    ownerRef: string,
    options: { readonly force?: boolean } = {},
  ): Promise<readonly WorkerRecord[]> {
    const owner = ownerRef.trim();
    const active = await this.workers.list(owner, { activeOnly: true, limit: 300 });
    const now = this.now().getTime();
    const recovered: WorkerRecord[] = [];
    for (const worker of active) {
      if (worker.status !== 'running' && worker.status !== 'starting') continue;
      if (this.handles.has(worker.id) && options.force !== true) continue;
      const last = worker.lastHeartbeatAt ?? worker.startedAt ?? worker.updatedAt;
      const age = now - new Date(last).getTime();
      if (!options.force && age < this.stallAfterMs) continue;
      recovered.push(
        await this.failWorker(owner, worker, worker.attempts, {
          status: 'timed_out',
          failure: {
            code: 'WORKER_STALLED',
            message: 'The worker stopped reporting and was marked timed out.',
            retryable: worker.attempts < WORKER_LIMITS.maxAttempts,
          },
        }),
      );
    }
    return recovered;
  }

  /** Structured progress for the parent task, ready for a future screen. */
  async progressFor(ownerRef: string, taskId: string): Promise<WorkerProgressReport> {
    const owner = ownerRef.trim();
    const task = await this.tasks.getTask(owner, taskId);
    const workers = await this.workers.list(owner, { taskId });
    const active = workers.filter((worker: WorkerRecord) => isActiveWorkerStatus(worker.status));
    return {
      taskId: task.id,
      taskStatus: task.status,
      active: active.map((worker: WorkerRecord) => ({
        workerId: worker.id,
        workerType: worker.workerType,
        status: worker.status,
        objective: worker.assignment.objective,
        claims: worker.resources.map((claim: ResourceClaim) => claim.path),
        startedAt: worker.startedAt,
      })),
      deliverables: workers.flatMap((worker: WorkerRecord) =>
        (worker.result?.deliverables ?? []).map((deliverable) => ({
          workerId: worker.id,
          name: deliverable.name,
          path: deliverable.path,
        })),
      ),
      blocked: workers
        .filter((worker: WorkerRecord) => worker.status === 'blocked')
        .map((worker: WorkerRecord) => ({
          workerId: worker.id,
          reason: worker.result?.notes ?? 'blocked without a stated reason',
        })),
      failedAttempts: workers
        .filter((worker: WorkerRecord) => worker.failure !== null)
        .map((worker: WorkerRecord) => ({
          workerId: worker.id,
          code: worker.failure?.code ?? 'unknown',
          at: worker.failure?.at ?? worker.updatedAt,
        })),
      awaitingReview: workers
        .filter((worker: WorkerRecord) => worker.status === 'awaiting_review')
        .map((worker: WorkerRecord) => worker.id),
      reviewStatus: task.reviewStatus,
    };
  }

  private async reportProgress(
    ownerRef: string,
    workerId: string,
    message: string,
    percent?: number,
  ): Promise<void> {
    if (this.looksLikeSecret(message)) return;
    try {
      const worker = await this.get(ownerRef, workerId);
      await this.workers.appendEvents(
        ownerRef,
        workerId,
        [
          this.event(workerId, worker.eventSeq + 1, 'progress', 'worker', {
            toStatus: null,
            message: message.slice(0, 200),
            detail: percent === undefined ? {} : { percent },
          }),
        ],
        this.now().toISOString(),
      );
    } catch {
      // Progress is best-effort by design; losing one line never fails a run.
    }
  }

  private async failWorker(
    ownerRef: string,
    worker: WorkerRecord,
    attempt: number,
    input: {
      readonly status: 'failed' | 'timed_out';
      readonly failure: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    },
  ): Promise<WorkerRecord> {
    const at = this.now().toISOString();
    try {
      await this.tasks.finishAttempt(ownerRef, worker.taskId, {
        attempt,
        summary: input.failure.message,
        evidence: {
          outputs: [],
          acceptance: [],
          failure: { code: input.failure.code, message: input.failure.message },
        },
      });
    } catch {
      // The task may have moved on; the worker record is still accurate.
    }
    assertWorkerTransition(worker.status, input.status);
    return this.save(
      ownerRef,
      {
        ...worker,
        status: input.status,
        failure: { ...input.failure, at },
        endedAt: at,
        updatedAt: at,
      },
      input.status === 'timed_out' ? 'timed_out' : 'failed',
      input.status === 'timed_out' ? 'system' : 'worker',
      {
        fromStatus: worker.status,
        toStatus: input.status,
        message: input.failure.message,
        detail: { code: input.failure.code, attempt },
      },
    );
  }

  private async move(
    ownerRef: string,
    worker: WorkerRecord,
    to: WorkerStatus,
    actor: WorkerEvent['actor'],
    message: string,
  ): Promise<WorkerRecord> {
    assertWorkerTransition(worker.status, to);
    return this.save(
      ownerRef,
      { ...worker, status: to, updatedAt: this.now().toISOString() },
      'status_changed',
      actor,
      { fromStatus: worker.status, toStatus: to, message },
    );
  }

  /**
   * Saves, but reports the row instead of failing when it moved.
   *
   * Used where a concurrent cancellation is a legitimate race: the caller wants
   * the final record, not a version error it cannot act on.
   */
  private async saveTolerant(
    ownerRef: string,
    worker: WorkerRecord,
    type: WorkerEventType,
    actor: WorkerEvent['actor'],
    fields: {
      readonly fromStatus?: WorkerStatus | null;
      readonly toStatus?: WorkerStatus | null;
      readonly message?: string | null;
      readonly detail?: Record<string, unknown>;
    },
  ): Promise<WorkerRecord> {
    try {
      return await this.save(ownerRef, worker, type, actor, fields);
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'WORKER_VERSION_CONFLICT') {
        return this.get(ownerRef, worker.id);
      }
      throw error;
    }
  }

  private async save(
    ownerRef: string,
    worker: WorkerRecord,
    type: WorkerEventType,
    actor: WorkerEvent['actor'],
    fields: {
      readonly fromStatus?: WorkerStatus | null;
      readonly toStatus?: WorkerStatus | null;
      readonly message?: string | null;
      readonly detail?: Record<string, unknown>;
    },
  ): Promise<WorkerRecord> {
    const next: WorkerRecord = {
      ...worker,
      version: worker.version + 1,
      eventSeq: worker.eventSeq + 1,
    };
    const ok = await this.workers.save(next, worker.version, [
      this.event(worker.id, worker.eventSeq + 1, type, actor, fields),
    ]);
    if (!ok) throw new WorkerError('WORKER_VERSION_CONFLICT');
    return next;
  }
}
