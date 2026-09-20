import { describe, expect, it } from 'vitest';
import type { ExecutorRuntimeHandle } from '@veltravia/runtime-core';
import {
  DEFAULT_RUNTIME_LIMITS,
  extractRuntimeMemoryCandidates,
  RuntimeManager,
} from '@veltravia/runtime-core';
import { createMockRuntimeExecutor, MOCK_RUNTIME_SCENARIOS } from '@veltravia/runtime-mock';

function handle(scenario?: string): ExecutorRuntimeHandle {
  return {
    runtimeId: 'rt_test',
    projectId: 'proj_1',
    workspaceId: 'ws_1',
    revision: 1,
    plan: {
      runtimeType: 'web',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      expectedRevision: 1,
      requiredFiles: ['package.json'],
      buildCommand: { executable: 'npm', arguments: ['run', 'build'] },
      startCommand: { executable: 'npm', arguments: ['run', 'preview'] },
      port: 4173,
      environment: {},
      healthCheck: { path: '/', intervalMs: 500, timeoutMs: 5000, maxChecks: 20 },
      limits: { ...DEFAULT_RUNTIME_LIMITS },
      evidence: [],
    },
    ...(scenario !== undefined ? { scenario } : {}),
  };
}

describe('mock runtime executor honesty', () => {
  it('identifies itself as simulated with zero OS enforcement claims', () => {
    const executor = createMockRuntimeExecutor();
    expect(executor.isolationLevel).toBe('simulated');
    expect(executor.executorId).toBe('mock-runtime');
    expect(executor.enforcement.maxMemoryMb).toBe('unavailable');
    expect(executor.enforcement.maxDiskMb).toBe('unavailable');
    expect(executor.enforcement.buildTimeoutMs).toBe('requested');
    expect(executor.enforcement.maxLifetimeMs).toBe('enforced');
  });

  it('exposes every scenario the QA matrix requires', () => {
    expect(MOCK_RUNTIME_SCENARIOS).toContain('ok');
    expect(MOCK_RUNTIME_SCENARIOS).toContain('build-failure');
    expect(MOCK_RUNTIME_SCENARIOS).toContain('start-failure');
    expect(MOCK_RUNTIME_SCENARIOS).toContain('health-failure');
    expect(MOCK_RUNTIME_SCENARIOS).toContain('resource-limit');
    expect(MOCK_RUNTIME_SCENARIOS).toContain('port-conflict');
    expect(MOCK_RUNTIME_SCENARIOS).toContain('missing-dependency');
  });

  it('throws on unknown scenarios rather than silently succeeding', async () => {
    const executor = createMockRuntimeExecutor();
    await expect(executor.build(handle('no-such-scenario'))).rejects.toThrow();
  });
});

describe('mock runtime executor behavior matrix', () => {
  it('ok: build + start succeed, health is healthy', async () => {
    const executor = createMockRuntimeExecutor();
    const h = handle();
    const build = await executor.build(h);
    expect(build.ok).toBe(true);
    const start = await executor.start(h);
    expect(start.ok).toBe(true);
    expect(start.previewToken).toBe('tok_rt_test');
    expect(executor.isHosting(h)).toBe(true);
    const health = await executor.health(h);
    expect(health.status).toBe('healthy');
  });

  it('build-failure: structured build failure', async () => {
    const executor = createMockRuntimeExecutor();
    const result = await executor.build(handle('build-failure'));
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('build_failed');
  });

  it('start-failure and port-conflict: structured start failures', async () => {
    const executor = createMockRuntimeExecutor();
    const failed = await executor.start(handle('start-failure'));
    expect(failed.ok).toBe(false);
    expect(failed.failureKind).toBe('start_failed');
    expect(failed.previewToken).toBeNull();
    const conflict = await executor.start(handle('port-conflict'));
    expect(conflict.failureKind).toBe('port_conflict');
  });

  it('stop releases hosting idempotently', async () => {
    const executor = createMockRuntimeExecutor();
    const h = handle();
    await executor.start(h);
    expect(executor.isHosting(h)).toBe(true);
    await executor.stop(h);
    await executor.stop(h);
    expect(executor.isHosting(h)).toBe(false);
    const health = await executor.health(h);
    expect(health.status).toBe('stopped');
  });
});

describe('mock preview content safety', () => {
  it('labels itself as a SIMULATED preview and escapes project names', () => {
    const executor = createMockRuntimeExecutor();
    const content = executor.previewContent(handle(), {
      projectName: 'Evil <script>alert(1)</script>',
      isolationLevel: 'simulated',
      executorId: 'mock-runtime',
    });
    expect(content).toContain('SIMULATED');
    expect(content).not.toContain('<script>alert');
    expect(content).toContain('&lt;script&gt;');
    expect(content).toContain('mock-runtime');
    expect(content).not.toContain('/usr/');
    expect(content).not.toContain('localhost');
    expect(content).not.toContain('127.0.0.1');
  });
});

describe('runtime security boundaries (Phase 30)', () => {
  it('never passes host paths or environment to the executor', async () => {
    const executor = createMockRuntimeExecutor();
    const manager = new RuntimeManager({
      executor,
      gateway: {
        async getWorkspace() {
          return { projectId: 'proj_1', revision: 1, status: 'active' };
        },
        async listWorkspaceFiles() {
          return ['package.json'];
        },
        async projectExists() {
          return true;
        },
      },
      evidenceProvider: async (workspaceId: string) => ({
        projectId: 'proj_1',
        workspaceId,
        workspaceRevision: 1,
        frameworks: ['vite'],
        manifestScripts: ['preview'],
        hasManifest: true,
        hasLockfile: false,
        presentFiles: ['package.json'],
      }),
      now: () => new Date(),
    });
    const created = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    const view = await manager.start(created.runtimeId);
    // The captured handle must contain only ids, revision, and the validated plan.
    for (const call of executor.capturedCalls) {
      expect(call.runtimeId).toMatch(/^rt_/);
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(process.env.HOME ?? 'no-home');
      expect(serialized).not.toContain('/tmp/');
    }
    const planJson = JSON.stringify(view.plan);
    expect(planJson).not.toContain('GITHUB_TOKEN');
    expect(planJson).not.toContain('OPENROUTER');
    expect(view.plan.environment).toEqual({});
  });

  it('runtime records never expose connector credentials anywhere', async () => {
    const candidates = extractRuntimeMemoryCandidates({
      runtimeId: 'rt_x',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      runtimeType: 'web',
      revision: 1,
      hasBuildStep: true,
      startScript: 'npm run preview',
      isolationLevel: 'simulated',
    });
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('credential');
  });
});
