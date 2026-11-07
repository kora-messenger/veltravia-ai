/**
 * In-memory task store.
 *
 * Development storage and the core tests' store. It implements the same port as
 * PostgreSQL, including the compare-and-set, so a manager test proves the
 * policy rather than the database. It never pretends to be durable: the API
 * reports which store is behind it.
 */

import { OrchestrationError } from './errors.js';
import type { TaskStore } from './store.js';
import type { StoredTask, TaskAttempt, TaskEvent, TaskFilter, TaskRecord } from './types.js';
import { TASK_LIMITS } from './types.js';

interface Entry {
  task: TaskRecord;
  dependencies: string[];
  events: TaskEvent[];
  attempts: TaskAttempt[];
}

export class InMemoryTaskStore implements TaskStore {
  readonly kind = 'memory' as const;
  private readonly byOwner = new Map<string, Map<string, Entry>>();

  private owner(ownerRef: string): Map<string, Entry> {
    const existing = this.byOwner.get(ownerRef);
    if (existing !== undefined) return existing;
    const created = new Map<string, Entry>();
    this.byOwner.set(ownerRef, created);
    return created;
  }

  async insert(input: {
    readonly task: TaskRecord;
    readonly dependencies: readonly string[];
    readonly events: readonly TaskEvent[];
  }): Promise<void> {
    const tasks = this.owner(input.task.ownerRef);
    if (tasks.has(input.task.id)) {
      throw new OrchestrationError('TASK_INVALID', 'That task id already exists.');
    }
    tasks.set(input.task.id, {
      task: input.task,
      dependencies: [...input.dependencies],
      events: [...input.events],
      attempts: [],
    });
  }

  async read(ownerRef: string, taskId: string): Promise<StoredTask | null> {
    const entry = this.byOwner.get(ownerRef)?.get(taskId);
    if (entry === undefined) return null;
    return { task: entry.task, dependencies: [...entry.dependencies] };
  }

  async list(ownerRef: string, filter: TaskFilter): Promise<StoredTask[]> {
    const entries = [...(this.byOwner.get(ownerRef)?.values() ?? [])]
      .filter(
        (entry) => filter.projectId === undefined || entry.task.projectId === filter.projectId,
      )
      .filter((entry) => filter.chatId === undefined || entry.task.chatId === filter.chatId)
      .filter((entry) => filter.status === undefined || entry.task.status === filter.status)
      .filter(
        (entry) =>
          filter.parentTaskId === undefined || entry.task.parentTaskId === filter.parentTaskId,
      )
      .sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt));
    return entries
      .slice(0, Math.min(filter.limit ?? 50, 200))
      .map((entry) => ({ task: entry.task, dependencies: [...entry.dependencies] }));
  }

  async save(input: {
    readonly task: TaskRecord;
    readonly expectedVersion: number;
    readonly events: readonly TaskEvent[];
  }): Promise<boolean> {
    const entry = this.byOwner.get(input.task.ownerRef)?.get(input.task.id);
    if (entry === undefined) return false;
    if (entry.task.version !== input.expectedVersion) return false;
    entry.task = input.task;
    entry.events.push(...input.events);
    return true;
  }

  async appendEvents(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void> {
    const entry = this.byOwner.get(input.ownerRef)?.get(input.taskId);
    if (entry === undefined) throw new OrchestrationError('TASK_NOT_FOUND');
    entry.events.push(...input.events);
    entry.task = {
      ...entry.task,
      updatedAt: input.updatedAt,
      eventSeq: entry.task.eventSeq + input.events.length,
    };
  }

  async addDependency(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly dependsOnTaskId: string;
    readonly required: boolean;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void> {
    const entry = this.byOwner.get(input.ownerRef)?.get(input.taskId);
    if (entry === undefined) throw new OrchestrationError('TASK_NOT_FOUND');
    if (entry.dependencies.length >= TASK_LIMITS.maxDependencies) {
      throw new OrchestrationError('TASK_DEPENDENCY_LIMIT');
    }
    if (!entry.dependencies.includes(input.dependsOnTaskId)) {
      entry.dependencies.push(input.dependsOnTaskId);
    }
    entry.events.push(...input.events);
    entry.task = {
      ...entry.task,
      updatedAt: input.updatedAt,
      version: entry.task.version + 1,
      eventSeq: entry.task.eventSeq + input.events.length,
    };
  }

  async removeDependency(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly dependsOnTaskId: string;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void> {
    const entry = this.byOwner.get(input.ownerRef)?.get(input.taskId);
    if (entry === undefined) throw new OrchestrationError('TASK_NOT_FOUND');
    entry.dependencies = entry.dependencies.filter((id) => id !== input.dependsOnTaskId);
    entry.events.push(...input.events);
    entry.task = {
      ...entry.task,
      updatedAt: input.updatedAt,
      version: entry.task.version + 1,
      eventSeq: entry.task.eventSeq + input.events.length,
    };
  }

  async events(
    ownerRef: string,
    taskId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly TaskEvent[]> {
    const entry = this.byOwner.get(ownerRef)?.get(taskId);
    if (entry === undefined) return [];
    return entry.events
      .filter((event) => event.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async attempts(ownerRef: string, taskId: string): Promise<readonly TaskAttempt[]> {
    return [...(this.byOwner.get(ownerRef)?.get(taskId)?.attempts ?? [])].sort(
      (a, b) => a.attempt - b.attempt,
    );
  }

  async saveAttempt(input: {
    readonly ownerRef: string;
    readonly attempt: TaskAttempt;
  }): Promise<void> {
    const entry = this.byOwner.get(input.ownerRef)?.get(input.attempt.taskId);
    if (entry === undefined) throw new OrchestrationError('TASK_NOT_FOUND');
    const index = entry.attempts.findIndex((item) => item.attempt === input.attempt.attempt);
    if (index === -1) entry.attempts.push(input.attempt);
    else entry.attempts[index] = input.attempt;
  }

  async count(ownerRef: string): Promise<number> {
    return this.byOwner.get(ownerRef)?.size ?? 0;
  }
}

/** A scope guard for tests and for a single-owner development server. */
export function allowAllScope(): {
  ownsProject(): Promise<boolean>;
  workspaceBelongsToProject(): Promise<boolean>;
} {
  return {
    async ownsProject() {
      return true;
    },
    async workspaceBelongsToProject() {
      return true;
    },
  };
}
