/**
 * Superagent workers over HTTP.
 *
 * These tests are about the boundary Step 43 adds: a worker can be delegated
 * only inside a task the caller owns, its assignment is validated before it is
 * stored, two workers cannot hold the same directory, and nothing reaches
 * `completed` without a recorded Primary Agent review.
 *
 * The shipped executor is a simulation; every test that says "runs" means the
 * simulated run, which is the only one this build can perform.
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
  objective: 'Build the billing settings screen.',
  scope: ['src/billing'],
  exclusions: ['src/billing/secrets.ts'],
  deliverables: [
    { name: 'billing screen', kind: 'file', path: 'src/billing/screen.tsx', summary: 'The screen' },
  ],
  acceptanceCriteria: ['the screen renders the three plans', 'nothing outside src/billing changed'],
  allowedTools: ['project.read', 'project.write'],
  permissions: { readProject: true, writeProject: true, runTools: true, network: false },
  limits: { maxDurationMs: 30_000, maxToolCalls: 20, maxDeliverables: 4 },
  dependencies: [],
  checkpoints: ['after the first render'],
  cancellationConditions: ['the owner cancels'],
  reporting: ['list the files written'],
  ...overrides,
});

async function seed(ownerHeader?: string): Promise<{ projectId: string; taskId: string }> {
  const server = app as FastifyInstance;
  const project = await server.inject({
    method: 'POST',
    url: '/api/projects',
    headers: ownerHeader === undefined ? {} : { 'x-veltravia-owner-ref': ownerHeader },
    payload: { name: 'Worker QA', description: 'Fixture', projectType: 'web' },
  });
  const projectId = (project.json() as { id: string }).id;
  const task = await server.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: ownerHeader === undefined ? {} : { 'x-veltravia-owner-ref': ownerHeader },
    payload: {
      projectId,
      title: 'Billing settings',
      objective: 'Ship the billing settings screen.',
    },
  });
  // The task route answers with an envelope; the project route answers flat.
  return { projectId, taskId: (task.json() as { task: { id: string } }).task.id };
}

async function delegate(taskId: string, overrides: Record<string, unknown> = {}) {
  const server = app as FastifyInstance;
  return server.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/workers`,
    payload: { workerType: 'frontend', assignment: assignment(overrides) },
  });
}

describe('delegating work', () => {
  it('creates a queued worker that inherits the task', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seed();
    const response = await delegate(taskId);
    expect(response.statusCode).toBe(201);
    const { worker } = response.json() as { worker: Record<string, unknown> };
    expect(worker['status']).toBe('queued');
    expect(worker['taskId']).toBe(taskId);
    expect(worker['attempts']).toBe(0);
  });

  it('refuses an assignment with no exclusions', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seed();
    const response = await delegate(taskId, { exclusions: [] });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'WORKER_ASSIGNMENT_INVALID',
    );
  });

  it('refuses a tool outside the catalog', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seed();
    const response = await delegate(taskId, { allowedTools: ['project.read', 'shell.root'] });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a deliverable outside the declared scope', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seed();
    const response = await delegate(taskId, {
      deliverables: [{ name: 'x', kind: 'file', path: 'src/elsewhere/x.tsx' }],
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a second live worker on the same task', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seed();
    expect((await delegate(taskId)).statusCode).toBe(201);
    const second = await delegate(taskId);
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe(
      'WORKER_DUPLICATE_ASSIGNMENT',
    );
  });

  it('refuses a worker whose scope overlaps another live worker', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const first = await seed();
    const second = await seed();
    expect((await delegate(first.taskId)).statusCode).toBe(201);
    const response = await delegate(second.taskId);
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'WORKER_RESOURCE_CONFLICT',
    );
  });

  it('answers 404 for another owner’s task', async () => {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    const { taskId } = await seed();
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/workers`,
      headers: { 'x-veltravia-owner-ref': 'owner-other' },
      payload: { workerType: 'frontend', assignment: assignment() },
    });
    expect(response.statusCode).toBe(404);
  });
});
