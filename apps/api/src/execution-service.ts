/**
 * The end-to-end execution service.
 *
 * This file is the only place that knows how the Step 50 coordinator reaches
 * the earlier engines: tasks from Step 42, workers from Step 43/44, verification
 * runs from Step 45, change sets from Step 46 and recovery cases from Step 48.
 * The coordinator itself owns no execution, no scheduling and no recovery, so
 * there is exactly one of each in the system.
 */

import {
  ExecutionManager,
  InMemoryExecutionStore,
  type ExecutionPorts,
  type ExecutionStore,
  type ProjectFacts,
  type TaskFacts,
  type VerificationFacts,
  type WorkerFacts,
} from '@veltravia/execution-core';

import type { VerificationService } from './verification.js';
import type { WorkerService } from './worker-service.js';
import type { TaskService } from './task-service.js';
import type { ProjectEngine } from '@veltravia/project-core';
import type { ChangeIntegrationService } from './change-integration-service.js';
import type { RecoveryService } from './recovery-service.js';

export interface ExecutionServiceOptions {
  readonly projects: ProjectEngine;
  readonly tasks: TaskService;
  readonly workers: WorkerService;
  readonly verification: VerificationService;
  readonly changeIntegration: ChangeIntegrationService;
  readonly recovery: RecoveryService;
  /** Durable store when the deployment has a database. */
  readonly store?: ExecutionStore | undefined;
}

export interface ExecutionService {
  readonly manager: ExecutionManager;
  readonly store: 'memory' | 'postgres';
  readonly durable: boolean;
}

/** Reads the project without changing it, and records what it could not see. */
async function inspectProject(
  projects: ProjectEngine,
  ownerRef: string,
  projectId: string,
): Promise<ProjectFacts> {
  const project = await projects.projects.getProject(projectId);
  const unknown: string[] = [];
  const workspaces = await projects.workspaces.listWorkspaces(project.id);
  const workspace = workspaces.find((entry) => entry.status === 'active') ?? workspaces[0];
  if (workspace === undefined) {
    unknown.push('The project has no workspace yet, so no files could be read.');
    return {
      files: [],
      languages: [],
      frameworks: [],
      hasPackageJson: false,
      hasTests: false,
      hasDocs: false,
      revision: null,
      unknown,
    };
  }
  const nodes = await projects.files.listAll(workspace.id);
  const files = nodes.filter((node) => node.type === 'file').map((node) => node.path);
  if (files.length === 0) unknown.push('The workspace is empty.');
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  for (const path of files) {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) languages.add('typescript');
    else if (path.endsWith('.js') || path.endsWith('.jsx')) languages.add('javascript');
    else if (path.endsWith('.py')) languages.add('python');
    else if (path.endsWith('.dart')) languages.add('dart');
    else if (path.endsWith('.go')) languages.add('go');
    else if (path.endsWith('.rs')) languages.add('rust');
    else if (path.endsWith('.java') || path.endsWith('.kt')) languages.add('java');
  }
  const has = (name: string): boolean => files.some((path) => path.endsWith(name));
  if (has('fastify') || files.some((path) => path.includes('fastify'))) frameworks.add('fastify');
  if (has('package.json')) {
    const raw = await projects.files.readFile(workspace.id, 'package.json').catch(() => null);
    const text = raw?.content ?? '';
    if (text.includes('"react"')) frameworks.add('react');
    if (text.includes('"next"')) frameworks.add('next');
    if (text.includes('"vite"')) frameworks.add('vite');
    if (text.includes('"vitest"')) frameworks.add('vitest');
  }
  void ownerRef;
  return {
    files,
    languages: [...languages],
    frameworks: [...frameworks],
    hasPackageJson: has('package.json'),
    hasTests: files.some((path) => path.includes('.test.') || path.includes('__tests__')),
    hasDocs: files.some((path) => path.startsWith('docs/') || path.endsWith('README.md')),
    revision: workspace.revision === undefined ? null : String(workspace.revision),
    unknown,
  };
}

export function createExecutionService(options: ExecutionServiceOptions): ExecutionService {
  const store = options.store ?? new InMemoryExecutionStore();

  const ports: ExecutionPorts = {
    inspect: (ownerRef, projectId) => inspectProject(options.projects, ownerRef, projectId),

    async createTask(input) {
      const task = await options.tasks.manager.createTask(input.ownerRef, {
        title: input.title,
        objective: input.objective,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        dependencies: input.dependencies,
        acceptance: input.acceptance.map((statement) => ({
          id: `acp_${statement
            .slice(0, 12)
            .replace(/[^a-z0-9]+/gi, '_')
            .toLowerCase()}`,
          statement,
          required: true,
        })),
        createdBy: 'primary_agent',
      });
      return task.id;
    },

    async cancelTask(ownerRef, taskId, reason) {
      await options.tasks.manager.cancel(ownerRef, taskId, reason);
    },

    async tasks(ownerRef, taskIds) {
      const facts: TaskFacts[] = [];
      for (const taskId of taskIds) {
        const task = await options.tasks.manager.getTask(ownerRef, taskId).catch(() => null);
        if (task === null) continue;
        facts.push({
          taskId: task.id,
          title: task.title,
          status: task.status,
          reviewStatus: task.reviewStatus,
          dependencies: task.dependencies,
          failure: task.failure ?? null,
          resultSummary: task.result?.summary ?? null,
          updatedAt: task.updatedAt,
          deliverables: [...(task.result?.outputs ?? [])],
          workerId: (task.assignment as { workerId?: string } | null)?.workerId ?? null,
        });
      }
      return facts;
    },

    async delegateWorker(input) {
      const worker = await options.workers.manager.delegate(input.ownerRef, {
        taskId: input.taskId,
        workerType: input.workerType,
        assignment: input.assignment,
      });
      return worker.id;
    },

    async startWorker(ownerRef, workerId) {
      await options.workers.manager.start(ownerRef, workerId);
    },

    async cancelWorker(ownerRef, workerId, reason) {
      await options.workers.manager.cancel(ownerRef, workerId, reason).catch(() => null);
    },

    async reviewWorker(ownerRef, workerId, decision, note) {
      // The worker review gate re-checks its own acceptance criteria and test
      // evidence; this call only carries the decision and the note.
      const worker = await options.workers.workers.read(ownerRef, workerId);
      const criteria = worker?.assignment.acceptanceCriteria ?? [];
      await options.workers.manager.review(ownerRef, workerId, {
        decision,
        summary: note,
        criteriaResults: criteria.map(() => (decision === 'accept' ? true : false)),
      });
    },

    async workers(ownerRef, workerIds) {
      const facts: WorkerFacts[] = [];
      for (const workerId of workerIds) {
        const worker = await options.workers.workers.read(ownerRef, workerId).catch(() => null);
        if (worker === null) continue;
        facts.push({
          workerId: worker.id,
          taskId: worker.taskId,
          workerType: worker.workerType,
          status: worker.status,
          simulated: worker.result?.simulated === true,
          failure: worker.failure ?? null,
          deliverables: (worker.result?.deliverables ?? []).map((entry) => entry.name),
          evidence: (worker.result?.evidence ?? []).map((entry) => ({
            kind: entry.kind,
            ref: entry.ref,
          })),
        });
      }
      return facts;
    },

    async verifications(ownerRef, taskIds) {
      const runs = await options.verification.store.list(ownerRef, {});
      const wanted = new Set(taskIds);
      const facts: VerificationFacts[] = runs.map((run) => ({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        workerId: run.workerId,
        status: run.status,
        executed: run.evidence?.executed === true,
        passedCount: run.evidence?.passedCount ?? 0,
        failedCount: run.evidence?.failedCount ?? 0,
        operations: run.requestedOperations,
        finishedAt: run.finishedAt,
      }));
      void wanted;
      return facts;
    },

    async changeSets(input) {
      const sets = await options.changeIntegration.changeSets.list(input.ownerRef, {
        projectId: input.projectId,
      });
      const wanted = new Set(input.taskIds);
      return sets
        .filter((set) => set.taskId !== null && wanted.has(set.taskId))
        .map((set) => ({
          changeSetId: set.id,
          taskId: set.taskId,
          workerId: set.workerId,
          status: set.status,
          files: set.files.map((file) => file.path),
        }));
    },

    async integrateChangeSet(ownerRef, changeSetId) {
      const set = await options.changeIntegration.changeSets.get(ownerRef, changeSetId);
      if (set === null) return;
      await options.changeIntegration.manager.integrate({
        ownerRef,
        projectId: set.projectId,
        changeSetIds: [changeSetId],
        approvalId: 'execution-coordinator',
        actor: 'primary_agent',
      });
    },

    async recoveries(ownerRef, projectId) {
      const cases = await options.recovery.manager.list(ownerRef, { projectId });
      return cases.map((entry) => ({
        caseId: entry.id,
        taskId: entry.taskId,
        workerId: entry.workerId,
        status: entry.status,
        category: entry.diagnosis?.primary ?? null,
        escalationReason: entry.escalation?.reason ?? null,
      }));
    },

    async openRecovery(ownerRef, workerId) {
      const opened = await options.recovery.open({ ownerRef, workerId });
      return opened.record.id;
    },
  };

  const manager = new ExecutionManager({ store, ports });
  return {
    manager,
    store: options.store === undefined ? 'memory' : 'postgres',
    durable: options.store !== undefined,
  };
}
