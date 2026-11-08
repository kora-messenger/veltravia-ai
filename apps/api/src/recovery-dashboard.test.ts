/**
 * The recovery dashboard end to end (Step 49).
 *
 * One flow, through the routes the page itself calls: a worker fails, a case is
 * opened from what the worker record says, the Primary Agent plans and runs a
 * repair, a real verification run is recorded, and only then does the case
 * become recovered. A second flow uses every attempt and has to escalate.
 *
 * The executor is a scripted double, so what this proves is the wiring, the
 * evidence gate and the ownership boundary - not that a compiler works.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  RawExecution,
  VerificationExecutor,
  VerificationSession,
} from '@veltravia/verification-core';
import type { ProjectEngine } from '@veltravia/project-core';

import { buildApp } from './server.js';
import { createEngine } from './projects.js';
import { resolveDeploymentConfig } from './deployment/config.js';
import { createVerificationService } from './verification.js';

process.env['VELTRAVIA_WORKER_EXECUTOR'] = 'simulated';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

type Scripted = {
  readonly executor: VerificationExecutor;
  readonly calls: { command: string; args: string[] }[];
};

function scriptedExecutor(results: readonly Partial<RawExecution>[]): Scripted {
  const calls: { command: string; args: string[] }[] = [];
  let index = 0;
  const session: VerificationSession = {
    handle: {},
    runtimeId: 'scripted',
    providesOsIsolation: false,
    unenforced: ['network'],
    dispose: async () => undefined,
  };
  const executor: VerificationExecutor = {
    prepare: async () => session,
    execute: async (_session, command) => {
      calls.push({ command: command.command, args: [...command.args] });
      const result = results[index] ?? {};
      index += 1;
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 5,
        enforceableTimeout: true,
        runtimeId: 'scripted',
        providesOsIsolation: false,
        unenforced: ['network'],
        ...result,
      };
    },
  };
  return { executor, calls };
}

const passingTests = 'Test Files  1 passed (1)\n     Tests  4 passed (4)';

function start(scripted: Scripted): FastifyInstance {
  const engine: ProjectEngine = createEngine();
  app = buildApp({
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    projectEngine: engine,
    verification: createVerificationService({ projects: engine, executor: scripted.executor }),
  });
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

async function seedProject(api: FastifyInstance): Promise<{ projectId: string; taskId: string }> {
  const project = await api.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: `Dashboard ${Math.random().toString(36).slice(2, 8)}`,
      description: 'recovery dashboard fixture',
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
  const packageJson = JSON.stringify({
    name: 'fixture',
    scripts: { test: 'vitest run', build: 'tsc', lint: 'eslint .' },
    devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
  });
  const wrote = await api.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/files`,
    payload: { path: 'package.json', content: packageJson },
  });
  if (wrote.statusCode !== 201) {
    throw new Error(`seeding package.json failed: ${wrote.statusCode} ${wrote.body}`);
  }
  await api.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/files`,
    payload: { path: 'src/settings/load.ts', content: 'export const load = () => ({ ok: true });' },
  });
  const task = await api.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { projectId, title: 'Settings loader', objective: 'Load the settings.' },
  });
  return { projectId, taskId: (task.json() as { task: { id: string } }).task.id };
}

async function failedWorker(api: FastifyInstance, taskId: string): Promise<string> {
  const delegated = await api.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/workers`,
    payload: { workerType: 'backend', assignment: assignment() },
  });
  if (delegated.statusCode !== 201) {
    throw new Error(`delegate failed: ${delegated.statusCode} ${delegated.body}`);
  }
  const workerId = (delegated.json() as { worker: { id: string } }).worker.id;
  await api.inject({ method: 'POST', url: `/api/workers/${workerId}/start` });
  return workerId;
}

interface CaseBody {
  readonly case: {
    readonly id: string;
    readonly status: string;
    readonly attempts: number;
    readonly taskId: string;
    readonly workerId: string | null;
    readonly diagnosis: { readonly primary: string | null; readonly confidence: string } | null;
    readonly verification: { readonly runId: string; readonly status: string } | null;
    readonly escalation: { readonly reason: string } | null;
  };
}

interface OverviewBody {
  readonly overview: {
    readonly total: number;
    readonly awaitingDiagnosis: number;
    readonly repairing: number;
    readonly recovered: number;
    readonly needsIntervention: number;
    readonly insufficientEvidence: number;
    readonly exhausted: number;
    readonly attemptsRemaining: number;
    readonly truncated: boolean;
  };
}

describe('recovery dashboard, end to end', () => {
  it('shows a case, repairs it, and recovers only on a stored passing run', async () => {
    const scripted = scriptedExecutor([{ exitCode: 0, stdout: passingTests }]);
    const api = start(scripted);
    const { projectId, taskId } = await seedProject(api);
    const workerId = await failedWorker(api, taskId);

    // 1. A worker failed and the case appears in the dashboard's own read.
    const opened = await api.inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    expect(opened.statusCode).toBe(201);
    const caseId = (opened.json() as CaseBody).case.id;

    const listed = await api.inject({
      method: 'GET',
      url: `/api/recovery/cases?projectId=${projectId}`,
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json() as { cases: { id: string }[] };
    expect(listedBody.cases.map((entry) => entry.id)).toContain(caseId);

    // 2. The overview counts it as awaiting diagnosis, not as recovered.
    const before = (
      await api.inject({ method: 'GET', url: '/api/recovery/overview' })
    ).json() as OverviewBody;
    expect(before.overview.total).toBe(1);
    expect(before.overview.awaitingDiagnosis).toBe(1);
    expect(before.overview.recovered).toBe(0);

    // 3. The Primary Agent runs a bounded repair on a child task.
    const repair = await api.inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/repair`,
    });
    expect(repair.statusCode).toBe(200);
    const repaired = repair.json() as {
      case: { attempts: number; status: string };
      recovered: boolean;
      repairWorker: { id: string; taskId: string } | null;
    };
    expect(repaired.case.attempts).toBe(1);
    expect(repaired.recovered).toBe(false);
    expect(repaired.repairWorker?.taskId).not.toBe(taskId);

    // 4. A real verification run is recorded against the project.
    const run = await api.inject({
      method: 'POST',
      url: '/api/verification/runs',
      payload: { projectId, operations: ['unit'] },
    });
    expect(run.statusCode).toBe(201);
    const runBody = run.json() as {
      run: { id: string; status: string; results: readonly { status: string }[] };
    };
    expect(runBody.run.status).toBe('passed');
    expect(runBody.run.results[0]?.status).toBe('passed');

    // 5. Completion needs that stored run: a made-up id is refused.
    const fabricated = await api.inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/complete`,
      payload: { verificationRunId: 'run_does_not_exist' },
    });
    expect(fabricated.statusCode).toBe(409);

    // 6. With the stored run the case is recovered, and the evidence is kept.
    const completed = await api.inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/complete`,
      payload: { verificationRunId: runBody.run.id },
    });
    expect(completed.statusCode).toBe(200);
    const done = completed.json() as CaseBody & { recovered: boolean };
    expect(done.recovered).toBe(true);
    expect(done.case.status).toBe('recovered');
    expect(done.case.verification?.runId).toBe(runBody.run.id);
    expect(done.case.verification?.status).toBe('passed');

    // 7. The dashboard reads it back as recovered, with the attempt evidence.
    const after = (
      await api.inject({ method: 'GET', url: '/api/recovery/overview' })
    ).json() as OverviewBody;
    expect(after.overview.recovered).toBe(1);
    expect(after.overview.awaitingDiagnosis).toBe(0);

    const detail = await api.inject({ method: 'GET', url: `/api/recovery/cases/${caseId}` });
    const detailBody = detail.json() as {
      case: CaseBody['case'];
      attempts: { attempt: number; outcome: string; verificationRunId: string | null }[];
      events: { type: string }[];
    };
    expect(detailBody.attempts).toHaveLength(1);
    expect(detailBody.attempts[0]?.outcome).toBe('succeeded');
    expect(detailBody.events.map((event) => event.type)).toContain('recovered');
  });

  it('keeps counting attempts while the work is unproven, and never claims recovery', async () => {
    const scripted = scriptedExecutor([]);
    const api = start(scripted);
    const { taskId, projectId } = await seedProject(api);
    const workerId = await failedWorker(api, taskId);
    const opened = await api.inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId },
    });
    const caseId = (opened.json() as CaseBody).case.id;

    const first = await api.inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/repair`,
    });
    expect(first.statusCode).toBe(200);
    const afterFirst = (first.json() as CaseBody).case;
    expect(afterFirst.status).toBe('awaiting_verification');
    expect(afterFirst.attempts).toBe(1);

    // A second attempt is allowed by the budget, and still proves nothing.
    const second = await api.inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseId}/repair`,
    });
    expect(second.statusCode).toBe(200);
    const afterSecond = (second.json() as CaseBody).case;
    expect(afterSecond.attempts).toBe(2);
    expect(afterSecond.status).not.toBe('recovered');

    const overview = (
      await api.inject({ method: 'GET', url: '/api/recovery/overview' })
    ).json() as OverviewBody;
    expect(overview.overview.recovered).toBe(0);
    expect(overview.overview.attemptsRemaining).toBe(1);
    expect(overview.overview.exhausted).toBe(0);

    // Every repair ran on its own child task under the original one.
    const detail = (
      await api.inject({ method: 'GET', url: `/api/recovery/cases/${caseId}` })
    ).json() as {
      case: { taskId: string };
      attempts: { attempt: number; workerId: string | null }[];
    };
    expect(detail.case.taskId).toBe(taskId);
    expect(detail.attempts.map((entry) => entry.attempt)).toEqual([1, 2]);
    const taskIds = new Set(detail.attempts.map((entry) => entry.workerId));
    expect(taskIds.size).toBe(2);
    expect(detail.case.taskId).toBeTruthy();
    expect(projectId).toBeTruthy();
  });

  it('escalates when the attempt budget is spent, and the dashboard says why', async () => {
    const scripted = scriptedExecutor([]);
    const api = start(scripted);
    const { taskId } = await seedProject(api);
    const workerId = await failedWorker(api, taskId);

    // One attempt is the whole budget for this case, so the flow reaches the
    // limit without waiting out a backoff window.
    const opened = await api.inject({
      method: 'POST',
      url: '/api/recovery/cases',
      payload: { workerId, limits: { maxAttempts: 1, maxTotalDurationMs: 600_000 } },
    });
    expect(opened.statusCode).toBe(201);
    const caseBody = (opened.json() as CaseBody).case;
    expect(caseBody.status).not.toBe('recovered');

    const repair = await api.inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseBody.id}/repair`,
    });
    expect(repair.statusCode).toBe(200);
    const repaired = (repair.json() as CaseBody).case;
    expect(repaired.attempts).toBe(1);
    expect(repaired.status).not.toBe('recovered');

    // Every attempt is used: the engine refuses more and hands the case back.
    const beyond = await api.inject({
      method: 'POST',
      url: `/api/recovery/cases/${caseBody.id}/repair`,
    });
    expect(beyond.statusCode).toBeGreaterThanOrEqual(400);
    const refusal = beyond.json() as { error: { code: string } };
    expect([
      'RECOVERY_CASE_CLOSED',
      'RECOVERY_BUDGET_EXHAUSTED',
      'RECOVERY_BACKOFF_ACTIVE',
    ]).toContain(refusal.error.code);

    const overview = (
      await api.inject({ method: 'GET', url: '/api/recovery/overview' })
    ).json() as OverviewBody;
    expect(overview.overview.recovered).toBe(0);
    expect(overview.overview.attemptsRemaining).toBe(0);
    expect(overview.overview.exhausted).toBe(1);

    const detail = (
      await api.inject({ method: 'GET', url: `/api/recovery/cases/${caseBody.id}` })
    ).json() as CaseBody;
    expect(detail.case.status).toBe('escalated');
    expect(detail.case.escalation?.reason).toBe('budget_exhausted');

    // The dashboard's exhausted filter finds it, and the case is never recovered.
    const filtered = await api.inject({
      method: 'GET',
      url: '/api/recovery/cases?exhausted=true',
    });
    expect(filtered.statusCode).toBe(200);
    const rows = (filtered.json() as { cases: { id: string; status: string }[] }).cases;
    expect(rows.map((entry) => entry.id)).toContain(caseBody.id);
    expect(rows.every((entry) => entry.status !== 'recovered')).toBe(true);
  });
});
