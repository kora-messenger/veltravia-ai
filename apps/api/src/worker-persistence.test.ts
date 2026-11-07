/**
 * Worker records survive a restart.
 *
 * One app instance delegates, runs and reviews a worker; a SECOND instance with
 * its own pools, managers and scheduler reads the whole thing back: the worker,
 * its events, the scheduling decision and the completed task. Skipped without
 * `VELTRAVIA_TEST_DATABASE_URL`.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPersistence, type Persistence } from './persistence.js';
import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';
import { prepareIsolatedTestSchema } from '@veltravia/storage-postgres';

// These tests are about durability across a restart, so the scripted executor is pinned.
process.env['VELTRAVIA_WORKER_EXECUTOR'] = 'simulated';

const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
/** This file's own schema, bound in beforeAll so parallel files cannot collide. */
let databaseUrl = baseDatabaseUrl;
const describeDb = databaseUrl === '' ? describe.skip : describe;

function makeApp(persistence: Persistence): FastifyInstance {
  return buildApp({
    persistence,
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
}

const assignment = {
  objective: 'Build the checkout summary.',
  scope: ['src/checkout'],
  exclusions: ['src/checkout/keys.ts'],
  deliverables: [
    { name: 'summary', kind: 'file', path: 'src/checkout/summary.tsx', summary: 'The summary' },
  ],
  acceptanceCriteria: ['renders the totals', 'stays inside src/checkout'],
  allowedTools: ['project.read', 'project.write'],
  permissions: { readProject: true, writeProject: true, runTools: false, network: false },
  limits: { maxDurationMs: 20_000, maxToolCalls: 10, maxDeliverables: 3 },
  dependencies: [],
  checkpoints: ['after render'],
  cancellationConditions: ['owner cancels'],
  reporting: ['files written'],
};

describeDb('workers survive a restart', () => {
  let first: Persistence;
  let second: Persistence;
  let app: FastifyInstance;
  let restarted: FastifyInstance;
  const owner = `owner-workers-${Date.now()}`;
  let taskId = '';
  let workerId = '';

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'worker-persistence')) ?? '';
    first = await createPersistence({ url: databaseUrl });
    second = await createPersistence({ url: databaseUrl });
    app = makeApp(first);
    restarted = makeApp(second);

    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { name: 'Worker restart', description: 'fixture', projectType: 'web' },
    });
    const projectId = (project.json() as { id: string }).id;
    const task = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { projectId, title: 'Checkout summary', objective: 'Build the summary screen.' },
    });
    taskId = (task.json() as { task: { id: string } }).task.id;

    const delegated = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/workers`,
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { workerType: 'frontend', assignment },
    });
    workerId = (delegated.json() as { worker: { id: string } }).worker.id;

    await app.inject({
      method: 'POST',
      url: '/api/scheduler/plan',
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { limit: 1 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/start`,
      headers: { 'x-veltravia-owner-ref': owner },
    });
    await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/review`,
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { decision: 'accept', summary: 'Accepted.', criteriaResults: [true, true] },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await restarted?.close();
    await first?.close();
    await second?.close();
  });

  it('reads the finished worker from a second instance', async () => {
    const response = await restarted.inject({
      method: 'GET',
      url: `/api/workers/${workerId}`,
      headers: { 'x-veltravia-owner-ref': owner },
    });
    expect(response.statusCode).toBe(200);
    const { worker } = response.json() as {
      worker: {
        status: string;
        attempts: number;
        review: { decision: string };
        assignment: { objective: string };
      };
    };
    expect(worker.status).toBe('completed');
    expect(worker.attempts).toBe(1);
    expect(worker.review.decision).toBe('accept');
    expect(worker.assignment.objective).toBe('Build the checkout summary.');
  });

  it('keeps the event history and the scheduling decision', async () => {
    const events = await restarted.inject({
      method: 'GET',
      url: `/api/workers/${workerId}/events`,
      headers: { 'x-veltravia-owner-ref': owner },
    });
    expect(events.statusCode).toBe(200);
    const { events: rows } = events.json() as { events: { type: string }[] };
    expect(rows.map((row) => row.type)).toContain('reviewed');
    expect(rows.length).toBeGreaterThan(3);

    const decisions = await restarted.inject({
      method: 'GET',
      url: '/api/scheduler/decisions',
      headers: { 'x-veltravia-owner-ref': owner },
    });
    expect((decisions.json() as { decisions: unknown[] }).decisions.length).toBeGreaterThan(0);
  });

  it('reports the task as completed for the same owner only', async () => {
    const mine = await restarted.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/superagents`,
      headers: { 'x-veltravia-owner-ref': owner },
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { taskStatus: string }).taskStatus).toBe('completed');

    const theirs = await restarted.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/superagents`,
      headers: { 'x-veltravia-owner-ref': 'owner-someone-else' },
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('gives the restarted scheduler nothing left to start', async () => {
    const plan = await restarted.inject({
      method: 'POST',
      url: '/api/scheduler/plan',
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { limit: 2 },
    });
    expect((plan.json() as { selected: unknown[] }).selected).toHaveLength(0);
  });
});
