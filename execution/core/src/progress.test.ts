/**
 * Progress and the delivery report. These tests exist because the failure mode
 * that matters is a nice-looking report that is not true: work called complete
 * without a stored passing run, or a failure counted as progress.
 */

import { describe, expect, it } from 'vitest';

import { buildPlan } from './plan.js';
import { buildDeliveryReport, computeProgress } from './progress.js';
import type {
  ExecutionEvidence,
  ExecutionRecord,
  PlannedTask,
  ProjectFacts,
  TaskFacts,
} from './types.js';

const at = '2026-11-08T06:00:00.000Z';

const facts: ProjectFacts = {
  files: ['apps/web/src/App.tsx', 'apps/api/src/server.ts', 'package.json'],
  languages: ['typescript'],
  frameworks: ['react', 'fastify'],
  hasPackageJson: true,
  hasTests: true,
  hasDocs: false,
  revision: 'rev_1',
  unknown: [],
};

function plan() {
  return buildPlan({
    request: {
      text: 'Add the settings page and the settings endpoint',
      projectId: 'prj_1',
      workspaceId: 'ws_1',
      requiresApproval: false,
      approvalReasons: [],
      receivedAt: at,
    },
    facts,
    createdAt: at,
  });
}

function recordWith(taskPlan: ReturnType<typeof plan>): ExecutionRecord {
  return {
    id: 'exe_1',
    ownerRef: 'owner_1',
    projectId: 'prj_1',
    workspaceId: 'ws_1',
    status: 'executing',
    request: {
      text: 'Add the settings page and the settings endpoint',
      projectId: 'prj_1',
      workspaceId: 'ws_1',
      requiresApproval: false,
      approvalReasons: [],
      receivedAt: at,
    },
    plan: taskPlan,
    revisions: [taskPlan],
    approvals: [],
    taskIds: taskPlan.tasks.flatMap((task) => (task.taskId === null ? [] : [task.taskId])),
    workerIds: [],
    recoveryCaseIds: [],
    maxConcurrent: 2,
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    stoppedReason: null,
    version: 1,
  };
}

function withTaskIds(taskPlan: ReturnType<typeof plan>) {
  const tasks: PlannedTask[] = taskPlan.tasks.map((task) => ({
    ...task,
    taskId: `task_${task.key}`,
  }));
  return { ...taskPlan, tasks };
}

function emptyEvidence(): ExecutionEvidence {
  return { tasks: [], workers: [], verifications: [], changeSets: [], recoveries: [] };
}

function taskFacts(key: string, overrides: Partial<TaskFacts> = {}): TaskFacts {
  return {
    taskId: `task_${key}`,
    title: key,
    status: 'completed',
    reviewStatus: 'accepted',
    dependencies: [],
    failure: null,
    resultSummary: 'done',
    updatedAt: '2026-11-08T05:00:00.000Z',
    deliverables: ['a file'],
    workerId: `wkr_${key}`,
    ...overrides,
  };
}

describe('evidence-based progress', () => {
  it('does not call a completed task done without a stored passing run', () => {
    const taskPlan = withTaskIds(plan());
    const record = recordWith(taskPlan);
    const evidence: ExecutionEvidence = {
      ...emptyEvidence(),
      tasks: taskPlan.tasks.map((task) => taskFacts(task.key)),
    };
    const progress = computeProgress({ record, plan: taskPlan, evidence, at });
    const verifyLine = progress.tasks.find((line) => line.key === 'verify');
    expect(verifyLine?.status).toBe('review');
    expect(verifyLine?.note).toMatch(/no stored passing verification run/i);
    expect(progress.status).not.toBe('completed');
    expect(progress.outstanding.join(' ')).toMatch(/verification/i);
  });

  it('calls the execution complete when every task is done and proven', () => {
    const taskPlan = withTaskIds(plan());
    const record = recordWith(taskPlan);
    const evidence: ExecutionEvidence = {
      ...emptyEvidence(),
      tasks: taskPlan.tasks.map((task) => taskFacts(task.key)),
      workers: taskPlan.tasks.map((task) => ({
        workerId: task.workerId ?? `wkr_${task.key}`,
        taskId: task.taskId as string,
        workerType: task.workerType,
        status: 'completed',
        simulated: true,
        failure: null,
        deliverables: ['a file'],
        evidence: [],
      })),
    };
    // The verify task is proven by a run recorded against it, and only that.
    evidence.verifications.push({
      runId: 'run_1',
      projectId: 'prj_1',
      taskId: 'task_verify',
      workerId: 'wkr_verify',
      status: 'passed',
      executed: true,
      passedCount: 4,
      failedCount: 0,
      operations: ['unit'],
      finishedAt: at,
    });
    const progress = computeProgress({ record, plan: taskPlan, evidence, at });
    expect(progress.tasks.every((line) => line.status === 'done')).toBe(true);
    expect(progress.status).toBe('completed');
    expect(progress.outstanding).toEqual([]);
  });

  it('never counts a failed worker as progress', () => {
    const taskPlan = withTaskIds(plan());
    const record = recordWith(taskPlan);
    const evidence: ExecutionEvidence = {
      ...emptyEvidence(),
      tasks: taskPlan.tasks.map((task) =>
        task.key === 'understand'
          ? taskFacts('understand', {
              status: 'failed',
              failure: { code: 'WORKER_FAILED', message: 'no files' },
            })
          : taskFacts(task.key, { status: 'queued' }),
      ),
      workers: [
        {
          workerId: 'wkr_understand',
          taskId: 'task_understand',
          workerType: 'analysis',
          status: 'failed',
          simulated: true,
          failure: { code: 'WORKER_FAILED', message: 'no files' },
          deliverables: [],
          evidence: [],
        },
      ],
    };
    const progress = computeProgress({ record, plan: taskPlan, evidence, at });
    const line = progress.tasks.find((entry) => entry.key === 'understand');
    expect(line?.status).toBe('failed');
    expect(progress.status).not.toBe('completed');
    expect(progress.counts.done).toBe(0);
  });

  it('shows a dependency chain as waiting rather than ready', () => {
    const taskPlan = withTaskIds(plan());
    const record = recordWith(taskPlan);
    const progress = computeProgress({ record, plan: taskPlan, evidence: emptyEvidence(), at });
    const verify = progress.tasks.find((line) => line.key === 'verify');
    const understand = progress.tasks.find((line) => line.key === 'understand');
    expect(understand?.status).toBe('ready');
    expect(verify?.status).toBe('waiting');
  });

  it('surfaces a pending approval as the owner’s decision, not as a system fault', () => {
    const taskPlan = withTaskIds(plan());
    const record: ExecutionRecord = {
      ...recordWith(taskPlan),
      approvals: [
        {
          id: 'apr_1',
          taskKey: 'backend',
          reason: 'Deploying needs a human decision',
          state: 'pending',
          requestedAt: at,
          decidedAt: null,
          decidedBy: null,
          note: null,
        },
      ],
    };
    const evidence: ExecutionEvidence = {
      ...emptyEvidence(),
      tasks: taskPlan.tasks.map((task) => taskFacts(task.key, { status: 'queued' })),
    };
    const progress = computeProgress({ record, plan: taskPlan, evidence, at });
    expect(progress.awaitingApproval).toEqual(['Deploying needs a human decision']);
  });
});

describe('delivery report', () => {
  it('states a partial completion honestly, with what is missing', () => {
    const taskPlan = withTaskIds(plan());
    const record = recordWith(taskPlan);
    const evidence: ExecutionEvidence = {
      ...emptyEvidence(),
      tasks: taskPlan.tasks.map((task) =>
        task.key === 'backend'
          ? taskFacts('backend', {
              status: 'failed',
              failure: { code: 'WORKER_FAILED', message: 'scope refused' },
            })
          : taskFacts(task.key, { status: 'queued' }),
      ),
      workers: [
        {
          workerId: 'wkr_backend',
          taskId: 'task_backend',
          workerType: 'backend',
          status: 'failed',
          simulated: true,
          failure: { code: 'WORKER_FAILED', message: 'scope refused' },
          deliverables: [],
          evidence: [],
        },
      ],
      recoveries: [
        {
          caseId: 'rcv_1',
          taskId: 'task_backend',
          workerId: 'wkr_backend',
          status: 'escalated',
          category: 'verification_failed',
          escalationReason: 'budget_exhausted',
        },
      ],
    };
    const progress = computeProgress({ record, plan: taskPlan, evidence, at });
    const report = buildDeliveryReport({ record, plan: taskPlan, progress, evidence, at });
    expect(report.outcome).toBe('blocked');
    expect(report.failed.join(' ')).toMatch(/Fix|backend|Implement/i);
    expect(report.limitations.length).toBeGreaterThan(0);
    expect(report.recovery[0]?.caseId).toBe('rcv_1');
    expect(report.requiredActions.length).toBeGreaterThan(0);
  });

  it('reports the files that were actually integrated, not the ones claimed', () => {
    const taskPlan = withTaskIds(plan());
    const record = recordWith(taskPlan);
    const evidence: ExecutionEvidence = {
      ...emptyEvidence(),
      tasks: taskPlan.tasks.map((task) => taskFacts(task.key)),
      changeSets: [
        {
          changeSetId: 'chg_1',
          taskId: 'task_frontend',
          workerId: 'wkr_frontend',
          status: 'integrated',
          files: ['apps/web/src/Settings.tsx'],
        },
        {
          changeSetId: 'chg_2',
          taskId: 'task_backend',
          workerId: 'wkr_backend',
          status: 'approved',
          files: ['apps/api/src/settings.ts'],
        },
      ],
      verifications: [
        {
          runId: 'run_1',
          projectId: 'prj_1',
          taskId: null,
          workerId: null,
          status: 'passed',
          executed: true,
          passedCount: 3,
          failedCount: 0,
          operations: ['unit'],
          finishedAt: '2026-11-08T05:30:00.000Z',
        },
      ],
    };
    const progress = computeProgress({ record, plan: taskPlan, evidence, at });
    const report = buildDeliveryReport({ record, plan: taskPlan, progress, evidence, at });
    expect(report.filesChanged).toEqual(['apps/web/src/Settings.tsx']);
    expect(report.integration.map((entry) => entry.status)).toEqual(['integrated', 'approved']);
  });

  it('never says completed when a task is still at review', () => {
    const taskPlan = withTaskIds(plan());
    const record = recordWith(taskPlan);
    const evidence: ExecutionEvidence = {
      ...emptyEvidence(),
      tasks: taskPlan.tasks.map((task) =>
        task.key === 'verify'
          ? taskFacts('verify', { status: 'awaiting_review', reviewStatus: null })
          : taskFacts(task.key),
      ),
    };
    const progress = computeProgress({ record, plan: taskPlan, evidence, at });
    const report = buildDeliveryReport({ record, plan: taskPlan, progress, evidence, at });
    expect(report.outcome).not.toBe('completed');
    expect(report.partial.join(' ')).toMatch(/Prove the work/);
  });
});
