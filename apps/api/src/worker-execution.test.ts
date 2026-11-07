/**
 * The real-execution wiring: which executor runs, and what it may touch.
 *
 * These are deterministic: the provider is either absent or a stub, so nothing
 * here needs a network call or a quota.
 */

import { describe, expect, it } from 'vitest';

import { validAssignment } from '@veltravia/worker-core';
import {
  createProjectToolHandlers,
  createWorkerExecutor,
  resolveWorkerExecutionMode,
} from './worker-execution.js';

function fakeEngine(files: Map<string, string>) {
  return {
    projects: {},
    workspaces: {
      listWorkspaces: async () => [{ id: 'ws_1', status: 'active' }],
    },
    files: {
      listAll: async () =>
        Array.from(files.keys()).map((path) => ({
          path,
          type: 'file',
          revision: 1,
          updatedAt: 'now',
        })),
      readFile: async (_workspaceId: string, path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error('not found');
        return { node: { path, revision: 3 }, content };
      },
      createFile: async (_workspaceId: string, input: { path: string; content: string }) => {
        files.set(input.path, input.content);
        return { path: input.path, revision: 1 };
      },
      updateFile: async (
        _workspaceId: string,
        path: string,
        input: { content: string; expectedRevision: number },
      ) => {
        files.set(path, input.content);
        return { path, revision: input.expectedRevision + 1 };
      },
      createDirectory: async () => ({ path: 'src', type: 'directory' }),
    },
  } as never;
}

const context = {
  ownerRef: 'owner-1',
  workerId: 'wkr_1',
  workerType: 'frontend',
  taskId: 'task_1',
  projectId: 'prj_1',
  signal: new AbortController().signal,
  deadline: Date.now() + 10_000,
  record: () => undefined,
};

describe('execution mode', () => {
  it('is real by default and simulated only when explicitly asked', () => {
    expect(resolveWorkerExecutionMode({})).toBe('model');
    expect(resolveWorkerExecutionMode({ VELTRAVIA_WORKER_EXECUTOR: 'simulated' })).toBe(
      'simulated',
    );
    expect(resolveWorkerExecutionMode({ VELTRAVIA_WORKER_EXECUTOR: 'MODEL' })).toBe('model');
  });

  it('reports the simulated executor as simulated and the model one as real', () => {
    const engine = fakeEngine(new Map());
    const simulated = createWorkerExecutor({
      gateway: { gateway: null, ready: false, blockedReason: 'no key', keyVersions: [] } as never,
      engine,
      mode: 'simulated',
    });
    expect(simulated.simulated).toBe(true);
    const real = createWorkerExecutor({
      gateway: { gateway: null, ready: false, blockedReason: 'no key', keyVersions: [] } as never,
      engine,
      mode: 'model',
    });
    expect(real.simulated).toBe(false);
  });

  it('refuses to run a worker with no connected provider instead of pretending', async () => {
    const executor = createWorkerExecutor({
      gateway: {
        gateway: null,
        ready: false,
        blockedReason: 'No provider is connected for this owner.',
        keyVersions: [],
      } as never,
      engine: fakeEngine(new Map()),
      mode: 'model',
    });
    await expect(
      executor.run({
        workerId: 'wkr_1',
        ownerRef: 'owner-1',
        taskId: 'task_1',
        projectId: 'prj_1',
        workerType: 'frontend' as never,
        assignment: validAssignment({}),
        signal: new AbortController().signal,
        report: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_PROVIDER_UNAVAILABLE' });
  });
});

describe('project tools', () => {
  it('reads a file and refuses one that is not there', async () => {
    const handlers = createProjectToolHandlers(
      fakeEngine(new Map([['src/a.ts', 'export const a = 1;']])),
    );
    const read = await handlers['project.read']!(
      { tool: 'project.read', arguments: { path: 'src/a.ts' } },
      context,
    );
    expect(read).toMatchObject({ ok: true });
    const missing = await handlers['project.read']!(
      { tool: 'project.read', arguments: { path: 'src/none.ts' } },
      context,
    );
    expect(missing).toMatchObject({ ok: false, code: 'WORKER_TOOL_NOT_FOUND' });
  });

  it('writes a new file and records the changed path', async () => {
    const files = new Map<string, string>();
    const handlers = createProjectToolHandlers(fakeEngine(files));
    const outcome = await handlers['project.write']!(
      { tool: 'project.write', arguments: { path: 'src/panel.tsx', content: 'export {};' } },
      context,
    );
    expect(outcome).toMatchObject({ ok: true, changedPaths: ['src/panel.tsx'] });
    expect(files.get('src/panel.tsx')).toBe('export {};');
  });

  it('finds a line by search and describes the structure', async () => {
    const handlers = createProjectToolHandlers(
      fakeEngine(new Map([['src/a.ts', 'const needle = 1;']])),
    );
    const search = await handlers['project.search']!(
      { tool: 'project.search', arguments: { query: 'needle' } },
      context,
    );
    expect(search.ok && search.output).toContain('src/a.ts:1');
    const structure = await handlers['project.structure']!(
      { tool: 'project.structure', arguments: {} },
      context,
    );
    expect(structure.ok && structure.output).toContain('ts: 1');
  });

  it('says tests are unavailable rather than claiming they ran', async () => {
    const handlers = createProjectToolHandlers(fakeEngine(new Map()));
    const outcome = await handlers['tests.run']!({ tool: 'tests.run', arguments: {} }, context);
    expect(outcome).toMatchObject({ ok: false, code: 'WORKER_TOOL_UNAVAILABLE' });
  });

  it('refuses every project tool when there is no workspace', async () => {
    const handlers = createProjectToolHandlers(fakeEngine(new Map()), async () => null);
    const outcome = await handlers['project.read']!(
      { tool: 'project.read', arguments: { path: 'src/a.ts' } },
      context,
    );
    expect(outcome).toMatchObject({ ok: false, code: 'WORKER_TOOL_UNAVAILABLE' });
  });
});
