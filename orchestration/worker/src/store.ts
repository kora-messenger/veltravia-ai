/**
 * The worker store port.
 *
 * Same contracts as the task store: a status change and its event are written
 * together, and `save` is a compare-and-set so two schedulers racing for the
 * same task cannot both start a worker.
 */

import type { SchedulingDecision, WorkerEvent, WorkerRecord, WorkerStatus } from './types.js';

export interface WorkerFilter {
  readonly taskId?: string;
  readonly status?: readonly WorkerStatus[];
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

export interface WorkerStore {
  readonly kind: 'memory' | 'postgres';
  insert(worker: WorkerRecord, events: readonly WorkerEvent[]): Promise<void>;
  read(ownerRef: string, workerId: string): Promise<WorkerRecord | null>;
  list(ownerRef: string, filter?: WorkerFilter): Promise<readonly WorkerRecord[]>;
  /** Returns false when the row moved on; the caller re-reads and refuses. */
  save(
    worker: WorkerRecord,
    expectedVersion: number,
    events: readonly WorkerEvent[],
  ): Promise<boolean>;
  appendEvents(
    ownerRef: string,
    workerId: string,
    events: readonly WorkerEvent[],
    updatedAt: string,
  ): Promise<void>;
  events(
    ownerRef: string,
    workerId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly WorkerEvent[]>;
  recordDecision(decision: SchedulingDecision): Promise<void>;
  decisions(ownerRef: string, limit: number): Promise<readonly SchedulingDecision[]>;
}
