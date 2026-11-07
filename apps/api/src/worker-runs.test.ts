/**
 * Running a worker, reviewing it, and scheduling several at once.
 *
 * The executor here is the shipped simulation, so "runs" means a simulated run.
 * What is real is everything around it: the task attempt, the review gate, the
 * concurrency limit, the recorded scheduling decision and the progress report.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

const assignment = (overrides: Record<string, unknown> = {}) => ({
  objective: 'Build one screen.',
  scope: ['src/screen'],
  exclusions: ['src/screen/secret.ts'],
  deliverables: [
    { name: 'screen', kind: 'file', path: 'src/screen/screen.tsx', summary: 'The screen' },
  ],
  acceptanceCriteria: ['renders', 'stays in scope'],
  allowedTools: ['project.read', 'project.write'],
  permissions: { readProject: true, writeProject: true, runTools: false, network: false },
  limits: { maxDurationMs: 20_000, maxToolCalls: 10, maxDeliverables: 3 },
  dependencies: [],
  checkpoints: ['after render'],
  cancellationConditions: ['owner cancels'],
  reporting: ['files written'],
  ...overrides,
});

async function seedTask(): Promise<{ projectId: string; taskId: string }> {
  const server = app as FastifyInstance;
  const project = await server.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: `Runs ${Math.random().toString(36).slice(2, 8)}`,
      description: 'f',
      projectType: 'web',
    },
  });
  const projectId = (project.json() as { id: string }).id;
  const task = await server.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { projectId, title: 'Screen', objective: 'Build the screen.' },
  });
  return { projectId, taskId: (task.json() as { task: { id: string } }).task.id };
}

async function delegate(taskId: string, scope: string[] = ['src/screen']) {
  const server = app as FastifyInstance;
  const response = await server.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/workers`,
    payload: {
      workerType: 'frontend',
      assignment: assignment({
        scope,
        deliverables: [
          { name: 'file', kind: 'file', path: `${scope[0]}/file.tsx`, summary: 'The file' },
        ],
        exclusions: [`${scope[0]}/secret.ts`],
      }),
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`delegate failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { worker: { id: string } }).worker.id;
}

describe('running and reviewing', () => {
  it('runs to awaiting_review and leaves the task uncompleted', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seedTask();
    const workerId = await delegate(taskId);
    const run = await app.inject({ method: 'POST', url: `/api/workers/${workerId}/start` });
    expect(run.statusCode).toBe(200);
    const { worker } = run.json() as {
      worker: { status: string; result: { deliverables: unknown[] } };
    };
    expect(worker.status).toBe('awaiting_review');
    expect(worker.result.deliverables.length).toBeGreaterThan(0);

    const task = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect((task.json() as { task: { status: string } }).task.status).toBe('awaiting_review');
  });

  it('completes only through a recorded review', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seedTask();
    const workerId = await delegate(taskId);
    await app.inject({ method: 'POST', url: `/api/workers/${workerId}/start` });

    const review = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/review`,
      payload: { decision: 'accept', summary: 'Looks right.', criteriaResults: [true, true] },
    });
    expect(review.statusCode).toBe(200);
    expect((review.json() as { worker: { status: string } }).worker.status).toBe('completed');

    const task = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect((task.json() as { task: { status: string } }).task.status).toBe('completed');
  });

  it('refuses acceptance when a criterion was never checked', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seedTask();
    const workerId = await delegate(taskId);
    await app.inject({ method: 'POST', url: `/api/workers/${workerId}/start` });
    const review = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/review`,
      payload: { decision: 'accept', summary: 'Fine.', criteriaResults: [true] },
    });
    expect(review.statusCode).toBe(409);
    expect((review.json() as { error: { code: string } }).error.code).toBe('WORKER_REVIEW_REFUSED');
  });

  it('refuses acceptance when the project changed outside the assignment', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seedTask();
    const workerId = await delegate(taskId);
    await app.inject({ method: 'POST', url: `/api/workers/${workerId}/start` });
    const review = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/review`,
      payload: {
        decision: 'accept',
        summary: 'Fine.',
        criteriaResults: [true, true],
        changedPaths: ['src/screen/file.tsx', 'src/elsewhere/hack.ts'],
      },
    });
    expect(review.statusCode).toBe(409);
  });

  it('records a rejection and allows one controlled re-queue', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seedTask();
    const workerId = await delegate(taskId);
    await app.inject({ method: 'POST', url: `/api/workers/${workerId}/start` });
    const review = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/review`,
      payload: {
        decision: 'reject',
        summary: 'Not the right screen.',
        criteriaResults: [false, true],
      },
    });
    expect(review.statusCode).toBe(200);
    const requeue = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/requeue`,
      payload: { reason: 'Try again with the correct layout.' },
    });
    expect(requeue.statusCode).toBe(200);
    const { worker } = requeue.json() as { worker: { status: string; retryNotBefore: string } };
    expect(worker.status).toBe('queued');
    expect(worker.retryNotBefore).not.toBeNull();
  });

  it('cancels queued work and its task', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seedTask();
    const workerId = await delegate(taskId);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/cancel`,
      payload: { reason: 'Not needed now.' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { worker: { status: string } }).worker.status).toBe('cancelled');
  });

  it('answers 404 for a worker that does not exist', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const response = await app.inject({ method: 'GET', url: '/api/workers/wkr_missing' });
    expect(response.statusCode).toBe(404);
  });
});

describe('scheduling', () => {
  it('respects the concurrency limit and records why the rest wait', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const first = await seedTask();
    const second = await seedTask();
    await delegate(first.taskId, ['src/one']);
    await delegate(second.taskId, ['src/two']);

    const plan = await app.inject({
      method: 'POST',
      url: '/api/scheduler/plan',
      payload: { limit: 1 },
    });
    expect(plan.statusCode).toBe(200);
    const body = plan.json() as { selected: unknown[]; skipped: { reason: string }[] };
    expect(body.selected).toHaveLength(1);
    expect(body.skipped.map((entry) => entry.reason)).toContain('limit_reached');
  });

  it('dispatches independent work in parallel within the limit', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const first = await seedTask();
    const second = await seedTask();
    await delegate(first.taskId, ['src/one']);
    await delegate(second.taskId, ['src/two']);

    const dispatch = await app.inject({
      method: 'POST',
      url: '/api/scheduler/dispatch',
      payload: { limit: 2 },
    });
    expect(dispatch.statusCode).toBe(200);
    const body = dispatch.json() as { started: { status: string }[]; decision: { id: string } };
    expect(body.started).toHaveLength(2);
    expect(body.started.every((worker) => worker.status === 'awaiting_review')).toBe(true);

    const decisions = await app.inject({ method: 'GET', url: '/api/scheduler/decisions' });
    expect((decisions.json() as { decisions: unknown[] }).decisions.length).toBeGreaterThan(0);
  });

  it('reports progress the way a future task screen will read it', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seedTask();
    const workerId = await delegate(taskId);
    await app.inject({ method: 'POST', url: `/api/workers/${workerId}/start` });

    const progress = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/superagents` });
    expect(progress.statusCode).toBe(200);
    const body = progress.json() as {
      active: { status: string }[];
      awaitingReview: string[];
      deliverables: { name: string }[];
      taskStatus: string;
      reviewStatus: string | null;
    };
    expect(body.taskStatus).toBe('awaiting_review');
    expect(body.active[0]?.status).toBe('awaiting_review');
    expect(body.awaitingReview).toHaveLength(1);
    expect(body.deliverables.length).toBeGreaterThan(0);
    expect(body.reviewStatus).toBe('pending');
  });

  it('keeps another owner out of the progress report', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seedTask();
    const response = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/superagents`,
      headers: { 'x-veltravia-owner-ref': 'owner-other' },
    });
    expect(response.statusCode).toBe(404);
  });
});
