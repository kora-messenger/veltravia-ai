/**
 * The coordinator. These tests drive it through fake ports that behave like the
 * real task, worker, verification, integration and recovery engines: the point
 * is what the Primary Agent is allowed to conclude, not that a fake works.
 */

import { describe, expect, it } from 'vitest';

import { ExecutionManager, type ExecutionPorts } from './manager.js';
import { InMemoryExecutionStore } from './testing.js';
import type {
  ChangeSetFacts,
  ProjectFacts,
  RecoveryFacts,
  TaskFacts,
  VerificationFacts,
  WorkerFacts,
} from './types.js';

const OWNER = 'owner@veltravia.dev';
const NOW = '2026-11-08T06:00:00.000Z';

interface World {
  readonly ports: ExecutionPorts;
  readonly tasks: Map<string, TaskFacts>;
  readonly workers: Map<string, WorkerFacts>;
  readonly verifications: VerificationFacts[];
  readonly changeSets: ChangeSetFacts[];
  readonly recoveries: RecoveryFacts[];
  readonly created: { title: string; dependencies: readonly string[] }[];
  readonly delegated: { workerId: string; taskId: string; workerType: string }[];
  readonly started: string[];
  readonly recovered: string[];
  readonly integrated: string[];
  readonly reviewed: { workerId: string; decision: string }[];
}

function world(overrides: Partial<ProjectFacts> = {}): World {
  const tasks = new Map<string, TaskFacts>();
  const workers = new Map<string, WorkerFacts>();
  const verifications: VerificationFacts[] = [];
  const changeSets: ChangeSetFacts[] = [];
  const recoveries: RecoveryFacts[] = [];
  const created: { title: string; dependencies: readonly string[] }[] = [];
  const delegated: { workerId: string; taskId: string; workerType: string }[] = [];
  const started: string[] = [];
  const recovered: string[] = [];
  const integrated: string[] = [];
  const reviewed: { workerId: string; decision: string }[] = [];
  let counter = 0;

  const ports: ExecutionPorts = {
    inspect: async () => ({
      files: ['apps/web/src/Settings.tsx', 'apps/api/src/settings.ts', 'package.json'],
      frameworks: ['react', 'fastify'],
      languages: ['typescript'],
      hasPackageJson: true,
      hasTests: true,
      hasDocs: false,
      revision: 'ws_1@4',
      unknown: [],
      ...overrides,
    }),
    createTask: async (input) => {
      counter += 1;
      const taskId = `task_${counter}`;
      created.push({ title: input.title, dependencies: input.dependencies });
      tasks.set(taskId, {
        taskId,
        title: input.title,
        status: 'queued',
        reviewStatus: null,
        dependencies: input.dependencies,
        failure: null,
        resultSummary: null,
        updatedAt: NOW,
        deliverables: [],
        workerId: null,
      });
      return taskId;
    },
    cancelTask: async (_owner, taskId) => {
      const task = tasks.get(taskId);
      if (task !== undefined) tasks.set(taskId, { ...task, status: 'cancelled' });
    },
    tasks: async (_owner, ids) =>
      ids.map((id) => tasks.get(id)).filter((task): task is TaskFacts => task !== undefined),
    delegateWorker: async (input) => {
      const workerId = `wkr_${input.workerType}_${delegated.length + 1}`;
      delegated.push({ workerId, taskId: input.taskId, workerType: input.workerType });
      workers.set(workerId, {
        workerId,
        taskId: input.taskId,
        workerType: input.workerType,
        status: 'queued',
        simulated: true,
        failure: null,
        deliverables: [],
        evidence: [],
      });
      const task = tasks.get(input.taskId);
      if (task !== undefined) tasks.set(input.taskId, { ...task, status: 'assigned', workerId });
      return workerId;
    },
    startWorker: async (_owner, workerId) => {
      started.push(workerId);
      const worker = workers.get(workerId);
      if (worker !== undefined) workers.set(workerId, { ...worker, status: 'running' });
    },
    cancelWorker: async (_owner, workerId) => {
      const worker = workers.get(workerId);
      if (worker !== undefined) workers.set(workerId, { ...worker, status: 'cancelled' });
    },
    reviewWorker: async (_owner, workerId, decision) => {
      reviewed.push({ workerId, decision });
      const worker = workers.get(workerId);
      if (worker === undefined) return;
      workers.set(workerId, {
        ...worker,
        status: decision === 'accept' ? 'completed' : 'failed',
      });
      const task = tasks.get(worker.taskId);
      if (task !== undefined) {
        tasks.set(worker.taskId, {
          ...task,
          status: decision === 'accept' ? 'completed' : 'failed',
          reviewStatus: decision === 'accept' ? 'accepted' : 'rejected',
        });
      }
    },
    workers: async (_owner, ids) =>
      ids.map((id) => workers.get(id)).filter((w): w is WorkerFacts => w !== undefined),
    verifications: async () => verifications,
    changeSets: async ({ changeSetId, taskIds }) =>
      changeSets.filter(
        (set) =>
          (changeSetId !== undefined && set.changeSetId === changeSetId) ||
          (set.taskId !== null && taskIds.includes(set.taskId)),
      ),
    integrateChangeSet: async (_owner, changeSetId) => {
      integrated.push(changeSetId);
      const index = changeSets.findIndex((set) => set.changeSetId === changeSetId);
      if (index >= 0) changeSets[index] = { ...changeSets[index]!, status: 'integrated' };
    },
    recoveries: async () => recoveries,
    openRecovery: async (_owner, workerId) => {
      const caseId = `rcv_${recovered.length + 1}`;
      recovered.push(workerId);
      const worker = workers.get(workerId);
      recoveries.push({
        caseId,
        taskId: worker?.taskId ?? null,
        workerId,
        status: 'open',
        category: 'unverified_completion',
        escalationReason: null,
      });
      return caseId;
    },
  };

  return {
    ports,
    tasks,
    workers,
    verifications,
    changeSets,
    recoveries,
    created,
    delegated,
    started,
    recovered,
    integrated,
    reviewed,
  };
}

function manager(w: World): ExecutionManager {
  return new ExecutionManager({
    store: new InMemoryExecutionStore(),
    ports: w.ports,
    now: () => new Date(NOW),
    maxConcurrent: 3,
  });
}

async function started(w: World): Promise<ExecutionManager> {
  const m = manager(w);
  await m.start({
    ownerRef: OWNER,
    text: 'Build a settings page with a form that saves to the API, plus tests.',
    projectId: 'prj_1',
  });
  return m;
}

function runId(execution: { id: string }): string {
  return execution.id;
}

describe('intake and planning', () => {
  it('inspects the project, plans, and creates a task graph with dependencies', async () => {
    const w = world();
    const m = manager(w);
    const view = await m.start({
      ownerRef: OWNER,
      text: 'Build a settings page with a form that saves to the API, plus tests.',
      projectId: 'prj_1',
    });
    expect(view.execution.status).toBe('executing');
    expect(view.plan.tasks.length).toBeGreaterThan(2);
    expect(view.plan.inspection.join(' ')).toContain('Read 3 project files');
    // Every planned task became a real task, and later tasks waited on earlier ones.
    expect(w.created).toHaveLength(view.plan.tasks.length);
    expect(view.plan.tasks.some((task) => task.dependsOn.length > 0)).toBe(true);
    const testTask = view.plan.tasks.find((task) => task.kind === 'testing');
    expect(testTask?.dependsOn.length).toBeGreaterThan(0);
  });

  it('keeps the original request on the execution, whatever the plan does', async () => {
    const w = world();
    const m = manager(w);
    const text = 'Add rate limiting to the API.';
    const view = await m.start({ ownerRef: OWNER, text, projectId: 'prj_1' });
    expect(view.execution.request.text).toBe(text);
    expect(view.plan.objective).toBe(text);
  });

  it('marks an execution that needs approval instead of starting destructive work', async () => {
    const w = world();
    const m = manager(w);
    const view = await m.start({
      ownerRef: OWNER,
      text: 'Deploy the new settings page to production and delete the old route.',
      projectId: 'prj_1',
    });
    const approvals = view.execution.approvals;
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals[0]?.reason).toMatch(/deploy|delete|production/i);
    expect(view.execution.status).toBe('awaiting_approval');
  });

  it('refuses an execution for a project that is not the caller’s', async () => {
    const w = world();
    w.ports.inspect = async () => {
      throw new Error('not found');
    };
    const m = manager(w);
    await expect(
      m.start({ ownerRef: 'someone-else', text: 'Build it.', projectId: 'prj_1' }),
    ).rejects.toMatchObject({ code: 'EXECUTION_PROJECT_UNAVAILABLE' });
  });
});

describe('dispatching', () => {
  it('starts independent tasks together and holds dependent ones', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const first = await m.dispatch(OWNER, runId(view!.execution));
    expect(first.dispatched.length).toBeGreaterThan(0);
    // Nothing depending on unfinished work is dispatched.
    for (const worker of w.delegated) {
      const task = w.tasks.get(worker.taskId);
      expect(task).toBeDefined();
      for (const dependency of task!.dependencies) {
        const dep = w.tasks.get(dependency);
        expect(dep?.status === 'completed' || dep === undefined).toBe(true);
      }
    }
  });

  it('never dispatches the same task twice', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    await m.dispatch(OWNER, runId(view!.execution));
    const second = await m.dispatch(OWNER, runId(view!.execution));
    expect(second.dispatched).toEqual([]);
    expect(new Set(w.delegated.map((entry) => entry.taskId)).size).toBe(w.delegated.length);
  });

  it('respects the concurrency ceiling', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const outcome = await m.dispatch(OWNER, runId(view!.execution));
    expect(outcome.dispatched.length).toBeLessThanOrEqual(3);
  });

  it('does not dispatch work that waits on an approval', async () => {
    const w = world();
    const m = manager(w);
    const view = await m.start({
      ownerRef: OWNER,
      text: 'Publish the app to the production domain.',
      projectId: 'prj_1',
    });
    const outcome = await m.dispatch(OWNER, view.execution.id);
    // Work that needs the owner waits; nothing is dispatched from that task.
    const gated = new Set(
      view.plan.tasks.filter((task) => task.approval !== null).map((task) => task.taskId),
    );
    for (const worker of w.delegated) expect(gated.has(worker.taskId)).toBe(false);
    expect(outcome.execution.status).toBe('awaiting_approval');
  });
});

describe('monitoring, recovery and review', () => {
  it('opens one recovery case for a failed worker and does not open a second', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const id = runId(view!.execution);
    await m.dispatch(OWNER, id);
    const worker = [...w.workers.values()].find((entry) => entry.status === 'running');
    expect(worker).toBeDefined();
    w.workers.set(worker!.workerId, {
      ...worker!,
      status: 'failed',
      failure: { code: 'WORKER_FAILED', message: 'scope refused' },
    });
    const task = w.tasks.get(worker!.taskId);
    w.tasks.set(worker!.taskId, {
      ...task!,
      status: 'failed',
      failure: { code: 'WORKER_FAILED', message: 'scope refused' },
    });
    await m.sync(OWNER, id);
    await m.sync(OWNER, id);
    expect(w.recovered).toEqual([worker!.workerId]);
  });

  it('will not accept a worker whose work has no stored passing verification', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const id = runId(view!.execution);
    await m.dispatch(OWNER, id);
    // The analysis task needs no test evidence, but handing it in is not
    // acceptance: only the owner's accept unlocks the implementation tasks.
    const analysis = [...w.workers.values()].find((entry) => entry.workerType === 'analysis');
    w.workers.set(analysis!.workerId, { ...analysis!, status: 'awaiting_review' });
    await m.review(OWNER, id, analysis!.taskId, 'accept', 'ok');
    w.reviewed.length = 0;
    await m.dispatch(OWNER, id);
    const implementation = [...w.workers.values()].find(
      (entry) => entry.workerType === 'frontend' && entry.status === 'running',
    );
    expect(implementation).toBeDefined();
    w.workers.set(implementation!.workerId, { ...implementation!, status: 'awaiting_review' });
    await expect(m.review(OWNER, id, implementation!.taskId, 'accept', 'ok')).rejects.toMatchObject(
      { code: 'EXECUTION_EVIDENCE_REQUIRED' },
    );
    expect(w.reviewed).toEqual([]);
  });

  it('accepts once a passing run exists, and then integrates the change set', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const id = runId(view!.execution);
    await m.dispatch(OWNER, id);
    const worker = [...w.workers.values()].find((entry) => entry.status === 'running');
    w.workers.set(worker!.workerId, { ...worker!, status: 'awaiting_review' });
    w.verifications.push({
      runId: 'run_1',
      projectId: 'prj_1',
      taskId: worker!.taskId,
      workerId: worker!.workerId,
      status: 'passed',
      executed: true,
      passedCount: 2,
      failedCount: 0,
      operations: ['unit'],
      finishedAt: NOW,
    });
    w.changeSets.push({
      changeSetId: 'chg_1',
      taskId: worker!.taskId,
      workerId: worker!.workerId,
      status: 'approved',
      files: ['apps/web/src/Settings.tsx'],
    });
    await m.review(OWNER, id, worker!.taskId, 'accept', 'proved by run_1');
    expect(w.reviewed).toEqual([{ workerId: worker!.workerId, decision: 'accept' }]);
    const integrated = await m.integrate(OWNER, id);
    expect(w.integrated).toContain('chg_1');
    expect(integrated.execution.changeSetIds).toContain('chg_1');
  });

  it('refuses integration of a change set that was never approved or proved', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const id = runId(view!.execution);
    await m.dispatch(OWNER, id);
    const worker = [...w.workers.values()].find((entry) => entry.status === 'running');
    w.changeSets.push({
      changeSetId: 'chg_open',
      taskId: worker!.taskId,
      workerId: worker!.workerId,
      status: 'pending',
      files: ['apps/web/src/Settings.tsx'],
    });
    await expect(m.integrate(OWNER, id)).rejects.toMatchObject({
      code: 'EXECUTION_NOTHING_TO_INTEGRATE',
    });
    expect(w.integrated).toEqual([]);
  });
});

describe('plan revision, cancellation and reporting', () => {
  it('records a revision with its reason instead of quietly changing the plan', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const id = runId(view!.execution);
    const revised = await m.revise(OWNER, id, {
      reason: 'The API already has a settings route, so the backend task is unnecessary.',
      remove: ['backend'],
    });
    expect(revised.plan.version).toBe(2);
    expect(revised.execution.revisions).toHaveLength(2);
    expect(revised.plan.revisionReason).toMatch(/already has a settings route/);
    expect(revised.plan.tasks.some((task) => task.key === 'backend')).toBe(false);
  });

  it('asks for approval when a revision would widen the request', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const id = runId(view!.execution);
    const revised = await m.revise(OWNER, id, {
      reason: 'The page also needs a billing section.',
      scopeChange: 'Add a billing section that was not part of the original request.',
    });
    expect(revised.execution.status).toBe('awaiting_approval');
    expect(revised.execution.approvals.some((entry) => entry.kind === 'scope_change')).toBe(true);
  });

  it('cancels the workers and tasks it started, and refuses further dispatch', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const id = runId(view!.execution);
    await m.dispatch(OWNER, id);
    const cancelled = await m.cancel(OWNER, id, 'The owner stopped the work.');
    expect(cancelled.execution.status).toBe('cancelled');
    for (const worker of w.workers.values()) expect(worker.status).toBe('cancelled');
    await expect(m.dispatch(OWNER, id)).rejects.toMatchObject({ code: 'EXECUTION_CLOSED' });
  });

  it('reports partial completion honestly when nothing was proven', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    const id = runId(view!.execution);
    const report = await m.report(OWNER, id);
    expect(report.outcome).not.toBe('completed');
    expect(report.verification).toEqual([]);
    expect(report.requiredActions.length).toBeGreaterThan(0);
  });

  it('keeps one owner’s executions invisible to another', async () => {
    const w = world();
    const m = await started(w);
    const [view] = await m.list(OWNER);
    expect(await m.list('someone-else')).toEqual([]);
    await expect(m.get('someone-else', runId(view!.execution))).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    });
  });

  it('resumes a stored execution after a restart without duplicating work', async () => {
    const w = world();
    const store = new InMemoryExecutionStore();
    const first = new ExecutionManager({
      store,
      ports: w.ports,
      now: () => new Date(NOW),
      maxConcurrent: 3,
    });
    const view = await first.start({
      ownerRef: OWNER,
      text: 'Build a settings page with a form that saves to the API, plus tests.',
      projectId: 'prj_1',
    });
    await first.dispatch(OWNER, view.execution.id);

    const restarted = new ExecutionManager({
      store,
      ports: w.ports,
      now: () => new Date(NOW),
      maxConcurrent: 3,
    });
    const reopened = await restarted.get(OWNER, view.execution.id);
    expect(reopened.execution.id).toBe(view.execution.id);
    const again = await restarted.dispatch(OWNER, view.execution.id);
    expect(again.dispatched).toEqual([]);
    expect(new Set(w.delegated.map((entry) => entry.taskId)).size).toBe(w.delegated.length);
  });
});
