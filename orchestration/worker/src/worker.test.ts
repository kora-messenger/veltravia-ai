import { describe, expect, it } from 'vitest';

import { InMemoryTaskStore, TaskManager, allowAllScope } from '@veltravia/orchestration-core';

import { WorkerManager, type WorkerExecution, type WorkerExecutor } from './runner.js';
import { InMemoryWorkerStore, SimulatedExecutor, TEST_TOOLS, validAssignment } from './testing.js';
import { WorkerError } from './errors.js';
import { assertWorkerTransition, canWorkerTransition } from './lifecycle.js';

const OWNER = 'owner-a';

let counter = 0;

function harness(
  options: {
    readonly executor?: WorkerExecutor;
    readonly maxDurationMs?: number;
    readonly now?: () => Date;
    readonly stallAfterMs?: number;
  } = {},
) {
  const tasks = new TaskManager({ store: new InMemoryTaskStore(), scope: allowAllScope() });
  const workers = new InMemoryWorkerStore();
  const manager = new WorkerManager({
    workers,
    tasks,
    executor: options.executor ?? new SimulatedExecutor({ durationMs: 2 }),
    toolCatalog: TEST_TOOLS as unknown as string[],
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.stallAfterMs === undefined ? {} : { stallAfterMs: options.stallAfterMs }),
  });
  return { tasks, workers, manager };
}

async function seedTask(tasks: TaskManager): Promise<string> {
  counter += 1;
  const task = await tasks.createTask(OWNER, {
    projectId: 'prj_a',
    title: `Task ${counter}`,
    objective: `Objective ${counter}`,
  });
  return task.id;
}

async function delegate(
  manager: WorkerManager,
  tasks: TaskManager,
  overrides: Record<string, unknown> = {},
) {
  const taskId = await seedTask(tasks);
  const worker = await manager.delegate(OWNER, {
    taskId,
    workerType: 'backend',
    assignment: validAssignment(overrides),
  });
  return { worker, taskId };
}

const passingCriteria = [true, true];

describe('worker lifecycle', () => {
  it('allows the documented moves and refuses the rest', () => {
    expect(canWorkerTransition('queued', 'assigned')).toBe(true);
    expect(canWorkerTransition('running', 'awaiting_review')).toBe(true);
    expect(canWorkerTransition('awaiting_review', 'completed')).toBe(true);
    expect(canWorkerTransition('queued', 'completed')).toBe(false);
    expect(canWorkerTransition('completed', 'running')).toBe(false);
    expect(() => assertWorkerTransition('completed', 'running')).toThrow(WorkerError);
    expect(() => assertWorkerTransition('failed', 'completed' as never)).toThrow(WorkerError);
  });
});

describe('running a worker', () => {
  it('runs to awaiting_review with the deliverables it was asked for', async () => {
    const { tasks, manager } = harness();
    const { worker, taskId } = await delegate(manager, tasks);

    const finished = await manager.start(OWNER, worker.id);

    expect(finished.status).toBe('awaiting_review');
    expect(finished.result?.deliverables[0]?.name).toBe('settings panel');
    expect(finished.result?.simulated).toBe(true);
    const task = await tasks.getTask(OWNER, taskId);
    expect(task.status).toBe('awaiting_review');
    expect(task.retry.attempts).toBe(1);
  });

  it('records the attempt against the task, not in a parallel table', async () => {
    const { tasks, manager } = harness();
    const { worker, taskId } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);

    const attempts = await tasks.attempts(OWNER, taskId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.runId).toBe(worker.id);
    expect(attempts[0]?.endedAt).not.toBeNull();
  });

  it('marks a worker that is stopped by its time budget as timed out', async () => {
    const slow: WorkerExecutor = {
      simulated: true,
      run: () => new Promise<WorkerExecution>(() => undefined),
    };
    const { tasks, manager } = harness({ executor: slow, maxDurationMs: 30 });
    const { worker } = await delegate(manager, tasks);

    const finished = await manager.start(OWNER, worker.id);

    expect(finished.status).toBe('timed_out');
    expect(finished.failure?.code).toBe('WORKER_TIMEOUT');
  });

  it('records a worker that ends without a result as failed', async () => {
    const crashing: WorkerExecutor = {
      simulated: true,
      run: async () => {
        throw new Error('the executor died');
      },
    };
    const { tasks, manager } = harness({ executor: crashing });
    const { worker, taskId } = await delegate(manager, tasks);

    const finished = await manager.start(OWNER, worker.id);

    expect(finished.status).toBe('failed');
    expect(finished.failure?.code).toBe('WORKER_CRASHED');
    const task = await tasks.getTask(OWNER, taskId);
    expect(task.status).toBe('failed');
  });

  it('cancels a running worker and its task', async () => {
    const { tasks, manager } = harness({ executor: new SimulatedExecutor({ durationMs: 200 }) });
    const { worker, taskId } = await delegate(manager, tasks);

    const running = manager.start(OWNER, worker.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = await manager.cancel(OWNER, worker.id, 'the owner changed their mind');
    await running;

    expect(cancelled.status).toBe('cancelled');
    expect((await tasks.getTask(OWNER, taskId)).status).toBe('cancelled');
    expect((await manager.get(OWNER, worker.id)).status).toBe('cancelled');
  });

  it('refuses to cancel work that has already finished', async () => {
    const { tasks, manager } = harness();
    const { worker } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);
    await manager.review(OWNER, worker.id, {
      summary: 'accepted',
      criteriaResults: passingCriteria,
    });
    await expect(manager.cancel(OWNER, worker.id, 'too late')).rejects.toMatchObject({
      code: 'WORKER_NOT_CANCELLABLE',
    });
  });
});

describe('primary agent review', () => {
  it('is the only way to complete a worker, and completing it completes the task', async () => {
    const { tasks, manager } = harness();
    const { worker, taskId } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);

    const result = await manager.review(OWNER, worker.id, {
      summary: 'accepting the handler',
      criteriaResults: passingCriteria,
    });

    expect(result.decision ?? result.worker.review?.decision).toBeTruthy();
    expect(result.worker.status).toBe('completed');
    expect(result.checks.every((check) => check.name.length > 0)).toBe(true);
    expect((await tasks.getTask(OWNER, taskId)).status).toBe('completed');
  });

  it('rejects when an acceptance criterion was never checked', async () => {
    const { tasks, manager } = harness();
    const { worker, taskId } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);

    const reviewed = await manager.review(OWNER, worker.id, {
      summary: 'one criterion unproven',
      criteriaResults: [true, null],
    });

    expect(reviewed.worker.status).toBe('failed');
    expect(reviewed.worker.failure?.code).toBe('REVIEW_REJECTED');
    expect((await tasks.getTask(OWNER, taskId)).reviewStatus).toBe('rejected');
  });

  it('refuses to accept a deliverable written outside the assignment', async () => {
    const { tasks, manager } = harness();
    const { worker } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);

    const outside = await manager.review(OWNER, worker.id, {
      summary: 'looks fine to me',
      criteriaResults: passingCriteria,
      changedPaths: ['src/settings/secrets.ts'],
    });

    expect(outside.worker.status).toBe('failed');
    expect(outside.checks.find((check) => check.name === 'no_unauthorised_changes')?.passed).toBe(
      false,
    );
  });

  it('refuses a review whose summary carries a credential', async () => {
    const { tasks, manager } = harness();
    const { worker } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);
    await expect(
      manager.review(OWNER, worker.id, {
        summary: 'deployed with sk-live-abcdef1234567890abcdef',
        criteriaResults: passingCriteria,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_SECRET_REJECTED' });
  });

  it('refuses to review work that is not awaiting review', async () => {
    const { tasks, manager } = harness();
    const { worker } = await delegate(manager, tasks);
    await expect(
      manager.review(OWNER, worker.id, { summary: 'early', criteriaResults: passingCriteria }),
    ).rejects.toMatchObject({ code: 'WORKER_REVIEW_REFUSED' });
  });
});

describe('retry and recovery', () => {
  it('re-queues a failed worker with a backoff, then lets it run again', async () => {
    let clock = new Date('2026-11-07T05:00:00.000Z');
    const failing: WorkerExecutor = {
      simulated: true,
      run: async () => {
        throw new Error('boom');
      },
    };
    const { tasks, manager } = harness({ executor: failing, now: () => clock });
    const { worker } = await delegate(manager, tasks);
    const failed = await manager.start(OWNER, worker.id);
    expect(failed.status).toBe('failed');

    const requeued = await manager.requeue(OWNER, worker.id, 'try again');
    expect(requeued.status).toBe('queued');
    expect(requeued.retryNotBefore).toBeTruthy();
    expect(new Date(requeued.retryNotBefore as string).getTime()).toBeGreaterThan(clock.getTime());

    clock = new Date(clock.getTime() + 60_000);
    const again = await manager.start(OWNER, worker.id);
    expect(again.attempts).toBe(2);
    expect(again.status).toBe('failed');
  });

  it('refuses to re-queue past the attempt budget', async () => {
    const failing: WorkerExecutor = {
      simulated: true,
      run: async () => {
        throw new Error('x');
      },
    };
    const { tasks, manager } = harness({ executor: failing });
    const { worker } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);
    await manager.requeue(OWNER, worker.id, 'again');
    await manager.start(OWNER, worker.id);
    await manager.requeue(OWNER, worker.id, 'again');
    await manager.start(OWNER, worker.id);

    await expect(manager.requeue(OWNER, worker.id, 'once more')).rejects.toMatchObject({
      code: 'WORKER_RETRY_REFUSED',
    });
  });

  it('marks a worker that stopped reporting as timed out', async () => {
    const { tasks, manager, workers } = harness({ stallAfterMs: 1_000 });
    const { worker } = await delegate(manager, tasks);
    const queued = await manager.get(OWNER, worker.id);
    // Simulate a process that died mid-run: the record says running, nothing is live.
    await workers.save(
      {
        ...queued,
        status: 'running',
        startedAt: '2026-11-07T04:00:00.000Z',
        lastHeartbeatAt: '2026-11-07T04:00:00.000Z',
        version: queued.version + 1,
        eventSeq: queued.eventSeq + 1,
      },
      queued.version,
      [],
    );

    const recovered = await manager.recoverStalled(OWNER);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('timed_out');
    expect(recovered[0]?.failure?.code).toBe('WORKER_STALLED');
  });

  it('reports progress for the parent task', async () => {
    const { tasks, manager } = harness();
    const { worker, taskId } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);

    const report = await manager.progressFor(OWNER, taskId);
    expect(report.awaitingReview).toContain(worker.id);
    expect(report.deliverables[0]?.name).toBe('settings panel');
    expect(report.taskStatus).toBe('awaiting_review');
  });

  it('keeps every state change in the event log', async () => {
    const { tasks, manager } = harness();
    const { worker } = await delegate(manager, tasks);
    await manager.start(OWNER, worker.id);
    await manager.review(OWNER, worker.id, { summary: 'ok', criteriaResults: passingCriteria });

    const events = await manager.events(OWNER, worker.id);
    const toStatuses = events.map((event) => event.toStatus).filter((status) => status !== null);
    expect(toStatuses).toContain('running');
    expect(toStatuses).toContain('awaiting_review');
    expect(toStatuses).toContain('completed');
    expect(events[0]?.type).toBe('created');
  });
});
