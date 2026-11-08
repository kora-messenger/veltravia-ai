/**
 * Progress and delivery reporting, from stored evidence only.
 *
 * A worker's own percentage is not progress. A task is done when its record is
 * completed AND, where the plan asked for proof, a stored verification run
 * executed and passed. Anything else is named for what it is: waiting, running,
 * at review, blocked or failed.
 */

import type {
  DeliveryReport,
  ExecutionEvidence,
  ExecutionPlan,
  ExecutionProgress,
  ExecutionRecord,
  ExecutionStatus,
  TaskFacts,
  TaskProgressLine,
  VerificationFacts,
} from './types.js';

const ACTIVE_WORKER_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'assigned',
  'starting',
  'running',
]);

const REVIEW_WORKER_STATUSES: ReadonlySet<string> = new Set([
  'awaiting_review',
  'partially_completed',
]);

const FAILED_WORKER_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled', 'timed_out']);

/** Statuses that mean the task's own record finished, with or without proof. */
const FINISHED_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'awaiting_review',
  'partially_completed',
]);

function verificationFor(
  plan: ExecutionPlan,
  evidence: ExecutionEvidence,
  task: { readonly taskId: string | null; readonly key: string },
  facts: TaskFacts | undefined,
): VerificationFacts | null {
  const updated = facts?.updatedAt ?? null;
  const byTaskId = new Map(
    plan.tasks
      .filter((entry) => entry.taskId !== null)
      .map((entry) => [entry.taskId as string, entry]),
  );
  // A run recorded against a task that verifies this one covers it: that is
  // what "the tests passed after the implementation" means here.
  const provesThis = (runTaskId: string | null): boolean => {
    if (runTaskId === null) return false;
    const runTask = byTaskId.get(runTaskId);
    if (runTask === undefined) return false;
    const seen = new Set<string>();
    const walk = (key: string): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      const entry = plan.tasks.find((candidate) => candidate.key === key);
      if (entry === undefined) return false;
      if (entry.dependsOn.includes(task.key)) return true;
      return entry.dependsOn.some(walk);
    };
    return walk(runTask.key);
  };
  const candidates = evidence.verifications.filter((run) => {
    if (!run.executed) return false;
    if (task.taskId !== null && run.taskId === task.taskId) return true;
    if (run.status === 'passed' && provesThis(run.taskId)) return true;
    if (facts?.workerId != null && facts.workerId !== null && run.workerId === facts.workerId)
      return true;
    // A project-wide run counts only when it happened after the task finished,
    // otherwise it is evidence about an older revision of the same project.
    if (
      run.taskId === null &&
      run.workerId === null &&
      updated !== null &&
      run.finishedAt !== null &&
      run.finishedAt >= updated
    ) {
      return true;
    }
    return false;
  });
  return candidates.length === 0 ? null : (candidates[candidates.length - 1] ?? null);
}

function lineFor(input: {
  readonly plan: ExecutionPlan;
  readonly task: ExecutionPlan['tasks'][number];
  readonly evidence: ExecutionEvidence;
  readonly done: ReadonlySet<string>;
}): TaskProgressLine {
  const { task, evidence, done, plan } = input;
  const facts =
    task.taskId === null ? undefined : evidence.tasks.find((entry) => entry.taskId === task.taskId);
  const worker =
    facts?.workerId == null
      ? undefined
      : evidence.workers.find((entry) => entry.workerId === facts.workerId);
  const recovery =
    task.taskId === null
      ? undefined
      : evidence.recoveries.find((entry) => entry.taskId === task.taskId);
  const run = verificationFor(plan, evidence, task, facts);
  const needsProof = task.verification !== 'none';
  const verified = !needsProof
    ? facts?.status === 'completed'
    : run !== null && run.status === 'passed';

  const dependenciesMet = task.dependsOn.every((key) => done.has(key));

  let status: TaskProgressLine['status'];
  let note: string | null = null;

  if (task.taskId === null) {
    status = dependenciesMet ? 'ready' : 'waiting';
  } else if (facts === undefined) {
    // The task exists in the plan but has no work yet. It is runnable when its
    // dependencies are satisfied and waiting otherwise.
    const blockedBy = task.dependsOn.filter((key) => !done.has(key));
    status = blockedBy.length === 0 ? 'ready' : 'waiting';
    note =
      blockedBy.length === 0 ? null : `Waiting for ${blockedBy.join(', ')} before this can start.`;
  } else if (facts.status === 'cancelled') {
    status = 'blocked';
    note = 'The task was cancelled.';
  } else if (facts.status === 'blocked') {
    status = 'blocked';
    note = recovery?.escalationReason ?? facts.failure?.message ?? 'The task is blocked.';
  } else if (facts.status === 'failed') {
    status = 'failed';
    note = recovery?.escalationReason ?? facts.failure?.message ?? 'The task failed.';
  } else if (facts.status === 'completed' && verified) {
    status = 'done';
  } else if (facts.status === 'completed' && !verified) {
    status = 'review';
    note = 'The work is recorded as complete but no stored passing verification run covers it.';
  } else if (worker !== undefined && ACTIVE_WORKER_STATUSES.has(worker.status)) {
    status = 'running';
  } else if (
    (worker !== undefined && REVIEW_WORKER_STATUSES.has(worker.status)) ||
    FINISHED_TASK_STATUSES.has(facts.status)
  ) {
    // Active independent of proof: work handed in but not yet accepted is not
    // done, and its dependents must not start on an unreviewed change.
    status = 'review';
  } else if (worker !== undefined && FAILED_WORKER_STATUSES.has(worker.status)) {
    status = 'failed';
    note = worker.failure?.message ?? recovery?.escalationReason ?? 'The worker did not finish.';
  } else if (facts.status === 'queued' || facts.status === 'planning') {
    const blockedBy = task.dependsOn.filter((key) => !done.has(key));
    status = blockedBy.length === 0 ? 'ready' : 'waiting';
    note =
      blockedBy.length === 0 ? null : `Waiting for ${blockedBy.join(', ')} before this can start.`;
  } else {
    status = 'running';
  }

  if (task.approval !== null && task.taskId === null && status !== 'waiting') {
    note = task.approval;
  }

  const changeSet = evidence.changeSets.filter((set) => set.taskId === task.taskId);
  return {
    key: task.key,
    title: task.title,
    kind: task.kind,
    status,
    taskId: task.taskId,
    workerId: facts?.workerId ?? null,
    workerType: task.workerType,
    dependsOn: task.dependsOn,
    verified: task.taskId === null ? false : verified,
    integrated: changeSet.length > 0 && changeSet.every((set) => set.status === 'integrated'),
    recoveryCaseId: recovery?.caseId ?? null,
    note,
  };
}

export function computeProgress(input: {
  readonly record: ExecutionRecord;
  readonly plan: ExecutionPlan;
  readonly evidence: ExecutionEvidence;
  readonly at: string;
}): ExecutionProgress {
  const done = new Set<string>();
  const lines: TaskProgressLine[] = [];
  // Two passes so a dependency finished earlier in the plan is visible to a
  // later line in the same read.
  const byKey = new Map(input.plan.tasks.map((task) => [task.key, task]));
  const resolved = new Map<string, TaskProgressLine>();

  const resolve = (key: string, seen: ReadonlySet<string> = new Set()): TaskProgressLine | null => {
    const existing = resolved.get(key);
    if (existing !== undefined) return existing;
    const task = byKey.get(key);
    if (task === undefined) return null;
    if (seen.has(key)) return null;
    const line = lineFor({ plan: input.plan, task, evidence: input.evidence, done });
    resolved.set(key, line);
    return line;
  };

  // Repeated passes: a line can only move to 'ready' once its dependencies are
  // known to be done, and done depends on verified completion.
  for (let pass = 0; pass < input.plan.tasks.length + 1; pass += 1) {
    let changed = false;
    for (const task of input.plan.tasks) {
      const line = resolve(task.key);
      if (line === null) continue;
      if (line.status === 'done' && !done.has(task.key)) {
        done.add(task.key);
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const task of input.plan.tasks) {
    const line = resolve(task.key);
    if (line !== null) lines.push(line);
  }

  const counts = {
    total: lines.length,
    waiting: lines.filter((line) => line.status === 'waiting').length,
    ready: lines.filter((line) => line.status === 'ready').length,
    running: lines.filter((line) => line.status === 'running').length,
    review: lines.filter((line) => line.status === 'review').length,
    done: lines.filter((line) => line.status === 'done').length,
    blocked: lines.filter((line) => line.status === 'blocked').length,
    failed: lines.filter((line) => line.status === 'failed').length,
  };

  const awaitingApproval = input.record.approvals
    .filter((approval) => approval.state === 'pending')
    .map((approval) => approval.reason);

  const outstanding: string[] = [];
  for (const line of lines) {
    if (line.status === 'done') continue;
    if (line.status === 'review' && line.note !== null)
      outstanding.push(`${line.title}: ${line.note}`);
  }
  for (const line of lines.filter((entry) => entry.status === 'failed')) {
    outstanding.push(`${line.title}: ${line.note ?? 'failed'}`);
  }
  for (const line of lines.filter((entry) => entry.status === 'blocked')) {
    outstanding.push(`${line.title}: ${line.note ?? 'blocked'}`);
  }

  const status = deriveStatus({ record: input.record, counts, awaitingApproval, lines });

  return {
    status,
    tasks: lines,
    counts,
    awaitingApproval,
    outstanding,
    updatedAt: input.at,
  };
}

function deriveStatus(input: {
  readonly record: ExecutionRecord;
  readonly counts: ExecutionProgress['counts'];
  readonly awaitingApproval: readonly string[];
  readonly lines: readonly TaskProgressLine[];
}): ExecutionStatus {
  if (input.record.status === 'cancelled') return 'cancelled';
  const { counts } = input;
  const actionable = counts.ready + counts.running + counts.review;

  if (counts.total > 0 && counts.done === counts.total) return 'completed';

  // Work that can still move comes first: an execution with something running
  // is executing, not waiting on the owner.
  if (actionable > 0) {
    if (counts.running > 0 || counts.ready > 0) return 'executing';
    return 'verifying';
  }
  if (input.awaitingApproval.length > 0) return 'awaiting_approval';

  const terminalFailures = counts.failed + counts.blocked;
  if (counts.done > 0 && terminalFailures > 0) return 'partially_completed';
  if (counts.done === 0 && terminalFailures > 0) {
    return terminalFailures === counts.failed ? 'failed' : 'blocked';
  }
  if (counts.waiting > 0) return 'executing';
  return 'blocked';
}

/**
 * The report the owner reads. It is assembled from the same evidence the
 * dashboard shows, and it refuses to call an execution complete while a task is
 * unfinished or unproven.
 */
export function buildDeliveryReport(input: {
  readonly record: ExecutionRecord;
  readonly plan: ExecutionPlan;
  readonly progress: ExecutionProgress;
  readonly evidence: ExecutionEvidence;
  readonly at: string;
}): DeliveryReport {
  const { progress } = input;
  const titleOf = (key: string): string =>
    progress.tasks.find((line) => line.key === key)?.title ?? key;

  const doneLines = progress.tasks.filter((line) => line.status === 'done');
  const reviewLines = progress.tasks.filter((line) => line.status === 'review');
  const blockedLines = progress.tasks.filter((line) => line.status === 'blocked');
  const failedLines = progress.tasks.filter((line) => line.status === 'failed');
  const waitingLines = progress.tasks.filter(
    (line) => line.status === 'waiting' || line.status === 'ready',
  );

  const outcome: DeliveryReport['outcome'] =
    input.record.status === 'cancelled'
      ? 'cancelled'
      : progress.status === 'completed'
        ? 'completed'
        : doneLines.length > 0
          ? 'partially_completed'
          : failedLines.length > 0 && blockedLines.length === 0 && waitingLines.length === 0
            ? 'failed'
            : 'blocked';

  const limitations: string[] = [];
  for (const line of reviewLines) {
    limitations.push(`${line.title}: ${line.note ?? 'waiting for review'}.`);
  }
  for (const line of failedLines) limitations.push(`${line.title}: ${line.note ?? 'failed'}.`);
  for (const line of blockedLines) limitations.push(`${line.title}: ${line.note ?? 'blocked'}.`);
  if (progress.counts.total > 0 && input.progress.tasks.every((line) => !line.integrated)) {
    limitations.push(
      'No change set has been integrated, so the delivered files are not merged into the project.',
    );
  }

  const requiredActions: string[] = [];
  if (progress.awaitingApproval.length > 0) {
    requiredActions.push(`Approve or refuse: ${progress.awaitingApproval.join('; ')}.`);
  }
  if (progress.tasks.some((line) => line.status === 'ready')) {
    requiredActions.push('Start the work that is ready to run.');
  }
  if (failedLines.length > 0 || blockedLines.length > 0) {
    requiredActions.push('Decide how to proceed with the tasks named above.');
  }
  for (const line of reviewLines) {
    if (line.note?.includes('no stored passing verification run') === true) {
      requiredActions.push(`Run verification for ${line.title}.`);
    }
  }

  const integrated = input.evidence.changeSets.filter((set) => set.status === 'integrated');
  const filesChanged = [...new Set(integrated.flatMap((set) => set.files))];

  return {
    executionId: input.record.id,
    objective: input.plan.objective,
    outcome,
    completed: doneLines.map((line) => line.title),
    partial: reviewLines.map((line) => `${line.title} (${titleOf(line.key)} at review)`),
    blocked: blockedLines.map((line) => line.title),
    failed: failedLines.map((line) => line.title),
    notStarted: waitingLines.map((line) => line.title),
    awaitingApproval: progress.awaitingApproval,
    filesChanged,
    workers: input.evidence.workers
      .filter((worker) => worker.taskId !== null && input.record.taskIds.includes(worker.taskId))
      .map((worker) => ({
        workerId: worker.workerId,
        taskId: worker.taskId,
        workerType: worker.workerType,
        status: worker.status,
        simulated: worker.simulated,
      })),
    verification: input.evidence.verifications.map((run) => ({
      runId: run.runId,
      status: run.status,
      executed: run.executed,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
    })),
    integration: input.evidence.changeSets.map((set) => ({
      changeSetId: set.changeSetId,
      taskId: set.taskId,
      status: set.status,
      files: set.files,
    })),
    recovery: input.evidence.recoveries.map((entry) => ({
      caseId: entry.caseId,
      taskId: entry.taskId,
      status: entry.status,
      category: entry.category,
    })),
    limitations,
    requiredActions,
    generatedAt: input.at,
  };
}
