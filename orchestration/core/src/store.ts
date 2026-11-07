/**
 * The task store port.
 *
 * Two things are contracts here, because the API depends on both:
 *  - a status change and its event are written together, so history cannot
 *    disagree with state;
 *  - `save` is a compare-and-set on `version`, so two callers editing the same
 *    task cannot both win.
 */

import type { StoredTask, TaskEvent, TaskAttempt, TaskFilter, TaskRecord } from './types.js';

export interface TaskStore {
  readonly kind: 'memory' | 'postgres';

  insert(input: {
    readonly task: TaskRecord;
    readonly dependencies: readonly string[];
    readonly events: readonly TaskEvent[];
  }): Promise<void>;

  read(ownerRef: string, taskId: string): Promise<StoredTask | null>;

  list(ownerRef: string, filter: TaskFilter): Promise<StoredTask[]>;

  /** True when the row was still at `expectedVersion`; false means somebody else won. */
  save(input: {
    readonly task: TaskRecord;
    readonly expectedVersion: number;
    readonly events: readonly TaskEvent[];
  }): Promise<boolean>;

  /** Progress only: appends events and touches the task, without a version bump. */
  appendEvents(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void>;

  addDependency(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly dependsOnTaskId: string;
    readonly required: boolean;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void>;

  removeDependency(input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly dependsOnTaskId: string;
    readonly events: readonly TaskEvent[];
    readonly updatedAt: string;
  }): Promise<void>;

  events(
    ownerRef: string,
    taskId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly TaskEvent[]>;

  attempts(ownerRef: string, taskId: string): Promise<readonly TaskAttempt[]>;

  saveAttempt(input: { readonly ownerRef: string; readonly attempt: TaskAttempt }): Promise<void>;

  count(ownerRef: string): Promise<number>;
}
