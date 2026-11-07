/**
 * A worker running real verification, and the review that checks it.
 *
 * The point of Step 45 is that "tests pass" stops being an assertion a worker
 * can make. These tests prove the two halves: the worker may only run the
 * operations its assignment names, and an acceptance is refused unless a stored
 * run backs the claim.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  RawExecution,
  VerificationExecutor,
  VerificationRunRecord,
} from '@veltravia/verification-core';
import type { WorkerToolContext } from '@veltravia/superagent-core';

import { buildApp } from './server.js';
import { createEngine } from './projects.js';
import { createProjectToolHandlers } from './worker-execution.js';
import { createVerificationService } from './verification.js';
import { checkTestEvidence } from './evidence-gate.js';

process.env['VELTRAVIA_WORKER_EXECUTOR'] = 'simulated';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

const stdout = 'Test Files  1 passed (1)\n     Tests  4 passed (4)';

function scripted(): { executor: VerificationExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: VerificationExecutor = {
    prepare: async () => ({
      handle: {},
      runtimeId: 'scripted',
      providesOsIsolation: false,
      unenforced: ['network'],
      dispose: async () => undefined,
    }),
    execute: async (_session, command) => {
      calls.push([command.command, ...command.args].join(' '));
      const result: RawExecution = {
        exitCode: 0,
        stdout,
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 3,
        enforceableTimeout: true,
        runtimeId: 'scripted',
        providesOsIsolation: false,
        unenforced: ['network'],
      };
      return result;
    },
  };
  return { executor, calls };
}

async function seedProject(server: FastifyInstance) {
  const created = await server.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: `w-${Math.random().toString(36).slice(2, 8)}`,
      description: 'd',
      projectType: 'web',
    },
  });
  const projectId = (created.json() as { id: string }).id;
  const workspace = await server.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    payload: { name: 'main' },
  });
  const workspaceId = (workspace.json() as { id: string }).id;
  await server.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/files`,
    payload: {
      path: 'package.json',
      content: JSON.stringify({
        name: 'fixture',
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '^1.0.0' },
      }),
    },
  });
  return projectId;
}

function context(overrides: Partial<WorkerToolContext> = {}): WorkerToolContext {
  return {
    ownerRef: 'veltravia-dev-user',
    workerId: 'wrk_test',
    workerType: 'testing',
    taskId: 'tsk_test',
    projectId: null,
    verificationOperations: ['unit', 'typecheck'],
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    record: () => undefined,
    ...overrides,
  };
}

describe('a worker running verification', () => {
  it('runs an operation its assignment allows and returns the run id as evidence', async () => {
    const { executor, calls } = scripted();
    const engine = createEngine();
    const verification = createVerificationService({ projects: engine, executor });
    const handlers = createProjectToolHandlers(engine, undefined, { verification });

    const server = buildApp({ projectEngine: engine });
    app = server;
    const projectId = await seedProject(server);

    const outcome = await handlers['tests.run']!(
      { tool: 'tests.run', arguments: { operations: ['unit'] } },
      context({ projectId }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.passed).toBe(true);
    expect(outcome.evidenceRef).toMatch(/^run_|^vr_|./);
    expect(calls[0]).toContain('npm');

    const runs = await verification.store.list('veltravia-dev-user', {
      workerId: 'wrk_test',
      limit: 10,
    });
    expect(runs.length).toBe(1);
    expect(outcome.evidenceRef).toBe(runs[0]?.id);
    expect(runs[0]?.evidence?.executed).toBe(true);
  });

  it('refuses an operation the assignment did not authorise, and runs nothing', async () => {
    const { executor, calls } = scripted();
    const engine = createEngine();
    const verification = createVerificationService({ projects: engine, executor });
    const handlers = createProjectToolHandlers(engine, undefined, { verification });
    const server = buildApp({ projectEngine: engine });
    app = server;
    const projectId = await seedProject(server);

    const outcome = await handlers['tests.run']!(
      { tool: 'tests.run', arguments: { operations: ['e2e'] } },
      context({ projectId, verificationOperations: ['unit'] }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('WORKER_TOOL_OUT_OF_SCOPE');
    expect(calls.length).toBe(0);
  });

  it('refuses when the assignment grants no verification at all', async () => {
    const { executor } = scripted();
    const engine = createEngine();
    const verification = createVerificationService({ projects: engine, executor });
    const handlers = createProjectToolHandlers(engine, undefined, { verification });

    const outcome = await handlers['tests.run']!(
      { tool: 'tests.run', arguments: { operations: ['unit'] } },
      context({ projectId: 'prj_x', verificationOperations: [] }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('WORKER_TOOL_NOT_ASSIGNED');
  });

  it('refuses honestly when the server has no verification runtime', async () => {
    const engine = createEngine();
    const handlers = createProjectToolHandlers(engine);
    const outcome = await handlers['tests.run']!(
      { tool: 'tests.run', arguments: { operations: ['unit'] } },
      context({ projectId: 'prj_x' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('WORKER_TOOL_UNAVAILABLE');
  });
});

describe('the review evidence gate', () => {
  const run = (overrides: Partial<VerificationRunRecord>): VerificationRunRecord =>
    ({
      id: 'run_1',
      ownerRef: 'veltravia-dev-user',
      projectId: 'prj_1',
      taskId: 'tsk_1',
      workerId: 'wrk_1',
      status: 'passed',
      operations: ['unit'],
      results: [],
      blocked: [],
      repair: { attempt: 0, repairsRunId: null, allowed: false },
      createdAt: '2026-11-07T00:00:00.000Z',
      finishedAt: '2026-11-07T00:00:01.000Z',
      evidence: {
        kind: 'verification-run',
        runId: 'run_1',
        projectId: 'prj_1',
        revision: 'rev',
        operations: ['unit'],
        status: 'passed',
        executed: true,
        executedCount: 1,
        passedCount: 1,
        failedCount: 0,
        finishedAt: '2026-11-07T00:00:01.000Z',
      },
      ...overrides,
    }) as VerificationRunRecord;

  function serviceWith(runs: readonly VerificationRunRecord[]) {
    const engine = createEngine();
    const verification = createVerificationService({ projects: engine, runtimeMode: 'none' });
    // A tiny store double: the gate only ever reads.
    const store = {
      list: async () => runs,
      get: async (_owner: string, id: string) => runs.find((run) => run.id === id) ?? null,
      save: async () => undefined,
    } as never;
    return { verification: { ...verification, store }, engine };
  }

  it('accepts a claim backed by a passing run', async () => {
    const { verification } = serviceWith([run({})]);
    const problem = await checkTestEvidence({
      verification,
      ownerRef: 'veltravia-dev-user',
      workerId: 'wrk_1',
      evidence: [{ kind: 'test_run', ref: 'run_1', passed: true }],
    });
    expect(problem).toBeNull();
  });

  it('refuses a claim with no stored run behind it', async () => {
    const { verification } = serviceWith([]);
    const problem = await checkTestEvidence({
      verification,
      ownerRef: 'veltravia-dev-user',
      workerId: 'wrk_1',
      evidence: [{ kind: 'test_run', ref: 'run_missing', passed: true }],
    });
    expect(problem?.code).toBe('WORKER_EVIDENCE_MISSING');
  });

  it('refuses a pass claim when the run actually failed', async () => {
    const { verification } = serviceWith([run({ status: 'failed' } as never)]);
    const problem = await checkTestEvidence({
      verification,
      ownerRef: 'veltravia-dev-user',
      workerId: 'wrk_1',
      evidence: [{ kind: 'test_run', ref: 'run_1', passed: true }],
    });
    expect(problem?.code).toBe('WORKER_EVIDENCE_CONTRADICTED');
  });

  it('refuses a run that executed nothing', async () => {
    const { verification } = serviceWith([
      run({
        status: 'incomplete',
        evidence: {
          kind: 'verification-run',
          runId: 'run_1',
          projectId: 'prj_1',
          revision: null,
          operations: ['unit'],
          status: 'incomplete',
          executed: false,
          executedCount: 0,
          passedCount: 0,
          failedCount: 0,
          finishedAt: '2026-11-07T00:00:01.000Z',
        },
      } as never),
    ]);
    const problem = await checkTestEvidence({
      verification,
      ownerRef: 'veltravia-dev-user',
      workerId: 'wrk_1',
      evidence: [{ kind: 'test_run', ref: 'run_1', passed: false }],
    });
    expect(problem?.code).toBe('WORKER_EVIDENCE_EMPTY');
  });

  it('leaves a worker that claims no test result alone', async () => {
    const { verification } = serviceWith([]);
    const problem = await checkTestEvidence({
      verification,
      ownerRef: 'veltravia-dev-user',
      workerId: 'wrk_1',
      evidence: [{ kind: 'deliverable', ref: 'src/a.ts' }],
    });
    expect(problem).toBeNull();
  });
});
