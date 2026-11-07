/**
 * Verification runs over HTTP, and the evidence gate they feed.
 *
 * The executor here is a scripted double that reports exactly what it was
 * asked to run, so these tests prove the wiring, the ownership boundaries and
 * the honesty of the report - not that a real compiler works. The live sandbox
 * path is covered separately by the opt-in suite.
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

// No worker here thinks: this file is about verification, not model calls.
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

const vitestStdout = 'Test Files  2 passed (2)\n     Tests  9 passed (9)';

async function seedProject(): Promise<string> {
  const server = app as FastifyInstance;
  const created = await server.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: `Verify ${Math.random().toString(36).slice(2, 8)}`,
      description: 'verification fixture',
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
  const packageJson = JSON.stringify({
    name: 'fixture',
    scripts: { test: 'vitest run', lint: 'eslint .' },
    devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0', eslint: '^9.0.0' },
  });
  const wrote = await server.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/files`,
    payload: { path: 'package.json', content: packageJson },
  });
  if (wrote.statusCode !== 201) {
    throw new Error(`seeding package.json failed: ${wrote.statusCode} ${wrote.body}`);
  }
  await server.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/files`,
    payload: { path: 'src/sum.ts', content: 'export const sum = (a: number) => a + 1;' },
  });
  return projectId;
}

/**
 * One engine, shared by the routes and the verification service, so a project
 * seeded over HTTP is the project the service reads.
 */
function startWith(scripted: Scripted): { server: FastifyInstance; engine: ProjectEngine } {
  const engine = createEngine();
  const server = buildApp({
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    projectEngine: engine,
    verification: createVerificationService({ projects: engine, executor: scripted.executor }),
  });
  app = server;
  return { server, engine };
}

describe('verification capabilities', () => {
  it('says plainly when no runtime is configured', async () => {
    const engine = createEngine();
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      projectEngine: engine,
      verification: createVerificationService({ projects: engine, runtimeMode: 'none' }),
    });
    const response = await app.inject({ method: 'GET', url: '/api/verification/capabilities' });
    expect(response.statusCode).toBe(200);
    const { capabilities } = response.json() as {
      capabilities: {
        execution: { runtimeId: string | null; blockedReason: string | null };
        operations: string[];
      };
    };
    expect(capabilities.execution.runtimeId).toBeNull();
    expect(capabilities.execution.blockedReason).toContain('No execution runtime');
    expect(capabilities.operations).toContain('unit');
  });
});

describe('detecting what a project can verify', () => {
  it("resolves operations from the project's own configuration", async () => {
    const { server } = startWith(scriptedExecutor([]));
    const projectId = await seedProject();

    const response = await server.inject({
      method: 'GET',
      url: `/api/verification/projects/${projectId}/profile`,
    });
    expect(response.statusCode).toBe(200);
    const { profile } = response.json() as {
      profile: {
        testFrameworks: string[];
        commands: { id: string; operation: string; command: string; args: string[] }[];
      };
    };
    const operations = profile.commands.map((command) => command.operation);
    expect(operations).toContain('unit');
    expect(operations).toContain('lint');
    expect(profile.testFrameworks).toContain('vitest');
    // The declared script is what runs; the operation never becomes a raw command.
    const unit = profile.commands.find((command) => command.operation === 'unit');
    expect(unit?.id).toBe('npm:test');
    expect([unit?.command, ...(unit?.args ?? [])].join(' ')).toContain('npm');
  });

  it('answers 404 for a project the caller does not own', async () => {
    const { server } = startWith(scriptedExecutor([]));
    const response = await server.inject({
      method: 'GET',
      url: '/api/verification/projects/prj_missing/profile',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('running verification', () => {
  it('records what really ran and answers with the run', async () => {
    const scripted = scriptedExecutor([{ stdout: vitestStdout, exitCode: 0 }]);
    const { server } = startWith(scripted);
    const projectId = await seedProject();

    const created = await server.inject({
      method: 'POST',
      url: '/api/verification/runs',
      payload: { projectId, operations: ['unit'] },
    });
    expect(created.statusCode).toBe(201);
    const { run } = created.json() as {
      run: {
        id: string;
        status: string;
        results: {
          operation: string;
          status: string;
          argv: string[];
          counts: { passed: number | null };
        }[];
        evidence: { executed: boolean; executedCount: number } | null;
      };
    };
    expect(run.status).toBe('passed');
    expect(run.evidence?.executed).toBe(true);
    expect(run.evidence?.executedCount).toBe(1);
    expect(run.results[0]?.argv.join(' ')).toBe('npm run test --silent');
    expect(run.results[0]?.counts.passed).toBe(9);
    expect(scripted.calls.length).toBe(1);

    const fetched = await server.inject({ method: 'GET', url: `/api/verification/runs/${run.id}` });
    expect((fetched.json() as { run: { id: string } }).run.id).toBe(run.id);
  });

  it('records a failing command as failed, never as passed', async () => {
    const scripted = scriptedExecutor([
      {
        exitCode: 1,
        stdout: 'FAIL src/sum.test.ts > adds\nAssertionError: expected 3 to be 4',
        stderr: '',
      },
    ]);
    const { server } = startWith(scripted);
    const projectId = await seedProject();

    const created = await server.inject({
      method: 'POST',
      url: '/api/verification/runs',
      payload: { projectId, operations: ['unit'] },
    });
    const { run } = created.json() as {
      run: { status: string; results: { errorSummary: string | null }[] };
    };
    expect(run.status).toBe('failed');
    expect(run.results[0]?.errorSummary ?? '').toContain('sum.test');

    const diagnosis = await server.inject({
      method: 'GET',
      url: `/api/verification/runs/${(created.json() as { run: { id: string } }).run.id}/diagnosis`,
    });
    expect(diagnosis.statusCode).toBe(200);
  });

  it('records a blocked run, never a false pass, when no runtime exists', async () => {
    const engine = createEngine();
    app = buildApp({
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      projectEngine: engine,
      verification: createVerificationService({ projects: engine, runtimeMode: 'none' }),
    });
    const projectId = await seedProject();
    const created = await app.inject({
      method: 'POST',
      url: '/api/verification/runs',
      payload: { projectId, operations: ['unit'] },
    });
    expect(created.statusCode).toBe(201);
    const { run } = created.json() as {
      run: {
        status: string;
        evidence: { executed: boolean; executedCount: number } | null;
        results: { status: string; reason: string | null }[];
      };
    };
    // Nothing ran, so nothing can be called a pass, and the reason is recorded.
    expect(run.status).not.toBe('passed');
    expect(run.evidence?.executed).toBe(false);
    expect(run.evidence?.executedCount).toBe(0);
    expect(run.results.some((result) => result.status === 'passed')).toBe(false);
    expect(run.results.every((result) => result.reason === null || result.reason.length > 0)).toBe(
      true,
    );
  });
});

describe('ownership and arguments', () => {
  it('refuses an unknown operation', async () => {
    const { server } = startWith(scriptedExecutor([]));
    const projectId = await seedProject();
    const response = await server.inject({
      method: 'POST',
      url: '/api/verification/runs',
      payload: { projectId, operations: ['rm -rf /'] },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('OPERATION_UNKNOWN');
  });

  it('refuses a project the caller does not own', async () => {
    const { server } = startWith(scriptedExecutor([]));
    const projectId = await seedProject();
    const response = await server.inject({
      method: 'POST',
      url: '/api/verification/runs',
      payload: { projectId, operations: ['unit'] },
      headers: { 'x-veltravia-owner-ref': 'someone-else' },
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists only the caller's runs", async () => {
    const { server } = startWith(
      scriptedExecutor([{ stdout: vitestStdout }, { stdout: vitestStdout }]),
    );
    const projectId = await seedProject();
    await server.inject({
      method: 'POST',
      url: '/api/verification/runs',
      payload: { projectId, operations: ['unit'] },
    });
    const mine = await server.inject({ method: 'GET', url: '/api/verification/runs' });
    expect((mine.json() as { runs: unknown[] }).runs.length).toBe(1);
    const theirs = await server.inject({
      method: 'GET',
      url: '/api/verification/runs',
      headers: { 'x-veltravia-owner-ref': 'someone-else' },
    });
    expect((theirs.json() as { runs: unknown[] }).runs.length).toBe(0);
  });
});
