/**
 * The task orchestration service, as this server assembles it.
 *
 * Two things matter here and nowhere else:
 *  - the scope guard. A task names a project, and the project is the permission
 *    boundary. The guard resolves the project through the Project Engine and
 *    compares its owner, so a client cannot assert a scope it does not hold.
 *  - the store choice. With a database configured the tasks are PostgreSQL
 *    rows and survive a restart; without one they are in memory and the API
 *    says so instead of implying durability.
 */

import { InMemoryTaskStore, TaskManager, type TaskScopeGuard } from '@veltravia/orchestration-core';
import type { ProjectEngine } from '@veltravia/project-core';

import type { Persistence } from './persistence.js';

export function createTaskScopeGuard(projects: ProjectEngine): TaskScopeGuard {
  return {
    async ownsProject(ownerRef, projectId) {
      try {
        const project = await projects.projects.getProject(projectId);
        return project.ownerRef === ownerRef && project.status === 'active';
      } catch {
        return false;
      }
    },
    async workspaceBelongsToProject(ownerRef, projectId, workspaceId) {
      try {
        const project = await projects.projects.getProject(projectId);
        if (project.ownerRef !== ownerRef || project.status !== 'active') return false;
        const workspaces = await projects.workspaces.listWorkspaces(projectId);
        return workspaces.some((workspace) => workspace.id === workspaceId);
      } catch {
        return false;
      }
    },
  };
}

export interface TaskService {
  readonly manager: TaskManager;
  readonly store: 'memory' | 'postgres';
  readonly durable: boolean;
}

export function createTaskService(input: {
  readonly persistence?: Persistence | undefined;
  readonly projects: ProjectEngine;
}): TaskService {
  const store = input.persistence?.stores?.tasks ?? null;
  const manager = new TaskManager({
    // Without a database this is a development store. Nothing claims otherwise:
    // `durable` is reported by the capabilities route and on every task list.
    store: store ?? new InMemoryTaskStore(),
    scope: createTaskScopeGuard(input.projects),
  });
  return {
    manager,
    store: store === null ? 'memory' : 'postgres',
    durable: store !== null,
  };
}
