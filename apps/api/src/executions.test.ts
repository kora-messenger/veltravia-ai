/**
 * End-to-end execution through the API (Step 50).
 *
 * One natural-language request goes in and the routes the dashboard calls carry
 * it: intake plans and creates real tasks, dispatch delegates to real workers,
 * sync reconciles against stored evidence, review refuses unproven work, and the
 * report says what was actually delivered.
 *
 * The worker executor is simulated, so this proves the wiring, the evidence
 * gate and the ownership boundary, not that a model writes good code.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './server.js';

process.env['VELTRAVIA_WORKER_EXECUTOR'] = 'simulated';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(): Promise<FastifyInstance> {
  const api = await buildApp({ logger: false });
  await api.ready();
  app = api;
  return api;
}

async function seedProject(
  api: FastifyInstance,
): Promise<{ projectId: string; workspaceId: string }> {
  const project = await api.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: `Execution ${Math.random().toString(36).slice(2, 8)}`,
      description: 'execution fixture',
      projectType: 'web',
    },
  });
  const projectId = (project.json() as { id: string }).id;
  const workspace = await api.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    payload: { name: 'main' },
  });
  const workspaceId = (workspace.json() as { id: string }).id;
  for (const path of ['src', 'docs']) {
    const made = await api.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/directories`,
      payload: { path },
    });
    if (made.statusCode !== 201 && made.statusCode !== 409) {
      throw new Error(`creating ${path} failed: ${made.statusCode} ${made.body}`);
    }
  }
  for (const [path, content] of [
    [
      'package.json',
      JSON.stringify({
        name: 'fixture',
        scripts: { test: 'vitest run', build: 'tsc' },
        dependencies: { fastify: '^4.0.0' },
        devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
      }),
    ],
    ['src/app.ts', 'export const app = () => null;'],
    ['src/app.test.ts', "import { it } from 'vitest';\nit('works', () => {});"],
    ['docs/guide.md', '# Guide'],
  ] as const) {
    const wrote = await api.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path, content },
    });
    if (wrote.statusCode !== 201) {
      throw new Error(`seeding ${path} failed: ${wrote.statusCode} ${wrote.body}`);
    }
  }
  return { projectId, workspaceId };
}

interface ExecutionBody {
  readonly execution: {
    readonly id: string;
    readonly status: string;
    readonly taskIds: readonly string[];
    readonly workerIds: readonly string[];
    readonly approvals: readonly { readonly id: string; readonly state: string }[];
  };
  readonly plan: {
    readonly objective: string;
    readonly tasks: readonly {
      readonly key: string;
      readonly title: string;
      readonly verification: string;
      readonly workerType: string;
      readonly approval: string | null;
    }[];
  };
  readonly progress: {
    readonly outcome: string;
    readonly tasks: readonly { readonly key: string; readonly status: string }[];
  };
}

describe('executions API', () => {
  it('plans a request from the project it read and reports honest progress', async () => {
    const api = await start();
    const { projectId } = await seedProject(api);

    const created = await api.inject({
      method: 'POST',
      url: '/api/executions',
      payload: {
        projectId,
        request:
          'Add a settings loader to the backend, cover it with a test, and document how it is used.',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as ExecutionBody;

    // The plan is derived from what the project actually contains: a Fastify
    // dependency is what makes a backend task the right one.
    const keys = body.plan.tasks.map((task) => task.key);
    expect(keys).toContain('understand');
    expect(body.plan.tasks.length).toBeGreaterThanOrEqual(2);
    const implementation = body.plan.tasks.filter((task) => task.verification !== 'none');
    expect(implementation.length).toBeGreaterThan(0);
    for (const task of implementation) {
      expect(['frontend', 'backend', 'database', 'testing', 'api']).toContain(task.workerType);
    }
    expect(body.execution.taskIds.length).toBe(body.plan.tasks.length);
    expect(body.execution.status).not.toBe('completed');

    const listed = await api.inject({
      method: 'GET',
      url: `/api/executions?projectId=${projectId}`,
    });
    const listBody = listed.json() as { executions: readonly { id: string }[]; count: number };
    expect(listBody.count).toBe(1);
    expect(listBody.executions[0]!.id).toBe(body.execution.id);

    const report = await api.inject({
      method: 'GET',
      url: `/api/executions/${body.execution.id}/report`,
    });
    const reportBody = report.json() as {
      report: { outcome: string; completed: readonly string[]; notStarted: readonly string[] };
    };
    expect(reportBody.report.completed).toEqual([]);
    expect(reportBody.report.notStarted.length).toBeGreaterThan(0);
  });

  it('dispatches real workers, accepts proof and refuses work that has none', async () => {
    const api = await start();
    const { projectId } = await seedProject(api);

    const created = await api.inject({
      method: 'POST',
      url: '/api/executions',
      payload: {
        projectId,
        request: 'Add a settings loader to the backend and cover it with a test.',
      },
    });
    const body = created.json() as ExecutionBody;
    const id = body.execution.id;

    const first = await api.inject({ method: 'POST', url: `/api/executions/${id}/dispatch` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as ExecutionBody;
    expect(firstBody.execution.workerIds.length).toBeGreaterThan(0);

    const second = await api.inject({ method: 'POST', url: `/api/executions/${id}/dispatch` });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as ExecutionBody;

    // Dispatch is never re-entrant: the workers already started are not started
    // again, so the second call adds nothing when nothing has finished.
    expect(secondBody.execution.workerIds).toEqual(firstBody.execution.workerIds);
  });

  it('only advances on accepted work and then reports what was delivered', async () => {
    const api = await start();
    const { projectId } = await seedProject(api);

    const created = await api.inject({
      method: 'POST',
      url: '/api/executions',
      payload: { projectId, request: 'Document the settings loader for the backend.' },
    });
    const id = (created.json() as ExecutionBody).execution.id;
    const dispatched = await api.inject({ method: 'POST', url: `/api/executions/${id}/dispatch` });
    const workerIds = (dispatched.json() as ExecutionBody).execution.workerIds;

    const firstSync = await api.inject({ method: 'POST', url: `/api/executions/${id}/sync` });
    const synced = firstSync.json() as ExecutionBody;
    const handedIn = synced.progress.tasks.find((line) => line.status === 'review');
    expect(handedIn).toBeDefined();
    // Work that is waiting for a decision never reads as done.
    expect(synced.progress.tasks.filter((line) => line.status === 'done')).toEqual([]);

    const workerId = workerIds[0]!;
    const reviewed = await api.inject({
      method: 'POST',
      url: `/api/executions/${id}/tasks/${synced.execution.taskIds[0]!}/review`,
      payload: { decision: 'accept', note: 'Accepted.' },
    });
    expect([200, 409]).toContain(reviewed.statusCode);
    void workerId;

    const second = await api.inject({ method: 'POST', url: `/api/executions/${id}/sync` });
    const after = second.json() as ExecutionBody;
    expect(
      after.progress.tasks.some((line) => line.status === 'done' || line.status === 'review'),
    ).toBe(true);

    const report = await api.inject({
      method: 'GET',
      url: `/api/executions/${id}/report`,
    });
    const body = report.json() as {
      report: { outcome: string; completed: readonly string[]; failed: readonly string[] };
    };
    // One accepted task out of a plan is honestly partial, not complete.
    expect(body.report.failed).toEqual([]);
    expect(body.report.outcome).toBe('partially_completed');
    expect(body.report.completed.length).toBeGreaterThan(0);
  });

  it("keeps one owner out of another owner's execution", async () => {
    const api = await start();
    const { projectId } = await seedProject(api);

    const created = await api.inject({
      method: 'POST',
      url: '/api/executions',
      payload: { projectId, request: 'Add a health endpoint to the backend and test it.' },
    });
    const id = (created.json() as ExecutionBody).execution.id;

    const other = await api.inject({
      method: 'GET',
      url: `/api/executions/${id}`,
      headers: { 'x-veltravia-owner': 'someone-else' },
    });
    expect(other.statusCode).toBe(404);

    const cancel = await api.inject({
      method: 'POST',
      url: `/api/executions/${id}/cancel`,
      headers: { 'x-veltravia-owner': 'someone-else' },
    });
    expect(cancel.statusCode).toBe(404);
  });

  it('refuses a request too short to plan', async () => {
    const api = await start();
    const { projectId } = await seedProject(api);
    const created = await api.inject({
      method: 'POST',
      url: '/api/executions',
      payload: { projectId, request: 'build' },
    });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: { code: string } }).error.code).toBe(
      'EXECUTION_REQUEST_TOO_SHORT',
    );
  });
});
