/**
 * Recovery service (Step 48).
 *
 * The bridge between what Steps 42-46 recorded and what
 * `@veltravia/recovery-core` decides. It reads a worker's stored assignment,
 * result, verification runs, change sets and integration conflicts to build the
 * observation, so a caller cannot supply blame or widen scope. A repair is
 * started by delegating through the Step 43 worker manager with the bounded
 * plan as the assignment; nothing is written to the project from here.
 */

import {
  InMemoryRecoveryStore,
  RecoveryError,
  RecoveryManager,
  clampLimits,
  FAILURE_CATEGORIES,
  type FailureObservation,
  type FailureEvidence,
  type RecoveryCaseRecord,
  type RecoveryLimits,
  type RecoveryStore,
  type RepairAttempt,
  type VerificationSnapshot,
} from '@veltravia/recovery-core';
import type { WorkerAssignment, WorkerRecord, WorkerStore } from '@veltravia/worker-core';
import type { VerificationRunRecord, VerificationStore } from '@veltravia/verification-core';
import type { ChangeSetStore, IntegrationStore } from '@veltravia/change-integration-core';

import type { Persistence } from './persistence.js';
import type { WorkerService } from './worker-service.js';

/** Where a task's work lives, and what revision the project was at. */
export interface RecoveryProjectContext {
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly revision: string | null;
}

export interface RecoveryServiceOptions {
  readonly workers: WorkerService;
  readonly workerStore: WorkerStore;
  readonly verification: { readonly store: VerificationStore };
  readonly changeSets: ChangeSetStore;
  readonly integrations: IntegrationStore;
  /** Resolves the project context for a task, or null when it has none. */
  readonly contextFor: (ownerRef: string, taskId: string) => Promise<RecoveryProjectContext>;
  readonly persistence?: Persistence | undefined;
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

export interface RecoveryCapabilities {
  readonly durable: boolean;
  readonly limits: RecoveryLimits;
  readonly categories: readonly string[];
  readonly classifications: readonly string[];
  readonly actions: readonly string[];
  /** False when this deployment cannot create workers. */
  readonly canStartRepair: boolean;
}

export interface OpenedCase {
  readonly record: RecoveryCaseRecord;
  readonly worker: WorkerRecord;
}

export interface RepairOutcome {
  readonly record: RecoveryCaseRecord;
  readonly attemptId: string | null;
  readonly repairWorker: WorkerRecord | null;
  readonly recovered: boolean;
  readonly reason: string;
}

export interface RecoveryService {
  readonly manager: RecoveryManager;
  readonly durability: 'memory' | 'postgres';
  capabilities(): RecoveryCapabilities;
  observe(
    ownerRef: string,
    workerId: string,
  ): Promise<{ readonly worker: WorkerRecord; readonly observation: FailureObservation }>;
  open(input: {
    readonly ownerRef: string;
    readonly workerId: string;
    readonly limits?: Partial<RecoveryLimits> | undefined;
  }): Promise<OpenedCase>;
  repair(ownerRef: string, caseId: string): Promise<RepairOutcome>;
  complete(input: {
    readonly ownerRef: string;
    readonly caseId: string;
    readonly attemptId?: string | undefined;
    readonly verificationRunId: string;
    readonly changeSetId?: string | null | undefined;
    readonly summary?: string | undefined;
  }): Promise<RepairOutcome>;
}

/** Statuses a recovery case may be opened for: work that did not simply succeed. */
const RECOVERABLE_STATUSES = new Set([
  'failed',
  'timed_out',
  'cancelled',
  'blocked',
  'awaiting_review',
  'completed',
  'partially_completed',
]);

const SNAPSHOT_STATUS: Readonly<Record<string, VerificationSnapshot['status']>> = {
  passed: 'passed',
  failed: 'failed',
  incomplete: 'incomplete',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

/** Reduces a stored run to the verdict recovery is allowed to reason about. */
export function toVerificationSnapshot(run: VerificationRunRecord): VerificationSnapshot {
  const executed = run.results.filter((result) => result.status !== 'blocked');
  const failedOperations = [
    ...new Set(
      executed.filter((result) => result.status === 'failed').map((result) => result.operation),
    ),
  ];
  const evidence: FailureEvidence[] = executed.slice(0, 8).map((result) => ({
    kind: 'verification',
    ref: `${run.id}/${result.operation}`,
    detail: `${result.operation} (${result.commandId}) finished ${result.status}.`,
  }));
  return {
    runId: run.id,
    status: SNAPSHOT_STATUS[run.status] ?? 'incomplete',
    executed: executed.length > 0,
    executedCount: executed.length,
    failedOperations,
    evidence,
  };
}

function producedNames(worker: WorkerRecord): readonly string[] {
  const result = worker.result;
  if (result === null) return [];
  return result.deliverables
    .map((deliverable) => (deliverable.path === null ? deliverable.name : deliverable.path))
    .filter((name) => name.trim().length > 0);
}

export function createRecoveryService(options: RecoveryServiceOptions): RecoveryService {
  const durable = options.persistence !== undefined;
  const store: RecoveryStore =
    (options.persistence?.stores?.recovery as RecoveryStore | undefined) ??
    new InMemoryRecoveryStore();
  const manager = new RecoveryManager({
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.generateId === undefined ? {} : { generateId: options.generateId }),
  });
  const limits = clampLimits(null);

  async function observe(ownerRef: string, workerId: string) {
    const worker = await options.workerStore.read(ownerRef, workerId);
    if (worker === null) {
      throw new RecoveryError('RECOVERY_INPUT_INVALID', 'No such worker.', 400);
    }
    const assignment = worker.assignment as WorkerAssignment;
    const context = await options.contextFor(ownerRef, worker.taskId);

    const runs = await options.verification.store.list(ownerRef, { workerId, limit: 10 });
    const latestRun = runs.length === 0 ? undefined : runs[runs.length - 1];

    const changeSets = await options.changeSets.list(ownerRef, { workerId, limit: 10 });
    const changeSetIds = new Set(changeSets.map((set) => set.id));
    const integrations =
      context.projectId === null
        ? []
        : await options.integrations.list(ownerRef, { projectId: context.projectId, limit: 20 });
    const conflicts = integrations
      .filter(
        (record) =>
          record.changeSetIds.some((id) => changeSetIds.has(id)) &&
          (record.conflicts.length > 0 || record.status === 'needs_review'),
      )
      .slice(0, 5)
      .map((record) => ({
        changeSetId: record.changeSetIds[0] ?? '',
        kinds: [...new Set(record.conflicts.map((conflict) => conflict.kind))],
        detail: record.conflicts[0]?.message ?? `The integration is ${record.status}.`,
      }));

    const reviewChecks = worker.review?.checks ?? null;
    const observation: FailureObservation = {
      projectId: context.projectId ?? '',
      taskId: worker.taskId,
      workerId: worker.id,
      workerType: worker.workerType,
      workerStatus: worker.status as FailureObservation['workerStatus'],
      failure:
        worker.failure === null
          ? null
          : {
              code: worker.failure.code,
              message: worker.failure.message,
              retryable: worker.failure.retryable,
            },
      declaration: {
        deliverables: assignment.deliverables
          .map((deliverable) => deliverable.path ?? deliverable.name)
          .filter((name) => name.trim().length > 0),
        acceptanceCriteria: [...assignment.acceptanceCriteria],
        scope: [...assignment.scope],
        allowedTools: [...assignment.allowedTools],
        permissions: { ...assignment.permissions },
        limits: {
          maxDurationMs: assignment.limits.maxDurationMs,
          maxToolCalls: assignment.limits.maxToolCalls,
          maxDeliverables: assignment.limits.maxDeliverables,
        },
        checkpoints: [...assignment.checkpoints],
        cancellationConditions: [...assignment.cancellationConditions],
        reporting: [...assignment.reporting],
      },
      produced: {
        deliverables: producedNames(worker),
        criteriaMet:
          reviewChecks === null ? null : reviewChecks.filter((check) => check.passed).length,
        summary: worker.result?.summary ?? null,
        simulated: worker.result?.simulated === true,
      },
      attempts: worker.attempts,
      // Only a refused review is a "refusal"; an accepted one is not evidence.
      reviewRefusals:
        worker.review === null || worker.review.decision === 'accept'
          ? []
          : worker.review.checks
              .filter((check) => !check.passed)
              .map((check) => `${check.name}: ${check.detail}`),
      verification: latestRun === undefined ? null : toVerificationSnapshot(latestRun),
      conflicts,
      toolErrors: [],
      // The project revision at failure time was not recorded on the worker, so
      // it is honestly null; the plan re-validates against the live revision.
      revision: { atStart: null, now: context.revision },
      previousAttempts: [],
    };
    return { worker, observation };
  }

  return {
    manager,
    durability: durable ? 'postgres' : 'memory',
    capabilities: () => ({
      durable,
      limits,
      categories: FAILURE_CATEGORIES,
      classifications: ['temporary', 'permanent', 'policy', 'needs_human'],
      actions: ['retry_same_worker', 'reassign_worker', 'escalate'],
      canStartRepair: true,
    }),
    observe,
    async open(input) {
      const { worker, observation } = await observe(input.ownerRef, input.workerId);
      if (!RECOVERABLE_STATUSES.has(worker.status)) {
        throw new RecoveryError(
          'RECOVERY_INPUT_INVALID',
          `Worker ${worker.id} is ${worker.status}; a recovery case is opened for work that did not simply succeed.`,
          400,
        );
      }
      const record = await manager.detect({
        ownerRef: input.ownerRef,
        observation,
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      });
      return { record, worker };
    },
    async repair(ownerRef, caseId) {
      const current = await manager.inspect(ownerRef, caseId);
      const context = await options.contextFor(ownerRef, current.taskId);
      const plan = await manager.plan(ownerRef, caseId, { currentRevision: context.revision });
      const assignment: WorkerAssignment = {
        objective: plan.objective,
        scope: [...plan.scope],
        exclusions: [...plan.exclusions],
        deliverables: plan.deliverables.map((deliverable) => ({
          name: deliverable.name,
          kind: deliverable.kind,
          path: deliverable.path,
          summary: deliverable.summary,
        })),
        acceptanceCriteria: [...plan.acceptanceCriteria],
        allowedTools: [...plan.allowedTools],
        permissions: { ...plan.permissions },
        limits: plan.limits,
        dependencies: [],
        checkpoints: [...plan.checkpoints],
        cancellationConditions: [...plan.cancellationConditions],
        reporting: [...plan.reporting],
        primaryRunId: null,
      };

      // A repair is separate work, so it gets its own task under the failed
      // one. The original task keeps its record and its awaiting-review state,
      // and cancelling anything here would end the work instead of redoing it.
      const repairTask = await options.workers.tasks.manager.createTask(ownerRef, {
        title: `Repair: ${current.taskId}`,
        objective: plan.objective,
        projectId: context.projectId,
        workspaceId: context.workspaceId,
        parentTaskId: current.taskId,
        createdBy: 'primary_agent',
      });

      // The failed worker still claims its scope, and a claim is what stops a
      // second worker from taking the same paths. Retiring it is part of the
      // repair: submitted work at review is refused, anything still live is
      // cancelled. Neither action pretends the work succeeded.
      // A failed worker is not terminal in Step 43 (it can be requeued), so it
      // keeps its resource claims - and those claims are what stop a repair
      // from taking the same paths. The origin is therefore cancelled, which is
      // accurate: that unit of work is superseded, and the repair is tracked as
      // a child task of it. Nothing is reported as succeeded either way.
      const origin = await options.workerStore.read(ownerRef, current.workerId ?? '');
      if (origin !== null && !['completed', 'cancelled'].includes(origin.status)) {
        await options.workers.manager
          .cancel(ownerRef, origin.id, 'Superseded by a governed repair attempt.')
          .catch(() => null);
      }

      let repairWorker: WorkerRecord;
      try {
        repairWorker = await options.workers.manager.delegate(ownerRef, {
          taskId: repairTask.id,
          workerType: plan.workerType,
          assignment,
        });
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'The worker manager refused the delegation.';
        const escalated = await manager.escalate({
          ownerRef,
          caseId,
          reason: 'needs_human',
          message: `The repair could not be delegated: ${reason}`,
        });
        return { record: escalated, attemptId: null, repairWorker: null, recovered: false, reason };
      }

      const started = await manager.startAttempt({
        ownerRef,
        caseId,
        action: plan.action,
        workerId: repairWorker.id,
        workerType: repairWorker.workerType,
      });

      let finishedWorker: WorkerRecord;
      try {
        finishedWorker = await options.workers.manager.start(ownerRef, repairWorker.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The repair worker did not start.';
        const finished = await manager.finishAttempt({
          ownerRef,
          caseId,
          attemptId: started.attempt.id,
          outcome: 'failed',
          summary: message,
        });
        return {
          record: finished.record,
          attemptId: started.attempt.id,
          repairWorker,
          recovered: finished.recovered,
          reason: message,
        };
      }

      const observed = await observe(ownerRef, finishedWorker.id);
      // A repair "succeeded" only in the sense that the worker finished its
      // work; whether recovery happened is decided by the evidence below.
      const succeeded =
        finishedWorker.status === 'awaiting_review' || finishedWorker.status === 'completed';
      const finished = await manager.finishAttempt({
        ownerRef,
        caseId,
        attemptId: started.attempt.id,
        outcome: succeeded ? 'succeeded' : 'failed',
        summary: finishedWorker.result?.summary ?? `The repair worker is ${finishedWorker.status}.`,
        verification: observed.observation.verification,
        changeSetId: null,
        integrated: false,
        ...(context.revision === null ? {} : { currentRevision: context.revision }),
      });
      return {
        record: finished.record,
        attemptId: started.attempt.id,
        repairWorker: finishedWorker,
        recovered: finished.recovered,
        reason: finished.reason,
      };
    },
    async complete(input) {
      const record = await manager.inspect(input.ownerRef, input.caseId);
      const attempts = await manager.attempts(input.ownerRef, input.caseId);
      // Evidence is checked before the attempt is looked at: a claim of a run
      // that does not exist is refused for what it is, not misreported as a
      // missing attempt.
      const run = await options.verification.store.get(input.ownerRef, input.verificationRunId);
      if (run === null) {
        throw new RecoveryError(
          'RECOVERY_VERIFICATION_REQUIRED',
          'That verification run does not exist for this owner.',
          409,
        );
      }
      const running = attempts.filter((attempt) => attempt.outcome === 'running');
      const attempt: RepairAttempt | undefined =
        input.attemptId === undefined
          ? (running[running.length - 1] ?? attempts[attempts.length - 1])
          : attempts.find((item) => item.id === input.attemptId);
      if (attempt === undefined) {
        throw new RecoveryError(
          'RECOVERY_INPUT_INVALID',
          'This case has no repair attempt to attach evidence to.',
          400,
        );
      }
      const changeSetId = input.changeSetId ?? attempt.changeSetId ?? null;
      let integrated = false;
      if (changeSetId !== null) {
        const changeSet = await options.changeSets.get(input.ownerRef, changeSetId);
        integrated = changeSet !== null && changeSet.status === 'integrated';
      }
      const finished = await manager.finishAttempt({
        ownerRef: input.ownerRef,
        caseId: record.id,
        attemptId: attempt.id,
        outcome: 'succeeded',
        summary: input.summary ?? `Verification run ${run.id} is ${run.status}.`,
        verification: toVerificationSnapshot(run),
        changeSetId,
        integrated,
      });
      return {
        record: finished.record,
        attemptId: attempt.id,
        repairWorker: null,
        recovered: finished.recovered,
        reason: finished.reason,
      };
    },
  };
}
