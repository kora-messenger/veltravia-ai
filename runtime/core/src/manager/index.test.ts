import { beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidRuntimeRequestError,
  MAX_ACTIVE_RUNTIMES,
  MAX_RUNTIMES_PER_WORKSPACE,
  RuntimeExpiredError,
  RuntimeLimitExceededError,
  RuntimeNotFoundError,
  RuntimeRevisionMismatchError,
  type RuntimeAuditEvent,
  type RuntimeDetectionEvidence,
  type RuntimeManager,
  type RuntimeView,
  type RuntimeWorkspaceGateway,
} from '@veltravia/runtime-core';
import { createMockRuntimeExecutor, type MockRuntimeExecutor } from '@veltravia/runtime-mock';

/** Deterministic in-memory gateway over a fake project workspace store. */
function createGateway() {
  const workspaces = new Map<
    string,
    { projectId: string; revision: number; status: 'active' | 'archived'; files: Set<string> }
  >();
  const projects = new Set<string>();
  const state = {
    workspaces,
    projects,
    createProject(id: string) {
      projects.add(id);
    },
    createWorkspace(id: string, projectId: string, files: string[] = []) {
      workspaces.set(id, { projectId, revision: 1, status: 'active', files: new Set(files) });
    },
    bumpRevision(id: string) {
      const ws = workspaces.get(id);
      if (ws) ws.revision += 1;
    },
    addFile(id: string, path: string) {
      const ws = workspaces.get(id);
      if (ws) ws.files.add(path);
    },
  };
  const gateway: RuntimeWorkspaceGateway = {
    async getWorkspace(workspaceId: string) {
      const ws = workspaces.get(workspaceId);
      if (!ws) throw new Error('not found');
      return { projectId: ws.projectId, revision: ws.revision, status: ws.status };
    },
    async listWorkspaceFiles(workspaceId: string) {
      const ws = workspaces.get(workspaceId);
      if (!ws) throw new Error('not found');
      return [...ws.files];
    },
    async projectExists(projectId: string) {
      return projects.has(projectId);
    },
  };
  return { gateway, state };
}

function createEvidence(state: ReturnType<typeof createGateway>['state']) {
  return async (
    workspaceId: string,
    _requestedType: undefined,
  ): Promise<RuntimeDetectionEvidence> => {
    const ws = state.workspaces.get(workspaceId);
    if (!ws) throw new Error('not found');
    const files = [...ws.files];
    return {
      projectId: ws.projectId,
      workspaceId,
      workspaceRevision: ws.revision,
      frameworks: files.some((f) => f === 'server/index.ts')
        ? ['vite', 'react', 'fastify']
        : ['vite', 'react'],
      manifestScripts: files.some((f) => f === 'server/index.ts')
        ? ['dev', 'build', 'start:server']
        : ['dev', 'build', 'preview'],
      hasManifest: files.includes('package.json'),
      hasLockfile: files.includes('package-lock.json'),
      presentFiles: files,
    };
  };
}

async function fresh(): Promise<{
  manager: RuntimeManager;
  executor: MockRuntimeExecutor;
  state: ReturnType<typeof createGateway>['state'];
  audits: RuntimeAuditEvent[];
  clock: { now: Date };
}> {
  const { gateway, state } = createGateway();
  state.createProject('proj_1');
  state.createWorkspace('ws_1', 'proj_1', [
    'package.json',
    'index.html',
    'src/main.tsx',
    'src/App.tsx',
  ]);
  const executor = createMockRuntimeExecutor();
  const audits: RuntimeAuditEvent[] = [];
  const clock = { now: new Date('2026-01-01T10:00:00Z') };
  const { RuntimeManager: RM } = await import('@veltravia/runtime-core');
  const manager = new RM({
    executor,
    gateway,
    evidenceProvider: createEvidence(state),
    now: () => clock.now,
    auditSink: (event) => audits.push(event),
    generateRuntimeId: (() => {
      let counter = 0;
      return () => `rt_${(counter += 1)}`;
    })(),
  });
  return { manager, executor, state, audits, clock };
}

async function startedRuntime(manager: RuntimeManager, scenario?: string): Promise<RuntimeView> {
  const created = await manager.create({
    projectId: 'proj_1',
    workspaceId: 'ws_1',
    ...(scenario !== undefined ? { scenario } : {}),
  });
  return manager.start(created.runtimeId);
}

beforeEach(() => {
  // each test builds its own fresh() - nothing shared
});

describe('runtime manager: create', () => {
  it('creates a runtime with a detected, validated plan', async () => {
    const { manager } = await fresh();
    const view = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    expect(view.status).toBe('created');
    expect(view.runtimeType).toBe('web');
    expect(view.revision).toBe(1);
    expect(view.currentRevision).toBe(1);
    expect(view.stale).toBe(false);
    expect(view.previewUrl).toBeNull();
    expect(view.plan.startCommand.arguments).toEqual(['run', 'preview']);
  });

  it('reports the honest simulated isolation level', async () => {
    const { manager } = await fresh();
    const view = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    expect(view.isolationLevel).toBe('simulated');
    expect(view.executorId).toBe('mock-runtime');
  });

  it('rejects unknown projects and mismatched workspaces', async () => {
    const { manager } = await fresh();
    await expect(manager.create({ projectId: 'proj_nope', workspaceId: 'ws_1' })).rejects.toThrow(
      InvalidRuntimeRequestError,
    );
    const { state } = await fresh();
    state.createProject('proj_2');
    state.createWorkspace('ws_2', 'proj_2', ['package.json']);
    const { manager: m2, state: s2 } = await fresh();
    s2.createProject('proj_2');
    s2.createWorkspace('ws_2', 'proj_2', ['package.json']);
    await expect(m2.create({ projectId: 'proj_1', workspaceId: 'ws_2' })).rejects.toThrow(
      InvalidRuntimeRequestError,
    );
  });

  it('rejects a workspace whose plan-required files are missing', async () => {
    const { state } = await fresh();
    // The manifest DECLARES start:server, but server/index.ts is absent:
    // detection produces a fullstack plan whose required file does not exist.
    state.createWorkspace('ws_full', 'proj_1', ['package.json', 'index.html']);
    const { RuntimeManager: RM } = await import('@veltravia/runtime-core');
    const manager2 = new RM({
      executor: createMockRuntimeExecutor(),
      gateway: {
        async getWorkspace() {
          return { projectId: 'proj_1', revision: 1, status: 'active' };
        },
        async listWorkspaceFiles(workspaceId: string) {
          return [...(state.workspaces.get(workspaceId)?.files ?? [])];
        },
        async projectExists() {
          return true;
        },
      },
      evidenceProvider: async (workspaceId: string) => ({
        projectId: 'proj_1',
        workspaceId,
        workspaceRevision: 1,
        frameworks: ['vite', 'react', 'fastify'],
        manifestScripts: ['dev', 'build', 'start:server'],
        hasManifest: true,
        hasLockfile: false,
        presentFiles: [...(state.workspaces.get(workspaceId)?.files ?? [])],
      }),
      now: () => new Date('2026-01-01T10:00:00Z'),
    });
    await expect(manager2.create({ projectId: 'proj_1', workspaceId: 'ws_full' })).rejects.toThrow(
      InvalidRuntimeRequestError,
    );
  });

  it('enforces the per-workspace runtime ceiling', async () => {
    const { manager } = await fresh();
    for (let i = 0; i < MAX_RUNTIMES_PER_WORKSPACE; i += 1) {
      await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    }
    await expect(manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' })).rejects.toThrow(
      RuntimeLimitExceededError,
    );
  });
});

describe('runtime manager: start lifecycle', () => {
  it('runs created -> preparing -> building -> starting -> running with logs', async () => {
    const { manager } = await fresh();
    const view = await startedRuntime(manager);
    expect(view.status).toBe('running');
    expect(view.previewUrl).toBe('/preview/rt_1');
    expect(view.lastHealth).toBe('healthy');
    const logs = await manager.logs(view.runtimeId);
    const phases = logs.entries.map((entry) => entry.phase);
    expect(phases).toContain('prepare');
    expect(phases).toContain('build');
    expect(phases).toContain('start');
    expect(phases).toContain('health');
    expect(phases).toContain('run');
  });

  it('fails with a structured report when the build fails', async () => {
    const { manager } = await fresh();
    const created = await manager.create({
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      scenario: 'build-failure',
    });
    const view = await manager.start(created.runtimeId);
    expect(view.status).toBe('failed');
    expect(view.failure?.kind).toBe('build_failed');
    expect(view.failure?.phase).toBe('build');
    expect(view.previewUrl).toBeNull();
  });

  it('fails with missing_dependency when the simulated dependency is absent', async () => {
    const { manager } = await fresh();
    const created = await manager.create({
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      scenario: 'missing-dependency',
    });
    const view = await manager.start(created.runtimeId);
    expect(view.failure?.kind).toBe('missing_dependency');
  });

  it('fails with a structured report when startup fails', async () => {
    const { manager } = await fresh();
    const created = await manager.create({
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      scenario: 'start-failure',
    });
    const view = await manager.start(created.runtimeId);
    expect(view.status).toBe('failed');
    expect(view.failure?.kind).toBe('start_failed');
    expect(view.failure?.phase).toBe('start');
  });

  it('fails with port_conflict when the port is taken', async () => {
    const { manager } = await fresh();
    const created = await manager.create({
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      scenario: 'port-conflict',
    });
    const view = await manager.start(created.runtimeId);
    expect(view.failure?.kind).toBe('port_conflict');
  });

  it('fails with health_failed after bounded checks (never a poll loop)', async () => {
    const { manager } = await fresh();
    const created = await manager.create({
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      scenario: 'health-failure',
    });
    const view = await manager.start(created.runtimeId);
    expect(view.status).toBe('failed');
    expect(view.failure?.kind).toBe('health_failed');
    // Bounded: the executor was probed at most maxChecks times.
    const { executor } = await fresh();
    const probes = executor.capturedCalls.filter((call) => call.kind === 'health').length;
    expect(probes).toBeLessThanOrEqual(20);
  });

  it('succeeds after flaky health checks', async () => {
    const { manager } = await fresh();
    const view = await startedRuntime(manager, 'flaky-then-healthy');
    expect(view.status).toBe('running');
    expect(view.lastHealth).toBe('healthy');
  });

  it('rejects a start when the workspace revision moved (stale)', async () => {
    const { manager, state } = await fresh();
    const created = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    state.bumpRevision('ws_1');
    await expect(manager.start(created.runtimeId)).rejects.toThrow(RuntimeRevisionMismatchError);
  });

  it('rejects a start from a non-startable state', async () => {
    const { manager } = await fresh();
    const view = await startedRuntime(manager);
    await expect(manager.start(view.runtimeId)).rejects.toThrow(InvalidRuntimeRequestError);
  });
});

describe('runtime manager: stop / cancel / restart', () => {
  it('stops a running runtime', async () => {
    const { manager } = await fresh();
    const started = await startedRuntime(manager);
    const stopped = await manager.stop(started.runtimeId);
    expect(stopped.status).toBe('stopped');
    expect(stopped.stoppedAt).not.toBeNull();
    const logs = await manager.logs(started.runtimeId);
    expect(logs.entries.some((entry) => entry.phase === 'stop')).toBe(true);
  });

  it('rejects stopping a non-live runtime', async () => {
    const { manager } = await fresh();
    const created = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    await expect(manager.stop(created.runtimeId)).rejects.toThrow(InvalidRuntimeRequestError);
  });

  it('cancels a live runtime one-way', async () => {
    const { manager } = await fresh();
    const started = await startedRuntime(manager);
    const cancelled = await manager.cancel(started.runtimeId);
    expect(cancelled.status).toBe('cancelled');
    await expect(manager.start(started.runtimeId)).rejects.toThrow();
  });

  it('restarts at the LATEST revision and stops the old runtime', async () => {
    const { manager, state } = await fresh();
    const first = await startedRuntime(manager);
    state.bumpRevision('ws_1');
    const { previous, next } = await manager.restart(first.runtimeId);
    expect(previous.status).toBe('stopped');
    expect(next.status).toBe('running');
    expect(next.runtimeId).not.toBe(first.runtimeId);
    expect(next.revision).toBe(2);
    expect(next.stale).toBe(false);
  });

  it('restarting a stopped runtime retires any OTHER live runtime of the workspace', async () => {
    const { manager } = await fresh();
    const first = await startedRuntime(manager);
    await manager.stop(first.runtimeId);
    // A newer preview is running while the user restarts the old, stopped one.
    const second = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    await manager.start(second.runtimeId);
    const { previous, next } = await manager.restart(first.runtimeId);
    expect(previous.status).toBe('stopped');
    expect(next.status).toBe('running');
    // The other live runtime was retired - ONE preview per workspace.
    const views = await manager.list({ projectId: 'proj_1' });
    const runningIds = views
      .filter((view) => view.status === 'running')
      .map((view) => view.runtimeId);
    expect(runningIds).toEqual([next.runtimeId]);
  });

  it('restart preserves the scenario', async () => {
    const { manager } = await fresh();
    const first = await startedRuntime(manager, 'flaky-then-healthy');
    const { next } = await manager.restart(first.runtimeId);
    expect(next.status).toBe('running');
  });
});

describe('runtime manager: revision binding + staleness', () => {
  it('reports a running runtime as stale after the workspace advances', async () => {
    const { manager, state } = await fresh();
    const view = await startedRuntime(manager);
    expect(view.stale).toBe(false);
    state.bumpRevision('ws_1');
    const freshView = await manager.get(view.runtimeId);
    expect(freshView.stale).toBe(true);
    expect(freshView.currentRevision).toBe(2);
    expect(freshView.revision).toBe(1);
    // The runtime keeps running but is honestly labeled - never silently rebased.
    expect(freshView.status).toBe('running');
  });

  it('never lets a stale runtime silently become current', async () => {
    const { manager, state } = await fresh();
    const view = await startedRuntime(manager);
    state.bumpRevision('ws_1');
    const freshView = await manager.get(view.runtimeId);
    expect(freshView.revision).toBe(1);
    expect(freshView.stale).toBe(true);
  });
});

describe('runtime manager: expiration + cleanup', () => {
  it('expires a running runtime at its lifetime deadline', async () => {
    const { manager, clock } = await fresh();
    const view = await startedRuntime(manager);
    // default maxLifetimeMs is 2h
    clock.now = new Date('2026-01-01T12:01:00Z');
    const swept = await manager.sweepExpired();
    expect(swept).toBe(1);
    const after = await manager.get(view.runtimeId);
    expect(after.status).toBe('expired');
  });

  it('expires a running runtime after the idle timeout', async () => {
    const { manager, clock } = await fresh();
    const view = await startedRuntime(manager);
    // default idleTimeoutMs is 30m
    clock.now = new Date('2026-01-01T10:31:00Z');
    const swept = await manager.sweepExpired();
    expect(swept).toBe(1);
    const after = await manager.get(view.runtimeId);
    expect(after.status).toBe('expired');
  });

  it('keeps a runtime alive while it is actively used', async () => {
    const { manager, clock } = await fresh();
    const view = await startedRuntime(manager);
    clock.now = new Date('2026-01-01T10:20:00Z');
    await manager.get(view.runtimeId);
    clock.now = new Date('2026-01-01T10:45:00Z');
    const after = await manager.get(view.runtimeId);
    expect(after.status).toBe('running');
  });

  it('supports explicit expiry', async () => {
    const { manager } = await fresh();
    const view = await startedRuntime(manager);
    const expired = await manager.expire(view.runtimeId);
    expect(expired.status).toBe('expired');
    await expect(manager.expire(view.runtimeId)).rejects.toThrow(RuntimeExpiredError);
  });

  it('cleanup removes terminal records only', async () => {
    const { manager } = await fresh();
    const live = await startedRuntime(manager);
    const dead = await startedRuntime(manager, 'build-failure');
    expect(dead.status).toBe('failed');
    const removed = await manager.cleanup({});
    expect(removed).toBe(1);
    const remaining = await manager.list({ projectId: 'proj_1' });
    expect(remaining.map((view) => view.runtimeId)).toEqual([live.runtimeId]);
  });
});

describe('runtime manager: reads + audit', () => {
  it('lists runtimes scoped to a project, newest first', async () => {
    const { manager } = await fresh();
    await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    const views = await manager.list({ projectId: 'proj_1' });
    expect(views.length).toBe(2);
    expect(views[0]?.runtimeId).toBe('rt_2');
  });

  it('404s unknown runtimes with a typed error', async () => {
    const { manager } = await fresh();
    expect(manager.get('rt_missing')).rejects.toThrow(RuntimeNotFoundError);
    expect(manager.logs('rt_missing')).rejects.toThrow(RuntimeNotFoundError);
  });

  it('emits scrubbed audit events across the lifecycle', async () => {
    const { manager, audits } = await fresh();
    const view = await startedRuntime(manager);
    await manager.stop(view.runtimeId);
    const types = audits.map((event) => event.type);
    expect(types).toContain('runtime.created');
    expect(types).toContain('runtime.started');
    expect(types).toContain('runtime.stopped');
    for (const event of audits) {
      expect(event.projectId).toBe('proj_1');
      expect(event.runtimeId).toMatch(/^rt_/);
      expect(JSON.stringify(event)).not.toContain('sk-');
      expect(JSON.stringify(event)).not.toContain('ghp_');
    }
  });

  it('health reports stopped for a non-running runtime', async () => {
    const { manager } = await fresh();
    const created = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    const health = await manager.health(created.runtimeId);
    expect(health.status).toBe('stopped');
  });

  it('openPreview rejects a non-running runtime', async () => {
    const { manager } = await fresh();
    const created = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    await expect(manager.openPreview(created.runtimeId)).rejects.toThrow(
      InvalidRuntimeRequestError,
    );
  });
});

describe('runtime manager: hard ceilings', () => {
  it('rejects starts beyond the global active ceiling', async () => {
    const { manager, state } = await fresh();
    state.createWorkspace('ws_a', 'proj_1', ['package.json']);
    state.createWorkspace('ws_b', 'proj_1', ['package.json']);
    let started = 0;
    try {
      for (let i = 0; i < MAX_ACTIVE_RUNTIMES + 1; i += 1) {
        const workspaceId = i % 2 === 0 ? 'ws_a' : 'ws_b';
        if (i >= MAX_RUNTIMES_PER_WORKSPACE) break;
        const created = await manager.create({ projectId: 'proj_1', workspaceId });
        await manager.start(created.runtimeId);
        started += 1;
      }
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeLimitExceededError);
    }
    expect(started).toBeLessThanOrEqual(MAX_RUNTIMES_PER_WORKSPACE);
  });
});

describe('runtime manager: preview rendering', () => {
  it('renders preview content through the executor with the real handle', async () => {
    const { manager } = await fresh();
    const view = await startedRuntime(manager);
    const html = await manager.renderPreview(view.runtimeId);
    expect(html).toContain('SIMULATED');
    expect(html).toContain('npm run preview');
    expect(html).toContain('proj_1');
  });

  it('rejects rendering for a non-running runtime', async () => {
    const { manager } = await fresh();
    const created = await manager.create({ projectId: 'proj_1', workspaceId: 'ws_1' });
    await expect(manager.renderPreview(created.runtimeId)).rejects.toThrow(
      InvalidRuntimeRequestError,
    );
  });
});
