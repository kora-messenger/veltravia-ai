/**
 * Superagent worker service, as this server assembles it.
 *
 * A worker inherits the task's owner and project: there is no second permission
 * system, and the project guard that Step 42 uses is the same one that decides
 * whether work may be recorded at all.
 *
 * Storage honesty travels with the service: without a database the records live
 * in this process, and the API says so rather than implying durability.
 */

import { TaskManager } from '@veltravia/orchestration-core';
import {
  InMemoryWorkerStore,
  Scheduler,
  SimulatedExecutor,
  WorkerManager,
  type WorkerExecutor,
  type WorkerStore,
} from '@veltravia/worker-core';

import type { Persistence } from './persistence.js';
import { createTaskService, type TaskService } from './task-service.js';
import type { ProjectEngine } from '@veltravia/project-core';

/** Tools a Superagent may be granted. Anything absent here cannot be assigned. */
export const WORKER_TOOL_CATALOG = [
  'project.read',
  'project.write',
  'tests.run',
  'network.fetch',
] as const;

export interface WorkerService {
  readonly manager: WorkerManager;
  readonly scheduler: Scheduler;
  /** The store behind the manager, for read-only evidence assembly. */
  readonly workers: WorkerStore;
  readonly tasks: TaskService;
  readonly store: 'memory' | 'postgres';
  readonly durable: boolean;
  /** True while the shipped executor only simulates the assigned work. */
  readonly simulated: boolean;
}

export function createWorkerService(input: {
  readonly persistence?: Persistence | undefined;
  readonly projects: ProjectEngine;
  /** The same task service the task routes use, so memory mode shares state. */
  readonly tasks?: TaskService;
  readonly executor?: WorkerExecutor;
}): WorkerService {
  const persistence = input.persistence;
  const taskService: TaskService =
    input.tasks ??
    (persistence === undefined
      ? createTaskService({ projects: input.projects })
      : createTaskService({ persistence, projects: input.projects }));

  const durableStore: WorkerStore | null = persistence?.stores?.workers ?? null;
  const workers: WorkerStore = durableStore ?? new InMemoryWorkerStore();
  const tasks: TaskManager = taskService.manager;

  const manager = new WorkerManager({
    workers,
    tasks,
    executor: input.executor ?? new SimulatedExecutor(),
    toolCatalog: WORKER_TOOL_CATALOG,
  });
  const scheduler = new Scheduler({ workers, tasks });

  return {
    manager,
    scheduler,
    workers,
    tasks: taskService,
    store: durableStore === null ? 'memory' : 'postgres',
    durable: durableStore !== null,
    simulated: manager.simulated,
  };
}
