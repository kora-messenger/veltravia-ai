/**
 * The recovery store port.
 *
 * Same contract as every other store in this repo: state and its events are
 * written together, and `saveCase` is a compare-and-set so two coordinators
 * cannot both advance one case.
 */

import type {
  RecoveryCaseFilter,
  RecoveryCaseRecord,
  RecoveryEvent,
  RepairAttempt,
} from './types.js';

export interface RecoveryStore {
  readonly kind: 'memory' | 'postgres';
  insertCase(record: RecoveryCaseRecord, events: readonly RecoveryEvent[]): Promise<void>;
  readCase(ownerRef: string, caseId: string): Promise<RecoveryCaseRecord | null>;
  listCases(ownerRef: string, filter: RecoveryCaseFilter): Promise<readonly RecoveryCaseRecord[]>;
  /** False when the row moved on; the caller re-reads and refuses. */
  saveCase(
    record: RecoveryCaseRecord,
    expectedVersion: number,
    events: readonly RecoveryEvent[],
  ): Promise<boolean>;
  appendEvents(
    ownerRef: string,
    caseId: string,
    events: readonly RecoveryEvent[],
    updatedAt: string,
  ): Promise<void>;
  events(
    ownerRef: string,
    caseId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly RecoveryEvent[]>;
  insertAttempt(attempt: RepairAttempt): Promise<void>;
  saveAttempt(attempt: RepairAttempt): Promise<void>;
  attempts(ownerRef: string, caseId: string): Promise<readonly RepairAttempt[]>;
  /** Running attempts across a task, for the concurrency ceiling. */
  activeAttempts(ownerRef: string, taskId: string): Promise<number>;
}
