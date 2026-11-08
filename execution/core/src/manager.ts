/**
 * The Primary Agent's coordinator.
 *
 * It owns the plan, the task graph and the delivery report. It owns no worker
 * lifecycle, no verification, no change integration and no recovery: those are
 * ports, and every decision that changes them goes through the engine that
 * already enforces its own rules.
 */

import { buildPlan, canRunTogether, revisePlan } from './plan.js';
import { buildDeliveryReport, computeProgress } from './progress.js';
import type { ExecutionStore } from './store.js';
import type {
  DeliveryReport,
  ExecutionEvidence,
  ExecutionPlan,
  ExecutionProgress,
  ExecutionRecord,
  ExecutionRequest,
  ExecutionStatus,
  ExecutionApproval,
  PlannedTask,
  ProjectFacts,
  TaskFacts,
  ChangeSetFacts,
  RecoveryFacts,
  VerificationFacts,
  WorkerFacts,
} from './types.js';

export class ExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

/**
 * The one place a coordinator error code becomes an HTTP status. A route that
 * maps codes by hand drifts from the engine, and a new code then surfaces as a
 * 500 instead of the refusal it is.
 */
const EXECUTION_STATUS: Readonly<Record<string, number>> = {
  EXECUTION_NOT_FOUND: 404,
  EXECUTION_TASK_NOT_FOUND: 404,
  EXECUTION_CLOSED: 409,
  EXECUTION_EVIDENCE_REQUIRED: 409,
  EXECUTION_APPROVAL_REQUIRED: 409,
  EXECUTION_NOTHING_TO_INTEGRATE: 409,
  EXECUTION_WORKER_NOT_FOUND: 409,
  EXECUTION_REQUEST_TOO_SHORT: 400,
  EXECUTION_REVISION_REASON_REQUIRED: 400,
  EXECUTION_PROJECT_UNAVAILABLE: 422,
  EXECUTION_PROJECT_NOT_FOUND: 404,
  EXECUTION_APPROVAL_NOT_FOUND: 404,
  EXECUTION_BUSY: 409,
  EXECUTION_BACKPRESSURE: 429,
};

/** Status for a coordinator error code; unknown codes are a plain 400. */
export function executionHttpStatus(code: string): number {
  return EXECUTION_STATUS[code] ?? 400;
}

export interface ExecutionPorts {
  /** Reads the project without changing it. */
  readonly inspect: (ownerRef: string, projectId: string) => Promise<ProjectFacts>;
  /** Creates a task in the existing task engine and returns its real id. */
  readonly createTask: (input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly workspaceId: string | null;
    readonly title: string;
    readonly objective: string;
    readonly dependencies: readonly string[];
    readonly acceptance: readonly string[];
  }) => Promise<string>;
  readonly cancelTask: (ownerRef: string, taskId: string, reason: string) => Promise<void>;
  readonly tasks: (ownerRef: string, taskIds: readonly string[]) => Promise<readonly TaskFacts[]>;
  readonly delegateWorker: (input: {
    readonly ownerRef: string;
    readonly taskId: string;
    readonly workerType: string;
    readonly assignment: unknown;
  }) => Promise<string>;
  readonly startWorker: (ownerRef: string, workerId: string) => Promise<void>;
  readonly cancelWorker: (ownerRef: string, workerId: string, reason: string) => Promise<void>;
  /** Accept or refuse a worker's submitted work through the Step 43 review gate. */
  readonly reviewWorker: (
    ownerRef: string,
    workerId: string,
    decision: 'accept' | 'reject',
    note: string,
  ) => Promise<void>;
  readonly workers: (
    ownerRef: string,
    workerIds: readonly string[],
  ) => Promise<readonly WorkerFacts[]>;
  readonly verifications: (
    ownerRef: string,
    projectId: string,
    taskIds: readonly string[],
  ) => Promise<readonly VerificationFacts[]>;
  readonly changeSets: (input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly changeSetId?: string;
    readonly taskIds: readonly string[];
  }) => Promise<readonly ChangeSetFacts[]>;
  readonly integrateChangeSet: (ownerRef: string, changeSetId: string) => Promise<void>;
  readonly recoveries: (
    ownerRef: string,
    projectId: string,
    taskIds: readonly string[],
  ) => Promise<readonly RecoveryFacts[]>;
  /** Opens a recovery case for a worker that did not finish, through Step 48. */
  readonly openRecovery: (ownerRef: string, workerId: string) => Promise<string>;
}

/**
 * Coordination between API instances. The coordinator itself has no opinion
 * about how a resource is claimed: it asks this port to run a section under a
 * lease, and refuses the operation when another holder owns it. Without the port
 * the coordinator runs single-process, which is what the tests use.
 */
export interface ExecutionCoordination {
  run<T>(
    ownerRef: string,
    resource: string,
    work: () => Promise<T>,
  ): Promise<{ readonly held: true; readonly value: T } | { readonly held: false }>;
}

export interface ExecutionManagerOptions {
  readonly store: ExecutionStore;
  readonly coordination?: ExecutionCoordination;
  /** Open executions one owner may have at once before intake is refused. */
  readonly maxOpenExecutions?: number;
  readonly ports: ExecutionPorts;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  /** Deployment ceiling for concurrent workers, never widened at the call site. */
  readonly maxConcurrent?: number;
}

export interface ExecutionView {
  readonly execution: ExecutionRecord;
  readonly plan: ExecutionPlan;
  readonly progress: ExecutionProgress;
}

const OPEN_STATUSES: readonly ExecutionStatus[] = [
  'planning',
  'awaiting_approval',
  'executing',
  'verifying',
  'integrating',
];

export class ExecutionManager {
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly maxConcurrent: number;
  private readonly maxOpenExecutions: number;
  private coordination: ExecutionCoordination | undefined;

  constructor(private readonly options: ExecutionManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.generateId =
      options.generateId ?? (() => `exe_${Math.random().toString(36).slice(2, 11)}`);
    this.maxConcurrent = Math.min(Math.max(options.maxConcurrent ?? 3, 1), 6);
    this.maxOpenExecutions = Math.min(Math.max(options.maxOpenExecutions ?? 10, 1), 50);
    this.coordination = options.coordination;
  }

  /** Intake: inspect, plan, and create the task graph. Nothing is started yet. */
  async start(input: {
    readonly ownerRef: string;
    readonly text: string;
    readonly projectId: string;
    readonly workspaceId?: string | null;
    readonly maxConcurrent?: number;
  }): Promise<ExecutionView> {
    const text = input.text.trim();
    if (text.length < 8) {
      throw new ExecutionError(
        'EXECUTION_REQUEST_TOO_SHORT',
        'Describe what you want built or changed, in a sentence or two.',
      );
    }
    // Backpressure: an owner with many executions already open is told so
    // rather than being allowed to pile on more work nothing is draining.
    const open = await this.options.store.listExecutions(input.ownerRef, {
      openOnly: true,
      limit: 200,
    });
    if (open.length >= this.maxOpenExecutions) {
      throw new ExecutionError(
        'EXECUTION_BACKPRESSURE',
        `You already have ${open.length} executions open. Finish or cancel one before starting another.`,
        429,
      );
    }

    let facts;
    try {
      facts = await this.options.ports.inspect(input.ownerRef, input.projectId);
    } catch {
      // The inspector answers "not found" for a foreign project and for a
      // missing one alike, and both read the same way to the caller.
      throw new ExecutionError(
        'EXECUTION_PROJECT_UNAVAILABLE',
        'That project is not available to this owner.',
        404,
      );
    }
    const at = this.now().toISOString();
    const reasons = approvalReasonsFor(text);

    const request: ExecutionRequest = {
      text,
      projectId: input.projectId,
      workspaceId: input.workspaceId ?? null,
      requiresApproval: reasons.length > 0,
      approvalReasons: reasons,
      receivedAt: at,
    };

    const plan = buildPlan({ request, facts, createdAt: at });
    const records = await this.createTasks(input.ownerRef, request, plan);

    const approvals: ExecutionApproval[] = plan.tasks
      .filter((task) => task.approval !== null && task.taskId === null)
      .map((task) => ({
        id: this.generateId(),
        kind: 'task' as const,
        taskKey: task.key,
        reason: `${task.title}: ${task.approval ?? ''}`.trim(),
        state: 'pending' as const,
        requestedAt: at,
        decidedAt: null,
        decidedBy: null,
        note: null,
      }));

    const record: ExecutionRecord = {
      id: this.generateId(),
      ownerRef: input.ownerRef,
      projectId: input.projectId,
      workspaceId: input.workspaceId ?? null,
      status: approvals.length > 0 ? 'awaiting_approval' : 'executing',
      request,
      plan: records.plan,
      revisions: [records.plan],
      approvals,
      taskIds: records.plan.tasks.flatMap((task) => (task.taskId === null ? [] : [task.taskId])),
      workerIds: [],
      recoveryCaseIds: [],
      changeSetIds: [],
      maxConcurrent: Math.min(
        Math.max(input.maxConcurrent ?? this.maxConcurrent, 1),
        this.maxConcurrent,
      ),
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
      stoppedReason: null,
      version: 1,
    };
    await this.options.store.insertExecution(record);
    return this.view(record, record.plan);
  }

  async get(ownerRef: string, executionId: string): Promise<ExecutionView> {
    const record = await this.requireExecution(ownerRef, executionId);
    const progress = await this.progressOf(record);
    return { execution: record, plan: record.plan, progress: progress.progress };
  }

  async list(
    ownerRef: string,
    filter: {
      readonly projectId?: string;
      readonly openOnly?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<readonly ExecutionView[]> {
    const records = await this.options.store.listExecutions(ownerRef, filter);
    const views: ExecutionView[] = [];
    for (const record of records) {
      const progress = await this.progressOf(record);
      views.push({ execution: record, plan: record.plan, progress: progress.progress });
    }
    return views;
  }

  /**
   * Run a section of work under this execution's coordination lease.
   *
   * Without a coordination port the coordinator is single-process and the work
   * simply runs. With one, a second process asking for the same execution is
   * told so (409) instead of both of them writing the record, which is how two
   * API instances used to fight over one execution after a restart.
   */
  private async guarded<T>(
    ownerRef: string,
    executionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const coordination = this.coordination;
    if (coordination === undefined) return work();
    const outcome = await coordination.run(ownerRef, `execution:${executionId}`, work);
    if (!outcome.held) {
      throw new ExecutionError(
        'EXECUTION_BUSY',
        'Another process is advancing this execution right now. Read it again in a moment.',
        409,
      );
    }
    return outcome.value;
  }

  /**
   * Attach coordination after construction.
   *
   * The reliability service needs this coordinator to exist (its sweep reads
   * executions), and this coordinator needs the service's leases, so the lease
   * port is attached once both exist. Single-process callers never attach one.
   */
  useCoordination(coordination: ExecutionCoordination | undefined): void {
    this.coordination = coordination;
  }

  /** A closed execution keeps the decision that closed it. */
  private assertOpen(record: ExecutionRecord, action: string): void {
    if (['completed', 'cancelled', 'failed'].includes(record.status)) {
      throw new ExecutionError(
        'EXECUTION_CLOSED',
        `This execution is ${record.status}, so it cannot ${action}.`,
        409,
      );
    }
  }

  /**
   * Dispatch ready tasks to workers. Ready means: dependencies finished, the
   * task exists, the owner has approved anything that needed approval, the
   * concurrency ceiling is not reached, and no running task writes the same
   * paths. The worker claims enforce the last point as well; this is the
   * planner declining to propose something the scheduler will refuse.
   */
  async dispatch(
    ownerRef: string,
    executionId: string,
  ): Promise<ExecutionView & { readonly dispatched: readonly string[] }> {
    return this.guarded(ownerRef, executionId, () => this.dispatchLocked(ownerRef, executionId));
  }

  private async dispatchLocked(
    ownerRef: string,
    executionId: string,
  ): Promise<ExecutionView & { readonly dispatched: readonly string[] }> {
    const record = await this.requireExecution(ownerRef, executionId);
    if (!OPEN_STATUSES.includes(record.status)) {
      throw new ExecutionError(
        'EXECUTION_CLOSED',
        `This execution is ${record.status}; no task may start.`,
        409,
      );
    }

    const progress = await this.progressOf(record);
    const workers = await this.options.ports.workers(ownerRef, record.workerIds);
    const activeWorkers = workers.filter((worker) =>
      ['queued', 'assigned', 'starting', 'running'].includes(worker.status),
    );
    let slots = record.maxConcurrent - activeWorkers.length;

    const dispatched: string[] = [];
    const busyScopes: PlannedTask[] = record.plan.tasks.filter((task) =>
      activeWorkers.some((worker) => worker.taskId === task.taskId),
    );

    for (const line of progress.progress.tasks) {
      if (slots <= 0) break;
      if (line.status !== 'ready') continue;
      const task = record.plan.tasks.find((entry) => entry.key === line.key);
      if (task === undefined || task.taskId === null) continue;
      if (task.approval !== null && record.approvals.some((entry) => entry.state !== 'approved')) {
        continue;
      }
      if (busyScopes.some((busy) => !canRunTogether(busy, task))) continue;

      const assignment = {
        objective: task.objective,
        scope: task.scope,
        exclusions: task.exclusions,
        // A planned deliverable is what the task should hand back, not a file
        // path invented before the code was read. The file names live in
        // `scope`, which the worker's own tool authorisation enforces; naming a
        // path here would be a guess the worker manager then refuses.
        deliverables: task.deliverables.map((name) => ({
          name,
          kind: 'report' as const,
          path: null,
          summary: name,
        })),
        acceptanceCriteria: task.acceptanceCriteria,
        allowedTools: task.allowedTools,
        permissions: {
          readProject: true,
          writeProject: task.allowedTools.includes('project.write'),
          runTools: task.allowedTools.includes('tests.run'),
          network: false,
        },
        limits: {
          maxDurationMs: 120_000,
          maxToolCalls: Math.min(20, 6 + task.complexity * 3),
          maxDeliverables: 6,
        },
        dependencies: [],
        checkpoints: ['after the first deliverable'],
        cancellationConditions: ['the owner cancels the execution'],
        reporting: ['list the files written'],
        primaryRunId: null,
      };

      try {
        const workerId = await this.options.ports.delegateWorker({
          ownerRef,
          taskId: task.taskId,
          workerType: task.workerType,
          assignment,
        });
        await this.options.ports.startWorker(ownerRef, workerId);
        dispatched.push(workerId);
        busyScopes.push(task);
        slots -= 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The worker manager refused.';
        const next = await this.save(
          {
            ...record,
            status: 'blocked',
            stoppedReason: `A task could not be assigned: ${message}`,
            updatedAt: this.now().toISOString(),
          },
          record.version,
        );
        return { ...(await this.view(next, next.plan)), dispatched };
      }
    }

    const next: ExecutionRecord = {
      ...record,
      workerIds: [...record.workerIds, ...dispatched],
      updatedAt: this.now().toISOString(),
    };
    const saved = await this.save(next, record.version);
    return { ...(await this.view(saved, saved.plan)), dispatched };
  }

  /**
   * Re-read every linked record, open a recovery case for a worker that failed
   * and has none yet, and store the derived status. This is the only place a
   * worker failure turns into recovery work.
   */
  async sync(ownerRef: string, executionId: string): Promise<ExecutionView> {
    return this.guarded(ownerRef, executionId, () => this.syncLocked(ownerRef, executionId));
  }

  /**
   * Reconcile without taking the lease. Only a caller that already holds the
   * execution's lease may use this: the sweep does, so that one pass over an
   * execution is one claim rather than a claim inside a claim.
   */
  /**
   * The stored records themselves, without building a view.
   *
   * The view is what a person reads; a sweep or a health count needs the row and
   * must not pay for progress computation on two hundred of them.
   */
  async readRecords(
    ownerRef: string,
    filter: { readonly openOnly?: boolean; readonly limit?: number } = {},
  ): Promise<readonly ExecutionRecord[]> {
    return this.options.store.listExecutions(ownerRef, {
      openOnly: filter.openOnly === true,
      limit: Math.min(Math.max(filter.limit ?? 200, 1), 500),
    });
  }

  async syncLocked(ownerRef: string, executionId: string): Promise<ExecutionView> {
    const record = await this.requireExecution(ownerRef, executionId);
    const evidence = await this.evidenceFor(record);
    const progress = computeProgress({
      record,
      plan: record.plan,
      evidence,
      at: this.now().toISOString(),
    });

    const recoveryCaseIds = [...record.recoveryCaseIds];
    if (OPEN_STATUSES.includes(record.status) || record.status === 'partially_completed') {
      for (const worker of evidence.workers) {
        const dead = ['failed', 'timed_out'].includes(worker.status);
        if (!dead) continue;
        if (evidence.recoveries.some((entry) => entry.workerId === worker.workerId)) continue;
        try {
          const caseId = await this.options.ports.openRecovery(ownerRef, worker.workerId);
          recoveryCaseIds.push(caseId);
        } catch {
          // A case the engine refuses to open (for example a worker that did not
          // actually fail the way it looked) is not an error the owner must fix;
          // the failure is already visible on the task.
        }
      }
    }

    const finished = progress.status;
    const terminal = [
      'completed',
      'partially_completed',
      'blocked',
      'failed',
      'cancelled',
    ].includes(finished);
    const next: ExecutionRecord = {
      ...record,
      status: finished,
      recoveryCaseIds: [...new Set(recoveryCaseIds)],
      finishedAt:
        terminal && record.finishedAt === null ? this.now().toISOString() : record.finishedAt,
      updatedAt: this.now().toISOString(),
      stoppedReason: terminal
        ? (progress.outstanding[0] ?? record.stoppedReason)
        : record.stoppedReason,
    };
    const saved =
      next.status === record.status && next.recoveryCaseIds.length === record.recoveryCaseIds.length
        ? record
        : await this.save(next, record.version);
    return this.view(saved, saved.plan);
  }

  /** Accept or refuse a worker's submitted work, through the existing gate. */
  async review(
    ownerRef: string,
    executionId: string,
    taskId: string,
    decision: 'accept' | 'reject',
    note: string,
  ): Promise<ExecutionView> {
    return this.guarded(ownerRef, executionId, () =>
      this.reviewLocked(ownerRef, executionId, taskId, decision, note),
    );
  }

  private async reviewLocked(
    ownerRef: string,
    executionId: string,
    taskId: string,
    decision: 'accept' | 'reject',
    note: string,
  ): Promise<ExecutionView> {
    const record = await this.requireExecution(ownerRef, executionId);
    // Work cannot be accepted after the execution was closed: the closure
    // already decided the outcome for every task in it.
    this.assertOpen(record, 'review work');
    if (!record.taskIds.includes(taskId)) {
      throw new ExecutionError(
        'EXECUTION_TASK_NOT_FOUND',
        'That task is not part of this execution.',
        404,
      );
    }
    const workers = await this.options.ports.workers(ownerRef, record.workerIds);
    const worker = workers.find((entry) => entry.taskId === taskId);
    if (worker === undefined) {
      throw new ExecutionError(
        'EXECUTION_WORKER_NOT_FOUND',
        'No worker has been assigned to that task yet.',
        409,
      );
    }
    if (decision === 'accept') {
      const planned = record.plan.tasks.find((entry) => entry.taskId === taskId);
      const needsProof = planned === undefined || planned.verification !== 'none';
      const progress = await this.progressOf(record);
      const line = progress.progress.tasks.find((entry) => entry.taskId === taskId);
      if (needsProof && line?.verified !== true) {
        throw new ExecutionError(
          'EXECUTION_EVIDENCE_REQUIRED',
          line?.note ?? 'No stored passing verification run covers this work yet.',
          409,
        );
      }
    }
    // The worker review gate still runs: this names the decision, it does not
    // vouch for the work.
    await this.options.ports.reviewWorker(ownerRef, worker.workerId, decision, note);
    return this.syncLocked(ownerRef, executionId);
  }

  /** Integrate accepted change sets through Step 46. Nothing is merged here. */
  async integrate(ownerRef: string, executionId: string): Promise<ExecutionView> {
    return this.guarded(ownerRef, executionId, () => this.integrateLocked(ownerRef, executionId));
  }

  private async integrateLocked(ownerRef: string, executionId: string): Promise<ExecutionView> {
    const record = await this.requireExecution(ownerRef, executionId);
    this.assertOpen(record, 'integrate changes');
    const changeSets = await this.options.ports.changeSets({
      ownerRef,
      projectId: record.projectId,
      taskIds: record.taskIds,
    });
    const integrable = changeSets.filter((set) => set.status === 'approved');
    if (integrable.length === 0) {
      throw new ExecutionError(
        'EXECUTION_NOTHING_TO_INTEGRATE',
        'No approved change set is waiting for integration.',
        409,
      );
    }
    const integrated: string[] = [];
    for (const set of integrable) {
      try {
        await this.options.ports.integrateChangeSet(ownerRef, set.changeSetId);
        integrated.push(set.changeSetId);
      } catch {
        // One refusal does not discard the others; the record keeps what landed.
        continue;
      }
    }
    const fresh = await this.requireExecution(ownerRef, executionId);
    const saved = await this.save(
      {
        ...fresh,
        changeSetIds: [...new Set([...fresh.changeSetIds, ...integrated])],
        updatedAt: this.now().toISOString(),
      },
      fresh.version,
    );
    return this.syncLocked(ownerRef, saved.id);
  }

  /** Approve or refuse work that needed the owner's decision. */
  async decide(
    ownerRef: string,
    executionId: string,
    approvalId: string,
    decision: 'approved' | 'refused',
    note: string,
  ): Promise<ExecutionView> {
    const record = await this.requireExecution(ownerRef, executionId);
    const approval = record.approvals.find((entry) => entry.id === approvalId);
    if (approval === undefined) {
      throw new ExecutionError('EXECUTION_APPROVAL_NOT_FOUND', 'No such approval request.', 404);
    }
    if (approval.state !== 'pending') {
      throw new ExecutionError(
        'EXECUTION_APPROVAL_DECIDED',
        `That approval was already ${approval.state}.`,
        409,
      );
    }
    const at = this.now().toISOString();
    const approvals = record.approvals.map((entry) =>
      entry.id === approvalId
        ? { ...entry, state: decision, decidedAt: at, decidedBy: ownerRef, note }
        : entry,
    );
    const next: ExecutionRecord = {
      ...record,
      approvals,
      status: decision === 'refused' ? 'blocked' : record.status,
      stoppedReason:
        decision === 'refused' ? 'The owner refused a required approval.' : record.stoppedReason,
      updatedAt: at,
    };
    const saved = await this.save(next, record.version);
    return this.view(saved, saved.plan);
  }

  /**
   * Revise the plan. The previous version stays in the record, the new one says
   * why it exists, and any task whose objective leaves the original request is
   * marked for approval instead of quietly running.
   */
  async revise(
    ownerRef: string,
    executionId: string,
    input: {
      readonly reason: string;
      readonly add?: readonly Omit<PlannedTask, 'taskId'>[];
      readonly remove?: readonly string[];
      readonly dependsOn?: Readonly<Record<string, readonly string[]>>;
      readonly scopeChange?: string;
    },
  ): Promise<ExecutionView> {
    return this.guarded(ownerRef, executionId, () =>
      this.reviseLocked(ownerRef, executionId, input),
    );
  }

  private async reviseLocked(
    ownerRef: string,
    executionId: string,
    input: {
      readonly reason: string;
      readonly add?: readonly Omit<PlannedTask, 'taskId'>[];
      readonly remove?: readonly string[];
      readonly dependsOn?: Readonly<Record<string, readonly string[]>>;
      readonly scopeChange?: string;
    },
  ): Promise<ExecutionView> {
    const record = await this.requireExecution(ownerRef, executionId);
    this.assertOpen(record, 'change its plan');
    if (input.reason.trim().length < 8) {
      throw new ExecutionError(
        'EXECUTION_REVISION_REASON_REQUIRED',
        'Say why the plan is changing.',
      );
    }
    const at = this.now().toISOString();
    // Only work that has a worker is protected from removal; a task that never
    // started can leave the plan with its record and nothing running behind it.
    const workers =
      record.workerIds.length === 0
        ? []
        : await this.options.ports.workers(ownerRef, record.workerIds);
    const startedKeys = record.plan.tasks
      .filter(
        (task) => task.taskId !== null && workers.some((worker) => worker.taskId === task.taskId),
      )
      .map((task) => task.key);
    const plan = revisePlan({
      plan: record.plan,
      startedKeys,
      reason: input.reason.trim(),
      change: {
        ...(input.add === undefined ? {} : { add: input.add }),
        ...(input.remove === undefined ? {} : { remove: input.remove }),
        ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
      },
      createdAt: at,
    });
    const scopeChange = input.scopeChange?.trim() ?? '';
    const widened = scopeChange.length > 0;
    const approvals: readonly ExecutionApproval[] = widened
      ? [
          ...record.approvals,
          {
            id: this.generateId(),
            kind: 'scope_change' as const,
            taskKey: null,
            reason: scopeChange,
            state: 'pending',
            requestedAt: at,
            decidedAt: null,
            decidedBy: null,
            note: null,
          },
        ]
      : record.approvals;
    for (const key of input.remove ?? []) {
      const removed = record.plan.tasks.find((task) => task.key === key);
      if (removed?.taskId != null) {
        await this.options.ports
          .cancelTask(ownerRef, removed.taskId, `Removed by plan revision: ${input.reason.trim()}`)
          .catch(() => undefined);
      }
    }
    const created = await this.createTasks(ownerRef, record.request, plan);
    const next: ExecutionRecord = {
      ...record,
      plan: created.plan,
      approvals,
      revisions: [...record.revisions, created.plan],
      taskIds: [
        ...new Set([
          ...record.taskIds,
          ...created.plan.tasks.flatMap((task) => (task.taskId === null ? [] : [task.taskId])),
        ]),
      ],
      status: widened
        ? 'awaiting_approval'
        : OPEN_STATUSES.includes(record.status)
          ? 'executing'
          : record.status,
      updatedAt: at,
    };
    const saved = await this.save(next, record.version);
    return this.view(saved, saved.plan);
  }

  /** Cancel everything this execution owns. Workers and tasks are asked, not assumed. */
  async cancel(ownerRef: string, executionId: string, reason: string): Promise<ExecutionView> {
    return this.guarded(ownerRef, executionId, () =>
      this.cancelLocked(ownerRef, executionId, reason),
    );
  }

  private async cancelLocked(
    ownerRef: string,
    executionId: string,
    reason: string,
  ): Promise<ExecutionView> {
    const record = await this.requireExecution(ownerRef, executionId);
    if (['completed', 'cancelled'].includes(record.status)) {
      throw new ExecutionError('EXECUTION_CLOSED', `This execution is ${record.status}.`, 409);
    }
    for (const workerId of record.workerIds) {
      await this.options.ports.cancelWorker(ownerRef, workerId, reason).catch(() => undefined);
    }
    for (const taskId of record.taskIds) {
      await this.options.ports.cancelTask(ownerRef, taskId, reason).catch(() => undefined);
    }
    const at = this.now().toISOString();
    const next: ExecutionRecord = {
      ...record,
      status: 'cancelled',
      stoppedReason: reason,
      finishedAt: at,
      updatedAt: at,
    };
    const saved = await this.save(next, record.version);
    return this.view(saved, saved.plan);
  }

  async report(ownerRef: string, executionId: string): Promise<DeliveryReport> {
    const record = await this.requireExecution(ownerRef, executionId);
    const evidence = await this.evidenceFor(record);
    const at = this.now().toISOString();
    const progress = computeProgress({ record, plan: record.plan, evidence, at });
    return buildDeliveryReport({ record, plan: record.plan, progress, evidence, at });
  }

  /** Every open execution, re-read and re-derived. Used after a restart. */
  async resume(ownerRef: string): Promise<readonly ExecutionView[]> {
    const records = await this.options.store.listExecutions(ownerRef, { openOnly: true });
    const views: ExecutionView[] = [];
    for (const record of records) views.push(await this.sync(ownerRef, record.id));
    return views;
  }

  // -------------------------------------------------------------------------

  private async createTasks(
    ownerRef: string,
    request: ExecutionRequest,
    plan: ExecutionPlan,
  ): Promise<{ readonly plan: ExecutionPlan }> {
    const byKey = new Map<string, string>();
    const tasks: PlannedTask[] = [];
    for (const task of plan.tasks) {
      if (task.taskId !== null) {
        tasks.push(task);
        byKey.set(task.key, task.taskId);
        continue;
      }
      const dependencies = task.dependsOn.flatMap((key) => {
        const id = byKey.get(key);
        return id === undefined ? [] : [id];
      });
      const taskId = await this.options.ports.createTask({
        ownerRef,
        projectId: request.projectId,
        workspaceId: request.workspaceId,
        title: task.title,
        objective: task.objective,
        dependencies,
        acceptance: task.acceptanceCriteria,
      });
      byKey.set(task.key, taskId);
      tasks.push({ ...task, taskId });
    }
    return { plan: { ...plan, tasks } };
  }

  private async evidenceFor(record: ExecutionRecord): Promise<ExecutionEvidence> {
    const [tasks, workers, verifications, changeSets, recoveries] = await Promise.all([
      this.options.ports.tasks(record.ownerRef, record.taskIds),
      this.options.ports.workers(record.ownerRef, record.workerIds),
      this.options.ports.verifications(record.ownerRef, record.projectId, record.taskIds),
      this.options.ports.changeSets({
        ownerRef: record.ownerRef,
        projectId: record.projectId,
        taskIds: record.taskIds,
      }),
      this.options.ports.recoveries(record.ownerRef, record.projectId, record.taskIds),
    ]);
    return { tasks, workers, verifications, changeSets, recoveries };
  }

  private async progressOf(record: ExecutionRecord): Promise<{ progress: ExecutionProgress }> {
    const evidence = await this.evidenceFor(record);
    const progress = computeProgress({
      record,
      plan: record.plan,
      evidence,
      at: this.now().toISOString(),
    });
    return { progress };
  }

  private async view(record: ExecutionRecord, plan: ExecutionPlan): Promise<ExecutionView> {
    const progress = await this.progressOf(record);
    return { execution: record, plan, progress: progress.progress };
  }

  private async save(record: ExecutionRecord, expectedVersion: number): Promise<ExecutionRecord> {
    const next: ExecutionRecord = {
      ...record,
      version: expectedVersion + 1,
      updatedAt: this.now().toISOString(),
    };
    const saved = await this.options.store.saveExecution(next, expectedVersion);
    if (!saved) {
      throw new ExecutionError(
        'EXECUTION_CONFLICT',
        'This execution changed while it was being updated. Read it again.',
        409,
      );
    }
    return next;
  }

  private async requireExecution(ownerRef: string, executionId: string): Promise<ExecutionRecord> {
    const record = await this.options.store.getExecution(ownerRef, executionId);
    if (record === null) {
      throw new ExecutionError('EXECUTION_NOT_FOUND', 'No such execution.', 404);
    }
    return record;
  }
}

/** The same cue list the planner uses, kept here so intake can record it. */
function approvalReasonsFor(text: string): readonly string[] {
  const cues: readonly { pattern: RegExp; reason: string }[] = [
    { pattern: /\bdeploy|deployment\b/i, reason: 'deploying needs a human decision' },
    { pattern: /\bpublish|release\b/i, reason: 'publishing needs a human decision' },
    { pattern: /\bproduction\b/i, reason: 'production changes need a human decision' },
    {
      pattern: /\bdelete|drop|truncate|wipe\b/i,
      reason: 'destructive changes need a human decision',
    },
    {
      pattern: /\bpayment|charge|billing|invoice\b/i,
      reason: 'money-moving changes need a human decision',
    },
  ];
  return cues.filter((cue) => cue.pattern.test(text)).map((cue) => cue.reason);
}

export type { ExecutionApproval, ExecutionStatus };
