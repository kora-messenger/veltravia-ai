/**
 * Reliability service (Step 51).
 *
 * It holds three things and owns no lifecycle of its own:
 *
 *  - the idempotency guard the API's request hook uses;
 *  - the lease coordinator that keeps two processes from advancing the same
 *    execution;
 *  - the sweep, which is the only place that looks at interrupted work and asks
 *    the existing engines what state it is really in.
 *
 * The sweep does not repair, verify, retry or complete anything. It closes
 * workers that stopped reporting (the Step 43 rule), re-reads every linked
 * record through the Step 50 coordinator, and records what it decided. A worker
 * that is marked timed out becomes a recovery case through the Step 48 engine,
 * exactly as it would have without a crash.
 */

import {
  EventInbox,
  IdempotencyGuard,
  InMemoryEventInbox,
  InMemoryIdempotencyStore,
  InMemoryLeaseStore,
  LeaseCoordinator,
  RELIABILITY_LIMITS,
  buildReliabilityHealth,
  decideSweep,
  isAbandoned,
  type EventInboxStore,
  type IdempotencyStore,
  type LeaseStore,
  type OrchestrationRecovery,
  type ReliabilityHealth,
  type SweepDecision,
} from '@veltravia/reliability-core';

import type { ExecutionService } from './execution-service.js';
import type { RecoveryService } from './recovery-service.js';
import type { TaskService } from './task-service.js';
import type { VerificationService } from './verification.js';
import type { WorkerService } from './worker-service.js';
import type { Persistence } from './persistence.js';

export interface OrchestrationRecoveryStore {
  record(decision: Omit<OrchestrationRecovery, 'ownerRef'>): Promise<OrchestrationRecovery>;
  list(
    ownerRef: string,
    filter?: { readonly executionId?: string; readonly limit?: number },
  ): Promise<readonly OrchestrationRecovery[]>;
}

class InMemoryOrchestrationRecoveries implements OrchestrationRecoveryStore {
  private readonly byOwner = new Map<string, OrchestrationRecovery[]>();

  async record(decision: Omit<OrchestrationRecovery, 'ownerRef'>): Promise<OrchestrationRecovery> {
    // A per-process record is still a record: it explains this process's
    // decisions even when there is no database behind it.
    const ownerRef = (decision as { ownerRef?: string }).ownerRef ?? 'process';
    const stored: OrchestrationRecovery = { ...decision, ownerRef };
    const list = this.byOwner.get(ownerRef) ?? [];
    list.unshift(stored);
    this.byOwner.set(ownerRef, list.slice(0, 200));
    return stored;
  }

  async list(
    ownerRef: string,
    filter: { readonly executionId?: string; readonly limit?: number } = {},
  ): Promise<readonly OrchestrationRecovery[]> {
    return (this.byOwner.get(ownerRef) ?? [])
      .filter(
        (entry) => filter.executionId === undefined || entry.executionId === filter.executionId,
      )
      .slice(0, filter.limit ?? 50);
  }
}

export interface ReliabilityServiceOptions {
  readonly executions: ExecutionService;
  readonly tasks: TaskService;
  readonly workers: WorkerService;
  readonly verification: VerificationService;
  readonly recovery: RecoveryService;
  readonly persistence?: Persistence | undefined;
  /** Identifies this process in lease rows, so a stale holder is visible. */
  readonly holder?: string;
  readonly now?: () => Date;
}

export interface SweepResult {
  readonly examined: number;
  readonly skipped: number;
  readonly decisions: readonly SweepDecision[];
  readonly recoveredWorkers: readonly string[];
}

export interface ReliabilityService {
  readonly guard: IdempotencyGuard;
  readonly leases: LeaseCoordinator;
  readonly inbox: EventInbox;
  readonly recoveries: OrchestrationRecoveryStore;
  readonly holder: string;
  readonly durable: boolean;
  sweep(ownerRef: string): Promise<SweepResult>;
  health(ownerRef: string): Promise<ReliabilityHealth>;
  decisions(ownerRef: string, executionId?: string): Promise<readonly OrchestrationRecovery[]>;
}

export function createReliabilityService(options: ReliabilityServiceOptions): ReliabilityService {
  const now = options.now ?? (() => new Date());
  const stores = options.persistence?.stores;

  const idempotencyStore: IdempotencyStore =
    (stores?.idempotency as IdempotencyStore | undefined) ?? new InMemoryIdempotencyStore();
  const leaseStore: LeaseStore =
    (stores?.leases as LeaseStore | undefined) ?? new InMemoryLeaseStore();
  const inboxStore: EventInboxStore =
    (stores?.inbox as EventInboxStore | undefined) ?? new InMemoryEventInbox();
  const recoveries: OrchestrationRecoveryStore =
    (stores?.orchestratorRecoveries as OrchestrationRecoveryStore | undefined) ??
    new InMemoryOrchestrationRecoveries();

  const holder = options.holder ?? `api_${Math.random().toString(36).slice(2, 10)}`;

  let operationCount = 0;
  const guard = new IdempotencyGuard(idempotencyStore, {
    now,
    newOperationId: () =>
      `iop_${(++operationCount).toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  });
  const leases = new LeaseCoordinator(leaseStore, { now, holder });
  const inbox = new EventInbox(inboxStore, { now });

  return {
    guard,
    leases,
    inbox,
    recoveries,
    holder,
    durable: stores !== undefined,

    /**
     * One pass over the owner's open executions. A lease per execution is what
     * keeps two API instances from doing this to the same record at once, and
     * the decision is recorded before anything is changed.
     */
    async sweep(ownerRef: string): Promise<SweepResult> {
      const records = await options.executions.manager.readRecords(ownerRef, {
        openOnly: true,
        limit: RELIABILITY_LIMITS.sweepBatch,
      });
      const decisions: SweepDecision[] = [];
      const recoveredWorkers: string[] = [];
      let skipped = 0;

      for (const record of records) {
        const at = now().toISOString();
        const lease = await leases.claim(ownerRef, `execution:${record.id}`, {
          note: `sweep by ${holder}`,
        });
        if (lease === null) {
          skipped += 1;
          continue;
        }
        try {
          const workers = await options.workers.workers.list(ownerRef, { limit: 200 });
          const tasks = await options.tasks.manager.listTasks(ownerRef, { limit: 200 });
          const mine = new Set(record.workerIds);
          const taskIds = new Set(record.taskIds);
          const subjects = workers
            .filter((worker) => mine.has(worker.id))
            .map((worker) => ({
              workerId: worker.id,
              status: worker.status,
              heartbeatAgeMs:
                worker.lastHeartbeatAt === null && worker.startedAt === null
                  ? null
                  : Date.parse(at) -
                    Date.parse(worker.lastHeartbeatAt ?? worker.startedAt ?? worker.updatedAt),
            }));

          const decision = decideSweep({
            executionId: record.id,
            status: record.status,
            lastActivityAt: record.updatedAt,
            leaseHolder: null,
            leaseExpired: false,
            workers: subjects,
            tasks: tasks
              .filter((task) => taskIds.has(task.id))
              .map((task) => ({ taskId: task.id, status: task.status })),
          });
          decisions.push(decision);
          await recoveries.record({
            id: `orc_${record.id}_${at}_${Math.random().toString(36).slice(2, 6)}`,
            executionId: record.id,
            action: decision.action,
            reason: decision.reason,
            evidence: decision.evidence,
            holder,
            leaseExpired: false,
            decidedAt: at,
          });

          if (decision.action === 'leave') continue;

          // Close workers that stopped reporting, through the worker engine's own
          // rule, then let the coordinator re-derive everything from records.
          const stalled = await options.workers.manager.recoverStalled(ownerRef);
          for (const worker of stalled) {
            if (mine.has(worker.id)) recoveredWorkers.push(worker.id);
          }
          await options.executions.manager.syncLocked(ownerRef, record.id);
        } finally {
          await leases.release(ownerRef, `execution:${record.id}`).catch(() => false);
        }
      }

      return { examined: records.length, skipped, decisions, recoveredWorkers };
    },

    async health(ownerRef: string): Promise<ReliabilityHealth> {
      const at = now().toISOString();
      const executions = await options.executions.manager.readRecords(ownerRef, { limit: 200 });
      const workers = await options.workers.workers.list(ownerRef, { limit: 300 });
      const tasks = await options.tasks.manager.listTasks(ownerRef, { limit: 300 });
      const verifications = await options.verification.store.list(ownerRef, {});
      const integrations =
        (await options.persistence?.stores?.changeIntegrations?.list(ownerRef, { limit: 200 })) ??
        [];
      const recoveriesList = await options.recovery.manager.list(ownerRef, {});
      const leases = await leaseStore.list(ownerRef, { limit: 200 });
      const idempotency = await idempotencyStore.list(ownerRef, { limit: 200 });
      const events = await inboxStore.list(ownerRef, { limit: 200 });

      return buildReliabilityHealth({
        at,
        durable: stores !== undefined,
        executions: executions.map((record) => ({
          executionId: record.id,
          status: record.status,
          updatedAt: record.updatedAt,
          startedAt: record.startedAt,
        })),
        workers: workers.map((worker) => ({
          workerId: worker.id,
          status: worker.status,
          attempts: worker.attempts,
          lastHeartbeatAt: worker.lastHeartbeatAt,
        })),
        tasks: tasks.map((task) => ({ taskId: task.id, status: task.status })),
        verifications: verifications.map((run) => ({
          runId: run.id,
          status: run.status,
          executed: run.evidence?.executed === true,
        })),
        integrations: integrations.map((entry) => ({
          integrationId: entry.id,
          status: entry.status,
        })),
        recoveries: recoveriesList.map((entry) => ({
          caseId: entry.id,
          status: entry.status,
          openedAt: entry.createdAt,
        })),
        leases,
        idempotency,
        events,
        staleHeartbeatMs: 90 * 1000,
        maxOpenExecutions: RELIABILITY_LIMITS.maxOpenExecutionsPerOwner,
      });
    },

    decisions(ownerRef: string, executionId?: string): Promise<readonly OrchestrationRecovery[]> {
      return recoveries.list(ownerRef, executionId === undefined ? {} : { executionId });
    },
  };
}

/** Reported by the capabilities route so the dashboard knows what to expect. */
export const RELIABILITY_CAPABILITIES = {
  idempotency: {
    header: 'Idempotency-Key',
    retentionHours: RELIABILITY_LIMITS.idempotencyRetentionMs / (60 * 60 * 1000),
    inFlightMs: RELIABILITY_LIMITS.idempotencyInFlightMs,
    scope: 'method and route, per authenticated owner',
  },
  leases: {
    ttlMs: RELIABILITY_LIMITS.leaseTtlMs,
    renew: 'per operation; the sweep claims one lease per execution',
  },
  sweep: {
    batch: RELIABILITY_LIMITS.sweepBatch,
    staleHeartbeatMs: 90 * 1000,
  },
  backpressure: {
    maxOpenExecutionsPerOwner: RELIABILITY_LIMITS.maxOpenExecutionsPerOwner,
  },
  inbox: {
    maxAttempts: RELIABILITY_LIMITS.maxInboxAttempts,
    retryBaseMs: RELIABILITY_LIMITS.inboxRetryBaseMs,
  },
  excluded: [
    'exactly-once execution: a request that dies after its side effect may be retried; the change-set and review guards refuse the duplicate application',
    'distributed consensus: coordination is one database row, not a consensus protocol',
  ],
} as const;

export { isAbandoned };
