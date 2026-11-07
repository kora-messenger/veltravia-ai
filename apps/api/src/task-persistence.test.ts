/**
 * Task records survive an API restart.
 *
 * A task created, attempted and progressed by one app instance is read back by
 * a second instance with its own pools and its own managers. Nothing is shared
 * except the database, which is the whole point.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`; CI provides postgres:16.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveDeploymentConfig } from './deployment/config.js';
import { createPersistence, type Persistence } from './persistence.js';
import { buildApp } from './server.js';

const databaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = databaseUrl === '' ? describe.skip : describe;

// Unique per run: the database outlives the process, and the suite must not
// depend on an empty one.
const OWNER = `task-restart-${Date.now().toString(36)}`;
const OTHER = `${OWNER}-other`;

function makeApp(persistence: Persistence): FastifyInstance {
  return buildApp({
    persistence,
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
}

describeDb('task records survive a restart', () => {
  let first: Persistence;
  let app: FastifyInstance;
  let reopened: Persistence;
  let reopenedApp: FastifyInstance;
  let projectId = '';
  let taskId = '';

  const headers = (owner = OWNER) => ({ 'x-veltravia-owner-ref': owner });

  beforeAll(async () => {
    first = await createPersistence({ url: databaseUrl });
    app = makeApp(first);
    await app.ready();

    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: headers(),
      payload: {
        name: 'Restart tasks',
        description: 'Task restart fixture',
        projectType: 'web',
      },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { id: string }).id;

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: headers(),
      payload: {
        title: 'Survive a restart',
        objective: 'Create a task, attempt it and read it back in a new process.',
        projectId,
        chatId: 'chat_restart',
      },
    });
    expect(created.statusCode).toBe(201);
    taskId = (created.json() as { task: { id: string } }).task.id;

    const started = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/attempts`,
      headers: headers(),
      payload: { runId: 'run_restart_1' },
    });
    expect(started.statusCode).toBe(201);

    await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/progress`,
      headers: headers(),
      payload: { step: 'writing', message: 'Writing the page', percent: 30 },
    });

    reopened = await createPersistence({ url: databaseUrl });
    reopenedApp = makeApp(reopened);
    await reopenedApp.ready();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await reopenedApp?.close();
  });

  it('reports the store honestly', async () => {
    const response = await reopenedApp.inject({
      method: 'GET',
      url: '/api/orchestration/contract',
    });
    const body = response.json() as { storage: { store: string; durable: boolean } };
    expect(body.storage.store).toBe('postgres');
    expect(body.storage.durable).toBe(true);
  });

  it('reads the task back in a second instance, with its state intact', async () => {
    const response = await reopenedApp.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    const { task } = response.json() as {
      task: {
        id: string;
        status: string;
        projectId: string;
        chatId: string;
        retry: { attempts: number };
      };
    };
    expect(task.status).toBe('running');
    expect(task.projectId).toBe(projectId);
    expect(task.chatId).toBe('chat_restart');
    expect(task.retry.attempts).toBe(1);
  });

  it('reads the event trail and the attempt, including the progress note', async () => {
    const events = await reopenedApp.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: headers(),
    });
    expect(events.statusCode).toBe(200);
    const trail = (events.json() as { events: { type: string; detail: unknown }[] }).events;
    expect(trail.map((event) => event.type)).toEqual(['created', 'attempt_started', 'progress']);
    expect(trail[2]?.detail).toMatchObject({ step: 'writing', percent: 30 });

    const attempts = await reopenedApp.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/attempts`,
      headers: headers(),
    });
    const rows = (attempts.json() as { attempts: { runId: string }[] }).attempts;
    expect(rows[0]?.runId).toBe('run_restart_1');
  });

  it('lets the second instance continue the task, visible to the first', async () => {
    const moved = await reopenedApp.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/transitions`,
      headers: headers(),
      payload: { to: 'blocked', message: 'Waiting on the brand copy' },
    });
    expect(moved.statusCode).toBe(200);

    const seenFromFirst = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: headers(),
    });
    expect((seenFromFirst.json() as { task: { status: string } }).task.status).toBe('blocked');
  });

  it('keeps another owner out in both instances', async () => {
    for (const instance of [app, reopenedApp]) {
      const response = await instance.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: headers(OTHER),
      });
      expect(response.statusCode).toBe(404);
    }
    const list = await reopenedApp.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: headers(OTHER),
    });
    expect((list.json() as { tasks: unknown[] }).tasks).toHaveLength(0);
  });
});
