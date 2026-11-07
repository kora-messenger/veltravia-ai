import { describe, expect, it } from 'vitest';

import { TaskManager, InMemoryTaskStore, allowAllScope } from '@veltravia/orchestration-core';

import { Scheduler } from './scheduler.js';
import { WorkerManager } from './runner.js';
import { InMemoryWorkerStore, SimulatedExecutor, TEST_TOOLS, validAssignment } from './testing.js';
import { WorkerError } from './errors.js';
import { WORKER_LIMITS } from './types.js';

const OWNER = 'owner-a';

function harness(options: { readonly durationMs?: number; readonly defaultLimit?: number } = {}) {
  const taskStore = new InMemoryTaskStore();
  const tasks = new TaskManager({ store: taskStore, scope: allowAllScope() });
  const workers = new InMemoryWorkerStore();
  const manager = new WorkerManager({
    workers,
    tasks,
    executor: new SimulatedExecutor({ durationMs: options.durationMs ?? 2 }),
    toolCatalog: TEST_TOOLS as unknown as string[],
  });
  const scheduler = new Scheduler({
    workers,
    tasks,
    ...(options.defaultLimit === undefined ? {} : { defaultLimit: options.defaultLimit }),
  });
  return { tasks, workers, manager, scheduler };
}

let counter = 0;
async function seedTask(
  tasks: TaskManager,
  options: { readonly projectId?: string } = {},
): Promise<string> {
  counter += 1;
  const task = await tasks.createTask(OWNER, {
    projectId: options.projectId ?? 'prj_a',
    title: `Task ${counter}`,
    objective: `Objective ${counter}`,
  });
  return task.id;
}

async function queue(
  manager: WorkerManager,
  tasks: TaskManager,
  options: { readonly taskId?: string; readonly scope?: string[] } = {},
) {
  const taskId = options.taskId ?? (await seedTask(tasks));
  return manager.delegate(OWNER, {
    taskId,
    workerType: 'backend',
    assignment: validAssignment({
      scope: options.scope ?? ['src/api'],
      deliverables: [
        {
          name: 'handler',
          kind: 'file',
          path: `${(options.scope ?? ['src/api'])[0]}/handler.ts`,
          summary: 'handler',
        },
      ],
    }),
  });
}

describe('parallel scheduling', () => {
  it('starts up to the limit and leaves the rest queued', async () => {
    const { tasks, manager, scheduler } = harness({ defaultLimit: 2 });
    const first = await queue(manager, tasks, { scope: ['src/a'] });
    const second = await queue(manager, tasks, { scope: ['src/b'] });
    const third = await queue(manager, tasks, { scope: ['src/c'] });

    const outcome = await scheduler.dispatch(OWNER, manager);

    expect(outcome.started.map((worker) => worker.id).sort()).toEqual([first.id, second.id].sort());
    const remaining = await manager.get(OWNER, third.id);
    expect(remaining.status).toBe('queued');
    expect(outcome.plan.skipped[0]?.reason).toBe('limit_reached');
  });

  it('runs selected workers concurrently rather than one after another', async () => {
    const { tasks, manager, scheduler } = harness({ durationMs: 60, defaultLimit: 3 });
    await queue(manager, tasks, { scope: ['src/a'] });
    await queue(manager, tasks, { scope: ['src/b'] });
    await queue(manager, tasks, { scope: ['src/c'] });

    const started = Date.now();
    const outcome = await scheduler.dispatch(OWNER, manager);
    const elapsed = Date.now() - started;

    expect(outcome.started).toHaveLength(3);
    // Three 60ms workers finished in well under three times 60ms.
    expect(elapsed).toBeLessThan(150);
    for (const worker of outcome.started) {
      expect(worker.status).toBe('awaiting_review');
    }
  });

  it('refuses a second worker for the same task', async () => {
    const { tasks, manager } = harness();
    const worker = await queue(manager, tasks);
    await expect(queue(manager, tasks, { taskId: worker.taskId })).rejects.toMatchObject({
      code: 'WORKER_DUPLICATE_ASSIGNMENT',
    });
  });

  it('refuses a worker whose paths overlap a running claim', async () => {
    const { tasks, manager } = harness({ durationMs: 80 });
    const first = await queue(manager, tasks, { scope: ['src/api'] });
    expect(first.status).toBe('queued');

    // A nested scope is still the same contested directory.
    await expect(queue(manager, tasks, { scope: ['src/api/handlers'] })).rejects.toMatchObject({
      code: 'WORKER_RESOURCE_CONFLICT',
    });
  });

  it('waits for a dependency to complete before starting', async () => {
    const { tasks, manager, scheduler } = harness();
    const blocker = await seedTask(tasks);
    const dependent = await seedTask(tasks);
    await tasks.addDependency(OWNER, dependent, blocker);

    const worker = await queue(manager, tasks, { taskId: dependent });
    const plan = await scheduler.plan(OWNER, { limit: 3 });
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped.find((entry) => entry.workerId === worker.id)?.reason).toBe(
      'dependency_unmet',
    );

    await tasks.transition(OWNER, blocker, { to: 'planning' });
    await tasks.transition(OWNER, blocker, { to: 'running' });
    await tasks.transition(OWNER, blocker, { to: 'awaiting_review' });
    await tasks.review(OWNER, blocker, { decision: 'accept', summary: 'done' });

    const second = await scheduler.plan(OWNER, { limit: 3 });
    expect(second.selected.map((entry) => entry.id)).toContain(worker.id);
  });

  it('records every decision with the reasons it refused work', async () => {
    const { tasks, manager, scheduler } = harness({ defaultLimit: 1 });
    await queue(manager, tasks, { scope: ['src/a'] });
    await queue(manager, tasks, { scope: ['src/b'] });
    await scheduler.plan(OWNER, { limit: 1 });

    const decisions = await manager.decisions(OWNER, 5);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.limit).toBe(1);
    expect(decisions[0]?.skipped.length).toBeGreaterThan(0);
  });

  it('clamps a requested limit to the platform ceiling', async () => {
    const { scheduler } = harness();
    const plan = await scheduler.plan(OWNER, { limit: 500 });
    expect(plan.decision.limit).toBe(WORKER_LIMITS.maxConcurrentCeiling);
    expect(await scheduler.limitFor(0)).toBe(1);
  });
});

describe('worker ownership', () => {
  it("does not show one owner another owner's worker", async () => {
    const { tasks, manager } = harness();
    const worker = await queue(manager, tasks);
    await expect(manager.get('owner-b', worker.id)).rejects.toBeInstanceOf(WorkerError);
    await expect(manager.get('owner-b', worker.id)).rejects.toMatchObject({
      code: 'WORKER_NOT_FOUND',
    });
  });

  it('cannot delegate against a task the caller does not own', async () => {
    const { tasks, manager } = harness();
    const taskId = await seedTask(tasks, { projectId: 'prj_other' });
    await expect(
      manager.delegate('owner-b', {
        taskId,
        workerType: 'backend',
        assignment: validAssignment(),
      }),
    ).rejects.toMatchObject({ code: 'WORKER_NOT_FOUND' });
  });
});
