/**
 * Test doubles and the in-memory store.
 *
 * The memory store is not a mock: it enforces the same compare-and-set contract
 * as the Postgres one, so a test cannot pass on behaviour the durable store
 * would reject.
 */

import type { RecoveryStore } from './store.js';
import type {
  FailureObservation,
  RecoveryCaseFilter,
  RecoveryCaseRecord,
  RecoveryEvent,
  RepairAttempt,
  VerificationSnapshot,
} from './types.js';

function eventKey(record: { ownerRef: string; caseId: string }): string {
  return `${record.ownerRef}::${record.caseId}`;
}

export class InMemoryRecoveryStore implements RecoveryStore {
  readonly kind = 'memory' as const;
  private readonly cases = new Map<string, RecoveryCaseRecord>();
  private readonly eventLog = new Map<string, RecoveryEvent[]>();
  private readonly attemptLog = new Map<string, RepairAttempt[]>();

  async insertCase(record: RecoveryCaseRecord, events: readonly RecoveryEvent[]): Promise<void> {
    const key = `${record.ownerRef}::${record.id}`;
    if (this.cases.has(key)) throw new Error('case already exists');
    this.cases.set(key, record);
    this.eventLog.set(key, [...events]);
  }

  async readCase(ownerRef: string, caseId: string): Promise<RecoveryCaseRecord | null> {
    return this.cases.get(`${ownerRef}::${caseId}`) ?? null;
  }

  async listCases(
    ownerRef: string,
    filter: RecoveryCaseFilter,
  ): Promise<readonly RecoveryCaseRecord[]> {
    const all = [...this.cases.values()]
      .filter((record) => record.ownerRef === ownerRef)
      .filter((record) =>
        filter.projectId === undefined ? true : record.projectId === filter.projectId,
      )
      .filter((record) => (filter.taskId === undefined ? true : record.taskId === filter.taskId))
      .filter((record) =>
        filter.status === undefined ? true : filter.status.includes(record.status),
      )
      .filter((record) =>
        filter.workerId === undefined ? true : record.workerId === filter.workerId,
      )
      .filter((record) =>
        filter.category === undefined || filter.category.length === 0
          ? true
          : record.diagnosis !== null &&
            record.diagnosis.primary !== null &&
            filter.category.includes(record.diagnosis.primary),
      )
      .filter((record) => {
        if (filter.verification === undefined) return true;
        const status = record.verification?.status ?? null;
        if (filter.verification === 'not_run') return status === null;
        if (filter.verification === 'passed') return status === 'passed';
        return status !== null && status !== 'passed';
      })
      .filter((record) =>
        filter.insufficientEvidence !== true
          ? true
          : record.diagnosis === null || record.diagnosis.insufficient === true,
      )
      .filter((record) =>
        filter.exhausted !== true
          ? true
          : record.attempts >= record.limits.maxAttempts &&
            (['open', 'diagnosing', 'repairing', 'awaiting_verification'].includes(record.status) ||
              record.escalation?.reason === 'budget_exhausted'),
      )
      .filter((record) =>
        filter.createdAfter === undefined ? true : record.createdAt >= filter.createdAfter,
      )
      .filter((record) =>
        filter.createdBefore === undefined ? true : record.createdAt < filter.createdBefore,
      )
      .filter((record) =>
        filter.openOnly === true
          ? ['open', 'diagnosing', 'repairing', 'awaiting_verification'].includes(record.status)
          : true,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter.limit === undefined ? all : all.slice(0, filter.limit);
  }

  async saveCase(
    record: RecoveryCaseRecord,
    expectedVersion: number,
    events: readonly RecoveryEvent[],
  ): Promise<boolean> {
    const key = `${record.ownerRef}::${record.id}`;
    const current = this.cases.get(key);
    if (current === undefined || current.version !== expectedVersion) return false;
    this.cases.set(key, record);
    const log = this.eventLog.get(key) ?? [];
    this.eventLog.set(key, [...log, ...events]);
    return true;
  }

  async appendEvents(
    ownerRef: string,
    caseId: string,
    events: readonly RecoveryEvent[],
    updatedAt: string,
  ): Promise<void> {
    const key = `${ownerRef}::${caseId}`;
    const record = this.cases.get(key);
    if (record === undefined) return;
    this.cases.set(key, { ...record, updatedAt, eventSeq: record.eventSeq + events.length });
    const log = this.eventLog.get(key) ?? [];
    this.eventLog.set(key, [...log, ...events]);
  }

  async events(
    ownerRef: string,
    caseId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly RecoveryEvent[]> {
    const log = this.eventLog.get(`${ownerRef}::${caseId}`) ?? [];
    return log.filter((event) => event.seq > afterSeq).slice(0, limit);
  }

  async insertAttempt(attempt: RepairAttempt): Promise<void> {
    const key = eventKey({ ownerRef: attempt.ownerRef, caseId: attempt.caseId });
    const log = this.attemptLog.get(key) ?? [];
    this.attemptLog.set(key, [...log, attempt]);
  }

  async saveAttempt(attempt: RepairAttempt): Promise<void> {
    const key = eventKey({ ownerRef: attempt.ownerRef, caseId: attempt.caseId });
    const log = this.attemptLog.get(key) ?? [];
    this.attemptLog.set(
      key,
      log.map((item) => (item.id === attempt.id ? attempt : item)),
    );
  }

  async attempts(ownerRef: string, caseId: string): Promise<readonly RepairAttempt[]> {
    return [...(this.attemptLog.get(`${ownerRef}::${caseId}`) ?? [])].sort(
      (a, b) => a.attempt - b.attempt,
    );
  }

  async activeAttempts(ownerRef: string, taskId: string): Promise<number> {
    const cases = [...this.cases.values()].filter(
      (record) => record.ownerRef === ownerRef && record.taskId === taskId,
    );
    let running = 0;
    for (const record of cases) {
      const list = this.attemptLog.get(`${ownerRef}::${record.id}`) ?? [];
      running += list.filter((attempt) => attempt.outcome === 'running').length;
    }
    return running;
  }
}

/** A realistic failing observation; override only what a test is about. */
export function observationFixture(
  overrides: Partial<FailureObservation> = {},
): FailureObservation {
  const base: FailureObservation = {
    projectId: 'prj_1',
    taskId: 'task_1',
    workerId: 'wkr_1',
    workerType: 'backend',
    workerStatus: 'failed',
    failure: { code: 'WORKER_EXECUTOR_ERROR', message: 'The worker stopped.', retryable: true },
    declaration: {
      deliverables: ['src/settings/load.ts', 'notes.md'],
      acceptanceCriteria: ['The loader reads settings from disk', 'Tests pass'],
      scope: ['src/settings'],
      allowedTools: ['project.read', 'project.write', 'tests.run'],
      permissions: { readProject: true, writeProject: true, runTools: true, network: false },
      limits: { maxDurationMs: 120_000, maxToolCalls: 40, maxDeliverables: 4 },
    },
    produced: {
      deliverables: [],
      criteriaMet: 0,
      summary: 'Stopped early.',
      simulated: false,
    },
    attempts: 1,
    reviewRefusals: [],
    verification: null,
    conflicts: [],
    toolErrors: [],
    revision: { atStart: 'rev_1', now: 'rev_1' },
    previousAttempts: [],
  };
  return { ...base, ...overrides };
}

export function verificationFixture(
  overrides: Partial<VerificationSnapshot> = {},
): VerificationSnapshot {
  return {
    runId: 'run_1',
    status: 'passed',
    executed: true,
    executedCount: 2,
    failedOperations: [],
    evidence: [],
    ...overrides,
  };
}
