/**
 * Verification store - Step 45.
 *
 * A memory adapter for tests and development. The API supplies the Postgres
 * adapter for real deployments; both satisfy the same port, so the runner does
 * not know which one it has.
 */

import type { VerificationRunFilter, VerificationRunRecord, VerificationStore } from './types.js';

export class InMemoryVerificationStore implements VerificationStore {
  readonly #runs = new Map<string, VerificationRunRecord>();

  async save(record: VerificationRunRecord): Promise<void> {
    this.#runs.set(record.id, record);
  }

  async get(ownerRef: string, runId: string): Promise<VerificationRunRecord | null> {
    const record = this.#runs.get(runId);
    return record !== undefined && record.ownerRef === ownerRef ? record : null;
  }

  async list(
    ownerRef: string,
    filter: VerificationRunFilter = {},
  ): Promise<readonly VerificationRunRecord[]> {
    const rows = [...this.#runs.values()]
      .filter((record) => record.ownerRef === ownerRef)
      .filter((record) => filter.projectId === undefined || record.projectId === filter.projectId)
      .filter((record) => filter.taskId === undefined || record.taskId === filter.taskId)
      .filter((record) => filter.workerId === undefined || record.workerId === filter.workerId)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return filter.limit === undefined ? rows : rows.slice(0, filter.limit);
  }
}
