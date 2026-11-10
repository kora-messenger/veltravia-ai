/**
 * Development stores and the simulated executor.
 *
 * The executor here does NOT do the assigned work. It produces a result with
 * the declared deliverables and says `simulated: true` on every one, so nothing
 * downstream can mistake it for a real worker. Its value is that the scheduler,
 * the lifecycle, the review and the persistence can be exercised honestly
 * before a real executor exists.
 */

import type {
  SchedulingDecision,
  WorkerAssignment,
  WorkerEvent,
  WorkerRecord,
  WorkerStatus,
} from './types.js';
import type { WorkerExecution, WorkerExecutor, WorkerExecutorInput } from './runner.js';
import { isActiveWorkerStatus } from './lifecycle.js';
import { WorkerError } from './errors.js';
import type { WorkerFilter, WorkerStore } from './store.js';

const ACTIVE: readonly WorkerStatus[] = [
  'queued',
  'assigned',
  'starting',
  'running',
  'blocked',
  'partially_completed',
  'awaiting_review',
];

export class InMemoryWorkerStore implements WorkerStore {
  readonly kind = 'memory' as const;
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly log = new Map<string, WorkerEvent[]>();
  private readonly decisionLog: SchedulingDecision[] = [];

  private key(ownerRef: string, workerId: string): string {
    return `${ownerRef}::${workerId}`;
  }

  async insert(worker: WorkerRecord, events: readonly WorkerEvent[]): Promise<void> {
    const key = this.key(worker.ownerRef, worker.id);
    if (this.workers.has(key)) throw new WorkerError('WORKER_DUPLICATE_ASSIGNMENT');
    const activeOnTask = [...this.workers.values()].some(
      (entry) =>
        entry.ownerRef === worker.ownerRef &&
        entry.taskId === worker.taskId &&
        ACTIVE.includes(entry.status),
    );
    if (activeOnTask) throw new WorkerError('WORKER_DUPLICATE_ASSIGNMENT');
    this.workers.set(key, worker);
    this.log.set(key, [...events]);
  }

  async read(ownerRef: string, workerId: string): Promise<WorkerRecord | null> {
    return this.workers.get(this.key(ownerRef, workerId)) ?? null;
  }

  async list(ownerRef: string, filter: WorkerFilter = {}): Promise<readonly WorkerRecord[]> {
    const rows = [...this.workers.values()]
      .filter((worker) => worker.ownerRef === ownerRef)
      .filter((worker) => (filter.taskId === undefined ? true : worker.taskId === filter.taskId))
      .filter((worker) =>
        filter.status === undefined ? true : filter.status.includes(worker.status),
      )
      .filter((worker) => (filter.activeOnly === true ? isActiveWorkerStatus(worker.status) : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return filter.limit === undefined ? rows : rows.slice(0, filter.limit);
  }

  async save(
    worker: WorkerRecord,
    expectedVersion: number,
    events: readonly WorkerEvent[],
  ): Promise<boolean> {
    const key = this.key(worker.ownerRef, worker.id);
    const existing = this.workers.get(key);
    if (existing === undefined) return false;
    if (existing.version !== expectedVersion) return false;
    this.workers.set(key, worker);
    this.log.set(key, [...(this.log.get(key) ?? []), ...events]);
    return true;
  }

  async appendEvents(
    ownerRef: string,
    workerId: string,
    events: readonly WorkerEvent[],
    updatedAt: string,
  ): Promise<void> {
    const key = this.key(ownerRef, workerId);
    const existing = this.workers.get(key);
    if (existing === undefined) return;
    // Keep the record's counter ahead of the log, exactly as the durable store
    // does: a later save must not reuse a sequence number already written.
    const highest = events.reduce((max, event) => Math.max(max, event.seq), 0);
    this.workers.set(key, {
      ...existing,
      updatedAt,
      eventSeq: Math.max(existing.eventSeq, highest),
    });
    this.log.set(key, [...(this.log.get(key) ?? []), ...events]);
  }

  async events(
    ownerRef: string,
    workerId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly WorkerEvent[]> {
    const rows = (this.log.get(this.key(ownerRef, workerId)) ?? [])
      .filter((event) => event.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq);
    return rows.slice(0, limit);
  }

  async recordDecision(decision: SchedulingDecision): Promise<void> {
    this.decisionLog.unshift(decision);
  }

  async decisions(ownerRef: string, limit: number): Promise<readonly SchedulingDecision[]> {
    return this.decisionLog.filter((entry) => entry.ownerRef === ownerRef).slice(0, limit);
  }
}

export interface SimulatedExecutorOptions {
  /** How long the "work" takes. */
  readonly durationMs?: number;
  /** Deterministic override per worker, used by tests. */
  readonly behaviour?: (input: {
    readonly workerId: string;
    readonly workerType: string;
    readonly assignment: WorkerAssignment;
  }) => Partial<WorkerExecution> | undefined;
}

/**
 * A worker that finishes quickly with the deliverables it was asked for.
 *
 * `simulated: true` is not decoration: the API surfaces it, and the review
 * records it, because a result this executor produced is not evidence that the
 * assigned work was done.
 */
export class SimulatedExecutor implements WorkerExecutor {
  readonly simulated = true;
  private readonly durationMs: number;
  private readonly behaviour: SimulatedExecutorOptions['behaviour'];

  constructor(options: SimulatedExecutorOptions = {}) {
    this.durationMs = options.durationMs ?? 5;
    this.behaviour = options.behaviour;
  }

  async run(input: WorkerExecutorInput): Promise<WorkerExecution> {
    const override = this.behaviour?.({
      workerId: input.workerId,
      workerType: input.workerType,
      assignment: input.assignment,
    });
    if (override !== undefined) {
      await this.pause(this.durationMs, input.signal);
      return {
        outcome: override.outcome ?? 'completed',
        summary: override.summary ?? 'Simulated worker finished.',
        deliverables: override.deliverables ?? [],
        evidence: override.evidence ?? [],
        notes: override.notes ?? null,
        blockedReason: override.blockedReason ?? null,
        failure: override.failure ?? null,
      };
    }

    input.report({ message: 'reading the assignment', percent: 5 });
    await this.pause(this.durationMs, input.signal);
    input.report({ message: 'producing deliverables', percent: 60 });
    await this.pause(this.durationMs, input.signal);

    const deliverables = input.assignment.deliverables.map((deliverable) => ({
      name: deliverable.name,
      kind: deliverable.kind,
      path: deliverable.path,
      summary: `Simulated output for ${deliverable.name}.`,
      hash: null,
    }));
    return {
      outcome: 'completed',
      summary: `Simulated ${input.workerType} work finished: ${deliverables.length} deliverable(s).`,
      deliverables,
      evidence: [
        {
          kind: 'note',
          ref: `simulated:${input.workerId}`,
          summary: 'No command ran; this executor is a simulation.',
          passed: null,
        },
      ],
      notes: 'Simulated execution. Nothing was built, run or written to a project.',
      blockedReason: null,
      failure: null,
    };
  }

  private pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new WorkerError('WORKER_INTERNAL', 'aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new WorkerError('WORKER_INTERNAL', 'aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** A complete, valid assignment, with the caller's overrides applied. */
export function validAssignment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objective: 'Implement the settings panel described in the task.',
    scope: ['src/settings'],
    exclusions: ['src/settings/secrets.ts'],
    deliverables: [
      {
        name: 'settings panel',
        kind: 'file',
        path: 'src/settings/panel.tsx',
        summary: 'The panel',
      },
    ],
    acceptanceCriteria: ['the panel renders the three settings', 'no changes outside src/settings'],
    allowedTools: ['project.read', 'project.write'],
    permissions: { readProject: true, writeProject: true, runTools: true, network: false },
    limits: { maxDurationMs: 60_000, maxToolCalls: 40, maxDeliverables: 5 },
    dependencies: [],
    checkpoints: ['after the first render'],
    cancellationConditions: ['the owner cancels the task'],
    reporting: ['list the files written'],
    primaryRunId: null,
    ...overrides,
  };
}

export const TEST_TOOLS = ['project.read', 'project.write', 'tests.run', 'network.fetch'] as const;
