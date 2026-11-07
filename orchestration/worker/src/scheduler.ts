/**
 * Deciding what may run at once.
 *
 * The scheduler works over QUEUED WORKERS, not over tasks: a worker already
 * carries a validated, bounded assignment, so there is nothing left to interpret
 * at dispatch time. A queued worker is selected only when its task is open, its
 * dependencies are finished, nothing else holds a conflicting claim, it is not
 * in retry backoff, and a concurrency slot is free. Everything it refuses is
 * recorded with a reason, because "why is nothing running" is the question this
 * system will be asked.
 */

import type { TaskManager, TaskView } from '@veltravia/orchestration-core';

import type { SchedulingDecision, SkippedWorker, WorkerRecord } from './types.js';
import { WORKER_LIMITS } from './types.js';
import { findConflict } from './resources.js';
import type { ResourceClaim } from './types.js';
import type { WorkerStore } from './store.js';
import type { WorkerManager } from './runner.js';

export interface SchedulerOptions {
  readonly workers: WorkerStore;
  readonly tasks: TaskManager;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly defaultLimit?: number;
}

export interface SchedulingPlan {
  readonly decision: SchedulingDecision;
  /** Queued workers this plan may start, in the order they were created. */
  readonly selected: readonly WorkerRecord[];
  readonly skipped: readonly SkippedWorker[];
}

export interface DispatchOutcome {
  readonly plan: SchedulingPlan;
  readonly started: readonly WorkerRecord[];
}

export class Scheduler {
  private readonly workers: WorkerStore;
  private readonly tasks: TaskManager;
  private readonly now: () => Date;
  private readonly newId: () => string;
  readonly defaultLimit: number;

  constructor(options: SchedulerOptions) {
    this.workers = options.workers;
    this.tasks = options.tasks;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `dec_${Math.random().toString(36).slice(2, 12)}`);
    this.defaultLimit = options.defaultLimit ?? WORKER_LIMITS.maxConcurrentDefault;
  }

  /** The concurrency limit actually used, clamped to what the platform allows. */
  limitFor(requested: number | undefined): number {
    const wanted = requested ?? this.defaultLimit;
    const rounded = Number.isFinite(wanted) ? Math.floor(wanted) : this.defaultLimit;
    return Math.max(1, Math.min(rounded, WORKER_LIMITS.maxConcurrentCeiling));
  }

  async plan(ownerRef: string, options: { readonly limit?: number } = {}): Promise<SchedulingPlan> {
    const owner = ownerRef.trim();
    const at = this.now();
    const limit = this.limitFor(options.limit);
    const all = await this.workers.list(owner, { limit: 300 });
    const active = all.filter((worker: WorkerRecord) => isActiveHoldingSlot(worker));
    const queued = all
      .filter((worker: WorkerRecord) => worker.status === 'queued')
      .sort((left: WorkerRecord, right: WorkerRecord) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    const tasks = await this.tasks.listTasks(owner, { limit: 300 });
    const byId = new Map(tasks.map((task: TaskView) => [task.id, task]));
    const busyTasks = new Set(active.map((worker: WorkerRecord) => worker.taskId));

    const skipped: SkippedWorker[] = [];
    const selected: WorkerRecord[] = [];
    const held: { workerId: string; claims: readonly ResourceClaim[] }[] = active.map(
      (worker: WorkerRecord) => ({ workerId: worker.id, claims: worker.resources }),
    );

    for (const worker of queued) {
      const task = byId.get(worker.taskId);
      if (task === undefined) {
        skipped.push({
          workerId: worker.id,
          taskId: worker.taskId,
          reason: 'not_ready',
          detail: 'the task this worker belongs to no longer exists for this owner',
        });
        continue;
      }
      if (task.status === 'completed' || task.status === 'cancelled') {
        skipped.push({
          workerId: worker.id,
          taskId: task.id,
          reason: 'not_ready',
          detail: `the task is ${task.status}`,
        });
        continue;
      }
      if (busyTasks.has(worker.taskId)) {
        skipped.push({
          workerId: worker.id,
          taskId: task.id,
          reason: 'already_working',
          detail: 'another worker is active on this task',
        });
        continue;
      }
      const unmet = task.dependencies.filter((dependency) => {
        const dependencyTask = byId.get(dependency);
        return dependencyTask === undefined || dependencyTask.status !== 'completed';
      });
      if (unmet.length > 0) {
        skipped.push({
          workerId: worker.id,
          taskId: task.id,
          reason: 'dependency_unmet',
          detail: `waiting on ${unmet.join(', ')}`,
        });
        continue;
      }
      if (worker.retryNotBefore !== null && worker.retryNotBefore > at.toISOString()) {
        skipped.push({
          workerId: worker.id,
          taskId: task.id,
          reason: 'retry_backoff',
          detail: `may start after ${worker.retryNotBefore}`,
        });
        continue;
      }
      if (active.length + selected.length >= limit) {
        skipped.push({
          workerId: worker.id,
          taskId: task.id,
          reason: 'limit_reached',
          detail: `${active.length} active, limit ${limit}`,
        });
        continue;
      }
      const conflict = findConflict(worker.resources, held);
      if (conflict !== null) {
        skipped.push({
          workerId: worker.id,
          taskId: task.id,
          reason: 'resource_conflict',
          detail: `${conflict.workerId} holds ${conflict.claim.path}`,
        });
        continue;
      }
      if (worker.assignment.scope.length === 0) {
        skipped.push({
          workerId: worker.id,
          taskId: task.id,
          reason: 'ambiguous_scope',
          detail: 'the assignment names no paths',
        });
        continue;
      }
      held.push({ workerId: worker.id, claims: worker.resources });
      selected.push(worker);
    }

    const decision: SchedulingDecision = {
      id: this.newId(),
      ownerRef: owner,
      at: at.toISOString(),
      limit,
      active: active.length,
      selected: selected.map((worker) => worker.id),
      skipped,
    };
    await this.workers.recordDecision(decision);
    return { decision, selected, skipped };
  }

  /**
   * Plans, then starts what it selected, concurrently and no wider than the
   * limit. A worker that fails to start does not stop the others.
   */
  /** The decisions this owner's scheduler has recorded, newest first. */
  async history(ownerRef: string, limit = 20): Promise<readonly SchedulingDecision[]> {
    return this.workers.decisions(ownerRef.trim(), limit);
  }

  async dispatch(
    ownerRef: string,
    runner: WorkerManager,
    options: { readonly limit?: number } = {},
  ): Promise<DispatchOutcome> {
    const plan = await this.plan(ownerRef, options);
    const results = await Promise.all(
      plan.selected.map(async (worker) => {
        try {
          return await runner.start(ownerRef, worker.id);
        } catch {
          return null;
        }
      }),
    );
    return {
      plan,
      started: results.filter((entry): entry is WorkerRecord => entry !== null),
    };
  }
}

/** A worker that occupies a concurrency slot. */
function isActiveHoldingSlot(worker: WorkerRecord): boolean {
  return (
    worker.status === 'assigned' ||
    worker.status === 'starting' ||
    worker.status === 'running' ||
    worker.status === 'blocked' ||
    worker.status === 'partially_completed' ||
    worker.status === 'awaiting_review'
  );
}
