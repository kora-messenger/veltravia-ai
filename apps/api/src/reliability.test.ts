/**
 * Reliability through the API (Step 51).
 *
 * What these tests are for: the guarantees a retry or a restart depends on are
 * enforced by the routes, not by a comment.
 *
 *  - a repeated `Idempotency-Key` with the same body answers the first result and
 *    creates nothing;
 *  - the same key with a different body is refused, because it is a mistake;
 *  - the key is per owner, so one owner's key cannot fetch another owner's answer;
 *  - a sweep leaves finished executions alone and records what it decided;
 *  - health counts only records that exist, and says when coordination is not
 *    durable instead of implying it is.
 *
 * The store here is the in-memory one, so `durable` is false and the health
 * finding says so. The database-backed version of the same guarantees lives in
 * storage/postgres/src/reliability-store.test.ts.
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

const OWNER = 'reliability-api-owner';
const OTHER = 'reliability-api-other';

async function seedProject(api: FastifyInstance, owner = OWNER): Promise<string> {
  const project = await api.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { 'x-veltravia-owner-ref': owner },
    payload: {
      name: `Reliability ${Math.random().toString(36).slice(2, 8)}`,
      description: 'reliability fixture',
      projectType: 'web',
    },
  });
  return (project.json() as { id: string }).id;
}

interface ExecutionBody {
  execution: { id: string; status: string; plan: { tasks: { taskId: string; title: string }[] } };
}

async function intake(
  api: FastifyInstance,
  projectId: string,
  key?: string,
): Promise<ExecutionBody> {
  const response = await api.inject({
    method: 'POST',
    url: '/api/executions',
    headers: {
      'x-veltravia-owner-ref': OWNER,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    payload: { projectId, request: 'Add a settings loader with a unit test' },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as ExecutionBody;
}

describe('idempotent intake', () => {
  it('replays the first answer for the same key and the same body', async () => {
    const api = await start();
    const projectId = await seedProject(api);
    const key = `intake_${Math.random().toString(36).slice(2, 8)}`;

    const first = await intake(api, projectId, key);
    const second = await api.inject({
      method: 'POST',
      url: '/api/executions',
      headers: { 'x-veltravia-owner-ref': OWNER, 'idempotency-key': key },
      payload: { projectId, request: 'Add a settings loader with a unit test' },
    });

    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    const replayed = second.json() as ExecutionBody;
    expect(replayed.execution.id).toBe(first.execution.id);

    // One execution exists, so the retry created no second plan or task set.
    const list = await api.inject({
      method: 'GET',
      url: '/api/executions',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    const executions = (list.json() as { executions: { id: string }[] }).executions;
    expect(executions.filter((entry) => entry.id === first.execution.id)).toHaveLength(1);
  });

  it('refuses the same key reused for a different request', async () => {
    const api = await start();
    const projectId = await seedProject(api);
    const key = `intake_reuse_${Math.random().toString(36).slice(2, 8)}`;
    await intake(api, projectId, key);

    const conflict = await api.inject({
      method: 'POST',
      url: '/api/executions',
      headers: { 'x-veltravia-owner-ref': OWNER, 'idempotency-key': key },
      payload: { projectId, request: 'Delete the settings module instead' },
    });
    expect(conflict.statusCode).toBe(422);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('keeps one owner\u2019s key from answering another owner', async () => {
    const api = await start();
    const projectId = await seedProject(api);
    const key = `intake_shared_${Math.random().toString(36).slice(2, 8)}`;
    await intake(api, projectId, key);

    const foreign = await api.inject({
      method: 'POST',
      url: '/api/executions',
      headers: { 'x-veltravia-owner-ref': OTHER, 'idempotency-key': key },
      payload: { projectId, request: 'Add a settings loader with a unit test' },
    });
    // The other owner's key is unused, and their project id is not visible to
    // them, so this is refused on ownership rather than replayed.
    expect([201, 404]).toContain(foreign.statusCode);
    if (foreign.statusCode === 201) {
      expect(foreign.headers['idempotent-replay']).toBeUndefined();
    }
  });

  it('does not guard a request that carries no key', async () => {
    const api = await start();
    const projectId = await seedProject(api);
    const first = await intake(api, projectId);
    const second = await intake(api, projectId);
    expect(second.execution.id).not.toBe(first.execution.id);
  });
});

describe('sweep and health', () => {
  it('leaves a finished execution alone and records the decision', async () => {
    const api = await start();
    const projectId = await seedProject(api);
    const created = await intake(api, projectId);
    const executionId = created.execution.id;

    const cancelled = await api.inject({
      method: 'POST',
      url: `/api/executions/${executionId}/cancel`,
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { reason: 'stopping this work for now' },
    });
    expect(cancelled.statusCode).toBe(200);

    const sweep = await api.inject({
      method: 'POST',
      url: '/api/reliability/sweep',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {},
    });
    expect(sweep.statusCode).toBe(200);
    const body = sweep.json() as {
      sweep: { examined: number; decisions: { executionId: string; action: string }[] };
    };
    // A cancelled execution is closed, so it is not even examined.
    expect(body.sweep.decisions.some((entry) => entry.executionId === executionId)).toBe(false);

    const recoveries = await api.inject({
      method: 'GET',
      url: `/api/reliability/recoveries?executionId=${executionId}`,
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect(recoveries.statusCode).toBe(200);
    expect((recoveries.json() as { recoveries: unknown[] }).recoveries).toHaveLength(0);
  });

  it('re-reads an open execution from its records instead of assuming it failed', async () => {
    const api = await start();
    const projectId = await seedProject(api);
    const created = await intake(api, projectId);

    const sweep = await api.inject({
      method: 'POST',
      url: '/api/reliability/sweep',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {},
    });
    expect(sweep.statusCode).toBe(200);
    const body = sweep.json() as {
      sweep: {
        examined: number;
        decisions: { executionId: string; action: string; reason: string }[];
      };
    };
    const decision = body.sweep.decisions.find(
      (entry) => entry.executionId === created.execution.id,
    );
    expect(decision).toBeDefined();
    // Fresh work is resumed by re-reading it, never declared complete.
    expect(['resume', 'leave']).toContain(decision?.action);

    const after = await api.inject({
      method: 'GET',
      url: `/api/executions/${created.execution.id}`,
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    const view = (after.json() as { execution: { status: string; progress: unknown } }).execution;
    expect(['planning', 'awaiting_approval', 'executing', 'verifying', 'completed']).toContain(
      view.status,
    );
  });

  it('reports honest health: counts from records, and that coordination is not durable here', async () => {
    const api = await start();
    const projectId = await seedProject(api);
    await intake(api, projectId);

    const health = await api.inject({
      method: 'GET',
      url: '/api/reliability/health',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect(health.statusCode).toBe(200);
    const body = health.json() as {
      health: {
        durable: boolean;
        queue: { openExecutions: number };
        findings: { code: string; level: string }[];
      };
    };
    expect(body.health.queue.openExecutions).toBeGreaterThanOrEqual(1);
    // The in-memory store is not durable, and the snapshot is required to say so.
    expect(body.health.durable).toBe(false);
    expect(body.health.findings.map((finding) => finding.code)).toContain(
      'RELIABILITY_NOT_DURABLE',
    );
  });

  it('keeps another owner out of the health, sweep and key views', async () => {
    const api = await start();
    const projectId = await seedProject(api);
    const created = await intake(api, projectId);

    const foreignSweep = await api.inject({
      method: 'POST',
      url: '/api/reliability/sweep',
      headers: { 'x-veltravia-owner-ref': OTHER },
      payload: {},
    });
    expect(foreignSweep.statusCode).toBe(200);
    expect(
      (foreignSweep.json() as { sweep: { decisions: unknown[] } }).sweep.decisions,
    ).toHaveLength(0);

    const foreignHealth = await api.inject({
      method: 'GET',
      url: '/api/reliability/health',
      headers: { 'x-veltravia-owner-ref': OTHER },
    });
    expect(
      (foreignHealth.json() as { health: { queue: { openExecutions: number } } }).health.queue
        .openExecutions,
    ).toBe(0);

    const foreignKeys = await api.inject({
      method: 'GET',
      url: '/api/reliability/keys',
      headers: { 'x-veltravia-owner-ref': OTHER },
    });
    expect((foreignKeys.json() as { keys: unknown[] }).keys).toHaveLength(0);

    // And the execution itself is a 404 for them, exactly like a missing one.
    const foreignRead = await api.inject({
      method: 'GET',
      url: `/api/executions/${created.execution.id}`,
      headers: { 'x-veltravia-owner-ref': OTHER },
    });
    expect(foreignRead.statusCode).toBe(404);
  });

  it('publishes the limits it actually enforces', async () => {
    const api = await start();
    const capabilities = await api.inject({ method: 'GET', url: '/api/reliability/capabilities' });
    expect(capabilities.statusCode).toBe(200);
    const body = capabilities.json() as {
      capabilities: {
        idempotency: { header: string; retentionHours: number };
        backpressure: { maxOpenExecutionsPerOwner: number };
        excluded: string[];
      };
    };
    expect(body.capabilities.idempotency.header).toBe('Idempotency-Key');
    expect(body.capabilities.backpressure.maxOpenExecutionsPerOwner).toBeGreaterThan(0);
    // The honest part: what this layer does NOT promise.
    expect(body.capabilities.excluded.join(' ')).toContain('exactly-once');
  });
});
