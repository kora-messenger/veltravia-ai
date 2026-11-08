/**
 * An in-memory execution store for tests and for memory-mode deployments.
 * Deliberately dumb: the coordinator's rules live in the manager, not here.
 */

import type { ExecutionFilter, ExecutionStore } from './store.js';
import type { ExecutionRecord } from './types.js';

const OPEN = new Set(['planning', 'awaiting_approval', 'executing', 'verifying', 'integrating']);

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly rows = new Map<string, ExecutionRecord>();

  async insertExecution(record: ExecutionRecord): Promise<void> {
    this.rows.set(`${record.ownerRef}:${record.id}`, record);
  }

  async saveExecution(record: ExecutionRecord, expectedVersion: number): Promise<boolean> {
    const key = `${record.ownerRef}:${record.id}`;
    const current = this.rows.get(key);
    if (current === undefined || current.version !== expectedVersion) return false;
    this.rows.set(key, record);
    return true;
  }

  async getExecution(ownerRef: string, executionId: string): Promise<ExecutionRecord | null> {
    return this.rows.get(`${ownerRef}:${executionId}`) ?? null;
  }

  async listExecutions(
    ownerRef: string,
    filter: ExecutionFilter,
  ): Promise<readonly ExecutionRecord[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return [...this.rows.values()]
      .filter((record) => record.ownerRef === ownerRef)
      .filter((record) => filter.projectId === undefined || record.projectId === filter.projectId)
      .filter((record) => filter.status === undefined || filter.status.includes(record.status))
      .filter((record) => filter.openOnly !== true || OPEN.has(record.status))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit);
  }
}
