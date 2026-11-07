/**
 * Task orchestration over HTTP.
 *
 * These tests are about the boundary, not the state machine (the core suite
 * covers that): can a caller reach a task they do not own, can a status change
 * be asserted rather than requested, and does an error leak another owner's
 * existence. They run on the in-memory store, which is what a server without a
 * database uses.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveDeploymentConfig } from './deployment/config.js';
import { buildApp } from './server.js';

const OWNER = 'tasks-owner';
const OTHER = 'tasks-other';

let app: FastifyInstance;
let projectId = '';

function headers(owner = OWNER) {
  return { 'x-veltravia-owner-ref': owner };
}

beforeAll(async () => {
  app = buildApp({
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
  await app.ready();

  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: headers(),
    payload: { name: 'Task project', description: 'Orchestration fixture', projectType: 'web' },
  });
  expect(project.statusCode).toBe(201);
  projectId = (project.json() as { id: string }).id;
});

afterAll(async () => {
  await app?.close();
});

async function createTask(overrides: Record<string, unknown> = {}, owner = OWNER) {
  return app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: headers(owner),
    payload: {
      title: 'Build the pricing page',
      objective: 'Add a pricing page, register its route and cover it with a test.',
      projectId,
      chatId: 'chat_local_1',
      ...overrides,
    },
  });
}

const assignment = {
  worker: 'superagent',
  objective: 'Add a pricing page and register its route',
  scope: { projectId: '__PROJECT__', workspaceId: null, paths: [] },
  expectedOutputs: ['pricing page'],
  acceptance: [{ id: 'renders', statement: 'The page renders', required: true }],
  allowedTools: ['read_file', 'write_file'],
  permissions: {
    canReadProject: true,
    canWriteProject: true,
    canRunTools: false,
    canUseNetwork: false,
  },
  limits: { maxDurationMs: null, maxToolCalls: null },
  dependsOn: [],
  checkpoint: null,
  reportingRequirements: ['what changed'],
};

describe('the orchestration contract route', () => {
  it('publishes the contract and says plainly what is not implemented', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/orchestration/contract' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      contract: { responsibilities: unknown[]; notYetImplemented: string[] };
      reservedResponsibilities: string[];
      storage: { store: string; durable: boolean; multiInstance: boolean };
    };
    expect(body.contract.responsibilities).toHaveLength(11);
    expect(body.reservedResponsibilities).toContain('result_review');
    expect(body.contract.notYetImplemented.join(' ')).toMatch(/No worker executes an assignment/);
    expect(body.storage).toEqual({ store: 'memory', durable: false, multiInstance: false });
  });
});

describe('creating and reading a task', () => {
  it('creates a queued task with an owner and a verified project scope', async () => {
    const response = await createTask();
    expect(response.statusCode).toBe(201);
    const { task, storage } = response.json() as {
      task: { id: string; status: string; ownerRef: string; projectId: string; chatId: string };
      storage: { store: string; durable: boolean };
    };
    expect(task.status).toBe('queued');
    expect(task.ownerRef).toBe(OWNER);
    expect(task.projectId).toBe(projectId);
    expect(task.chatId).toBe('chat_local_1');
    expect(storage).toEqual({ store: 'memory', durable: false });
  });

  it('refuses a project the caller does not own, without confirming it exists', async () => {
    const response = await createTask({}, OTHER);
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'TASK_PROJECT_FORBIDDEN',
    );
  });

  it('hides another owner task behind the same 404 as a missing one', async () => {
    const created = await createTask();
    const taskId = (created.json() as { task: { id: string } }).task.id;

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: headers(OTHER),
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/tasks/task_doesnotexist',
      headers: headers(OTHER),
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
  });

  it('lists only the caller tasks and can filter by status', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/tasks', headers: headers() });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { tasks: unknown[] }).tasks.length).toBeGreaterThan(0);

    const other = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: headers(OTHER),
    });
    expect((other.json() as { tasks: unknown[] }).tasks).toHaveLength(0);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/tasks?status=cancelled',
      headers: headers(),
    });
    const body = filtered.json() as { tasks: { status: string }[] };
    expect(body.tasks.every((task) => task.status === 'cancelled')).toBe(true);
  });
});

describe('the lifecycle over HTTP', () => {
  it('accepts a valid transition and refuses an invalid one', async () => {
    const created = await createTask();
    const taskId = (created.json() as { task: { id: string } }).task.id;

    const planned = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/transitions`,
      headers: headers(),
      payload: { to: 'planning', message: 'Planning the page' },
    });
    expect(planned.statusCode).toBe(200);
    expect((planned.json() as { task: { status: string } }).task.status).toBe('planning');

    const jumped = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/transitions`,
      headers: headers(),
      payload: { to: 'completed' },
    });
    expect(jumped.statusCode).toBe(400);
    expect((jumped.json() as { error: { code: string } }).error.code).toBe(
      'TASK_TRANSITION_INVALID',
    );
  });

  it('refuses an unknown status and a stale version', async () => {
    const created = await createTask();
    const taskId = (created.json() as { task: { id: string } }).task.id;

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/transitions`,
      headers: headers(),
      payload: { to: 'done' },
    });
    expect(unknown.statusCode).toBe(400);

    await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/transitions`,
      headers: headers(),
      payload: { to: 'planning' },
    });
    const stale = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/transitions`,
      headers: headers(),
      payload: { to: 'running', expectedVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe('TASK_VERSION_CONFLICT');
  });

  it('cancels a task and refuses a second cancel', async () => {
    const created = await createTask();
    const taskId = (created.json() as { task: { id: string } }).task.id;

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/cancel`,
      headers: headers(),
      payload: { reason: 'Superseded by a smaller change' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { task: { status: string } }).task.status).toBe('cancelled');

    const again = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/cancel`,
      headers: headers(),
      payload: { reason: 'Again' },
    });
    expect(again.statusCode).toBe(400);
  });

  it('refuses a dependency on a task that does not exist', async () => {
    const created = await createTask();
    const taskId = (created.json() as { task: { id: string } }).task.id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/dependencies`,
      headers: headers(),
      payload: { dependsOnTaskId: 'task_missing' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'TASK_DEPENDENCY_INVALID',
    );
  });

  it('rejects an assignment missing its acceptance criteria', async () => {
    const created = await createTask();
    const taskId = (created.json() as { task: { id: string } }).task.id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/assignment`,
      headers: headers(),
      payload: { ...assignment, scope: { ...assignment.scope, projectId }, acceptance: [] },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('ASSIGNMENT_INVALID');
  });
});

describe('judgement and review', () => {
  async function taskWithAssignment(maxAttempts = 2) {
    const created = await createTask({ maxAttempts });
    const taskId = (created.json() as { task: { id: string } }).task.id;
    const assigned = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/assignment`,
      headers: headers(),
      payload: { ...assignment, scope: { ...assignment.scope, projectId } },
    });
    expect(assigned.statusCode).toBe(200);
    return taskId;
  }

  it('records an attempt, waits for review, and completes only on acceptance', async () => {
    const taskId = await taskWithAssignment();

    const started = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attempts`,
      headers: headers(),
      payload: { runId: 'run_abc' },
    });
    expect(started.statusCode).toBe(201);

    const finished = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attempts/1/finish`,
      headers: headers(),
      payload: {
        summary: 'Pricing page added',
        outputs: ['pricing page'],
        acceptance: [{ criterionId: 'renders', satisfied: true }],
      },
    });
    expect(finished.statusCode).toBe(200);
    const awaiting = (finished.json() as { task: { status: string; reviewStatus: string } }).task;
    expect(awaiting.status).toBe('awaiting_review');
    expect(awaiting.reviewStatus).toBe('pending');

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: headers(),
      payload: { decision: 'accept', summary: 'Checked it against the page' },
    });
    expect(accepted.statusCode).toBe(200);
    const done = (accepted.json() as { task: { status: string; completedAt: string | null } }).task;
    expect(done.status).toBe('completed');
    expect(done.completedAt).not.toBeNull();
  });

  it('sends rejected work back to running', async () => {
    const taskId = await taskWithAssignment();
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attempts`,
      headers: headers(),
      payload: {},
    });
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attempts/1/finish`,
      headers: headers(),
      payload: { summary: 'Half the page', outputs: [], acceptance: [] },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: headers(),
      payload: { decision: 'reject', summary: 'The route is missing' },
    });
    expect(rejected.statusCode).toBe(200);
    expect((rejected.json() as { task: { status: string } }).task.status).toBe('running');
  });

  it('records a failure and refuses a retry beyond the attempt budget', async () => {
    const taskId = await taskWithAssignment(1);
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attempts`,
      headers: headers(),
      payload: {},
    });
    const failed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attempts/1/finish`,
      headers: headers(),
      payload: {
        summary: 'Build failed',
        outputs: [],
        acceptance: [],
        failure: { code: 'BUILD_FAILED', message: 'The build did not finish.' },
      },
    });
    expect((failed.json() as { task: { status: string } }).task.status).toBe('failed');

    const retried = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/retry`,
      headers: headers(),
      payload: { reason: 'One more go' },
    });
    expect(retried.statusCode).toBe(400);
    expect((retried.json() as { error: { code: string } }).error.code).toBe('TASK_RETRY_REFUSED');
  });

  it('exposes the attempt history and the event trail', async () => {
    const taskId = await taskWithAssignment();
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attempts`,
      headers: headers(),
      payload: { runId: 'run_history' },
    });
    const attempts = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/attempts`,
      headers: headers(),
    });
    const attemptRows = (attempts.json() as { attempts: { runId: string; status: string }[] })
      .attempts;
    expect(attemptRows[0]?.runId).toBe('run_history');
    expect(attemptRows[0]?.status).toBe('running');

    const events = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: headers(),
    });
    const trail = (events.json() as { events: { type: string }[] }).events;
    expect(trail.map((event) => event.type)).toEqual([
      'created',
      'assignment_set',
      'attempt_started',
    ]);
  });
});

describe('refusing credentials in task text', () => {
  it('rejects an objective that looks like a secret', async () => {
    const response = await createTask({
      objective: 'Deploy using sk-live-abcdef1234567890abcdef1234567890',
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'TASK_SECRET_REJECTED',
    );
  });
});
