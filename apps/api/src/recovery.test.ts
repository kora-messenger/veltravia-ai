/**
 * Recovery over HTTP (Step 48).
 *
 * The evidence is real: tasks, workers, verification runs and change sets are
 * created through their own routes, and the recovery case is opened from what
 * the worker record actually says. The repair itself runs on the scripted
 * executor, so what these tests prove is the decision-making and the gates, not
 * model labour.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';

process.env['VELTRAVIA_WORKER_EXECUTOR'] = 'simulated';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

function server(): FastifyInstance {
  if (app === null) {
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
  }
  return app;
}

const assignment = (overrides: Record<string, unknown> = {}) => ({
  objective: 'Load settings.',
  scope: ['src/settings'],
  exclusions: ['src/settings/secret.ts'],
  deliverables: [
    { name: 'loader', kind: 'file', path: 'src/settings/load.ts', summary: 'The loader' },
    { name: 'notes', kind: 'file', path: 'src/settings/notes.md', summary: 'The notes' },
  ],
  acceptanceCriteria: ['loads settings', 'unit test passes'],
  allowedTools: ['project.read', 'project.write', 'tests.run'],
  permissions: { readProject: true, writeProject: true, runTools: true, network: false },
  limits: { maxDurationMs: 20_000, maxToolCalls: 10, maxDeliverables: 3 },
  dependencies: [],
  checkpoints: ['after load'],
  cancellationConditions: ['owner cancels'],
  reporting: ['files written'],
  ...overrides,
});

async function seedTask(): Promise<{ projectId: string; taskId: string }> {
  const api = server();
  const project = await api.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: `Recovery ${Math.random().toString(36).slice(2, 8)}`,
      description: 'f',
      projectType: 'web',
    },
  });
  const projectId = (project.json() as { id: string }).id;
  const task = await api.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { projectId, title: 'Settings', objective: 'Load the settings.' },
  });
  return { projectId, taskId: (task.json() as { task: { id: string } }).task.id };
}

async function delegate(taskId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await server().inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/workers`,
    payload: { workerType: 'backend', assignment: assignment(overrides) },
  });
  if (response.statusCode !== 201) {
    throw new Error(`delegate failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { worker: { id: string } }).worker.id;
}

/** A worker that ran to review, so there is a real record to diagnose. */
async function failedWorker(taskId: string, overrides: Record<string, unknown> = {}) {
  const workerId = await delegate(taskId, overrides);
  await server().inject({ method: 'POST', url: `/api/workers/${workerId}/start` });
  return workerId;
}

describe('recovery capabilities', () => {
  it('reports its limits and the vocabulary it will accept', async () => {
    const response = await server().inject({ method: 'GET', url: '/api/recovery/capabilities' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      capabilities: { categories: string[]; limits: { maxAttempts: number } };
      storage: { kind: string };
    };
    expect(body.capabilities.categories).toContain('failed_tests');
    expect(body.capabilities.limits.maxAttempts).toBeGreaterThan(0);
    expect(['memory', 'postgres']).toContain(body.storage.kind);
  });
});

describe('opening a case', () => {
  it('diagnoses a worker that reached review without doing the work', async () => {
    const { taskId } = await seedTask();
    const workerId = await failedWorker(taskId);
    const response = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      case: { id: string; status: string; diagnosis: { primary: string | null } };
    };
    expect(body.case.status).toBe('open');
    expect(body.case.diagnosis.primary).not.toBeNull();
  });

  it('refuses a case for a worker that never failed', async () => {
    const { taskId } = await seedTask();
    const workerId = await delegate(taskId);
    const response = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    // queued workers are not failures; the route says so instead of guessing.
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'RECOVERY_INPUT_INVALID',
    );
  });

  it('treats an unknown worker id exactly like a foreign one', async () => {
    const response = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId: 'wkr_nope' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'RECOVERY_INPUT_INVALID',
    );
  });

  it('requires a worker id rather than a free-form claim', async () => {
    const response = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId: 'x', status: 'recovered', attempts: 9 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('reading a case', () => {
  it('returns the case, its attempts and its audit trail', async () => {
    const { taskId } = await seedTask();
    const workerId = await failedWorker(taskId);
    const opened = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    const caseId = (opened.json() as { case: { id: string } }).case.id;
    const detail = await server().inject({ method: 'GET', url: `/api/recovery/cases/${caseId}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      case: { id: string };
      attempts: unknown[];
      events: { type: string; seq: number }[];
    };
    expect(body.case.id).toBe(caseId);
    expect(body.attempts).toHaveLength(0);
    expect(body.events[0]?.type).toBe('failure_detected');
    expect(body.events.map((event) => event.seq)).toEqual(
      [...body.events.keys()].map((i) => i + 1),
    );
  });

  it('lists cases filtered by project', async () => {
    const { projectId, taskId } = await seedTask();
    const workerId = await failedWorker(taskId);
    await server().inject({ method: 'POST', url: '/api/recovery/cases', payload: { workerId } });
    const list = await server().inject({
      method: 'GET',
      url: `/api/recovery/cases?projectId=${projectId}`,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { cases: unknown[] }).cases).toHaveLength(1);
    const other = await server().inject({
      method: 'GET',
      url: '/api/recovery/cases?projectId=prj_other',
    });
    expect((other.json() as { cases: unknown[] }).cases).toHaveLength(0);
  });

  it('answers 404 for a case that does not exist', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/api/recovery/cases/rcv_missing',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('repairing', () => {
  it('plans a bounded repair, runs it, and does not claim recovery without evidence', async () => {
    const { taskId } = await seedTask();
    const workerId = await failedWorker(taskId);
    const opened = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    const caseId = (opened.json() as { case: { id: string } }).case.id;

    const repair = await server().inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/repair`,
    });
    expect(repair.statusCode).toBe(200);
    const body = repair.json() as {
      case: { status: string; attempts: number };
      recovered: boolean;
      reason: string;
      repairWorker: { id: string; assignment: { scope: string[]; allowedTools: string[] } } | null;
    };
    expect(body.case.attempts).toBe(1);
    expect(body.recovered).toBe(false);
    expect(body.reason.length).toBeGreaterThan(0);
    // The repair stays inside the failed worker's scope and tools.
    expect(body.repairWorker?.assignment.scope).toEqual(['src/settings']);
    for (const tool of body.repairWorker?.assignment.allowedTools ?? []) {
      expect(['project.read', 'project.write', 'tests.run']).toContain(tool);
    }
  });

  it('does not close a case as recovered on a claim alone', async () => {
    const { taskId } = await seedTask();
    const workerId = await failedWorker(taskId);
    const opened = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    const caseId = (opened.json() as { case: { id: string } }).case.id;
    await server().inject({ method: 'POST', url: `/api/recovery/cases/${caseId}/repair` });

    const complete = await server().inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/complete`,
      payload: { verificationRunId: 'run_missing' },
    });
    expect(complete.statusCode).toBe(409);
    expect((complete.json() as { error: { code: string } }).error.code).toBe(
      'RECOVERY_VERIFICATION_REQUIRED',
    );
  });

  it('refuses to repair a case that already escalated to the owner', async () => {
    const { taskId } = await seedTask();
    const workerId = await failedWorker(taskId);
    const opened = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    const caseId = (opened.json() as { case: { id: string } }).case.id;
    const escalated = await server().inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/escalate`,
      payload: { reason: 'owner_decision', message: 'The owner wants to decide.' },
    });
    expect(escalated.statusCode).toBe(200);
    expect((escalated.json() as { case: { status: string } }).case.status).toBe('escalated');

    const repair = await server().inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/repair`,
    });
    expect(repair.statusCode).toBe(409);
    expect((repair.json() as { error: { code: string } }).error.code).toBe('RECOVERY_CASE_CLOSED');
  });

  it('cancels a case and keeps it out of the open list', async () => {
    const { taskId } = await seedTask();
    const workerId = await failedWorker(taskId);
    const opened = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    const caseId = (opened.json() as { case: { id: string } }).case.id;
    const cancelled = await server().inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/cancel`,
      payload: { message: 'Not worth repairing.' },
    });
    expect(cancelled.statusCode).toBe(200);
    const open = await server().inject({
      method: 'GET',
      url: '/api/recovery/cases?openOnly=true',
    });
    expect((open.json() as { cases: unknown[] }).cases).toHaveLength(0);
  });
});

describe('recovery overview and filters (Step 49)', () => {
  const ownerHeader = (owner: string) => ({ 'x-veltravia-owner-ref': owner });

  async function openCase(taskId: string): Promise<string> {
    const workerId = await failedWorker(taskId);
    const opened = await server().inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    expect(opened.statusCode).toBe(201);
    return (opened.json() as { case: { id: string } }).case.id;
  }

  it('counts the owner cases by status, category and verification', async () => {
    const { taskId } = await seedTask();
    await openCase(taskId);

    const response = await server().inject({ method: 'GET', url: '/api/recovery/overview' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      overview: {
        total: number;
        awaitingDiagnosis: number;
        recovered: number;
        needsIntervention: number;
        insufficientEvidence: number;
        attemptsRemaining: number;
        truncated: boolean;
        byStatus: Record<string, number>;
        byCategory: Record<string, number>;
      };
    };
    expect(body.overview.total).toBeGreaterThanOrEqual(1);
    expect(body.overview.truncated).toBe(false);
    // Every case just opened is open: recovery is never claimed by a tally.
    expect(body.overview.recovered).toBe(0);
    expect(body.overview.awaitingDiagnosis).toBe(body.overview.byStatus.open);
    expect(body.overview.attemptsRemaining).toBeGreaterThan(0);
    expect(
      Object.values(body.overview.byCategory).reduce((sum, value) => sum + value, 0),
    ).toBeLessThanOrEqual(body.overview.total);
  });

  it('filters by status, category, worker and verification, and refuses a bad one', async () => {
    const { taskId } = await seedTask();
    const caseId = await openCase(taskId);
    const detail = await server().inject({ method: 'GET', url: `/api/recovery/cases/${caseId}` });
    const category = (detail.json() as { case: { diagnosis: { primary: string | null } } }).case
      .diagnosis.primary;

    const byStatus = await server().inject({
      method: 'GET',
      url: `/api/recovery/cases?status=open,repairing&taskId=${taskId}`,
    });
    expect(byStatus.statusCode).toBe(200);
    expect((byStatus.json() as { cases: { taskId: string }[] }).cases).toHaveLength(1);

    if (category !== null) {
      const byCategory = await server().inject({
        method: 'GET',
        url: `/api/recovery/cases?category=${category}&taskId=${taskId}`,
      });
      expect((byCategory.json() as { cases: unknown[] }).cases).toHaveLength(1);
      const otherCategory = await server().inject({
        method: 'GET',
        url: '/api/recovery/cases?category=permission_refused',
      });
      expect((otherCategory.json() as { cases: unknown[] }).cases).toHaveLength(0);
    }

    const noVerification = await server().inject({
      method: 'GET',
      url: `/api/recovery/cases?verification=not_run&taskId=${taskId}`,
    });
    expect((noVerification.json() as { cases: unknown[] }).cases).toHaveLength(1);
    const passed = await server().inject({
      method: 'GET',
      url: `/api/recovery/cases?verification=passed&taskId=${taskId}`,
    });
    expect((passed.json() as { cases: unknown[] }).cases).toHaveLength(0);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const afterFuture = await server().inject({
      method: 'GET',
      url: `/api/recovery/cases?since=${encodeURIComponent(future)}`,
    });
    expect((afterFuture.json() as { cases: unknown[] }).cases).toHaveLength(0);

    const bad = await server().inject({
      method: 'GET',
      url: '/api/recovery/cases?status=nonsense',
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('RECOVERY_FILTER_INVALID');

    const badDate = await server().inject({
      method: 'GET',
      url: '/api/recovery/cases?since=not-a-date',
    });
    expect(badDate.statusCode).toBe(400);
  });

  it('keeps cases invisible to another owner, on both the list and the detail', async () => {
    const { taskId } = await seedTask();
    const caseId = await openCase(taskId);

    const foreign = { ...ownerHeader('someone-else-49') };
    const list = await server().inject({
      method: 'GET',
      url: '/api/recovery/cases',
      headers: foreign,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { cases: unknown[] }).cases).toHaveLength(0);

    const overview = await server().inject({
      method: 'GET',
      url: '/api/recovery/overview',
      headers: foreign,
    });
    expect((overview.json() as { overview: { total: number } }).overview.total).toBe(0);

    const detail = await server().inject({
      method: 'GET',
      url: `/api/recovery/cases/${caseId}`,
      headers: foreign,
    });
    // A foreign id is a 404 exactly like a missing one.
    expect(detail.statusCode).toBe(404);

    const cancel = await server().inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/cancel`,
      headers: foreign,
      payload: { message: 'not mine' },
    });
    expect(cancel.statusCode).toBe(404);
  });
});
