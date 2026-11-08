/**
 * Where executions live. The store is a port so the same coordinator runs over
 * memory in tests and PostgreSQL in deployment; an execution is one row, and a
 * compare-and-set keeps two readers from overwriting each other.
 */

import type { ExecutionRecord, ExecutionStatus } from './types.js';

export interface ExecutionFilter {
  readonly projectId?: string;
  readonly status?: readonly ExecutionStatus[];
  readonly openOnly?: boolean;
  readonly limit?: number;
}

export interface ExecutionStore {
  insertExecution(record: ExecutionRecord): Promise<void>;
  /** Returns false when the stored revision is not the one the caller saw. */
  saveExecution(record: ExecutionRecord, expectedVersion: number): Promise<boolean>;
  getExecution(ownerRef: string, executionId: string): Promise<ExecutionRecord | null>;
  listExecutions(ownerRef: string, filter: ExecutionFilter): Promise<readonly ExecutionRecord[]>;
}
