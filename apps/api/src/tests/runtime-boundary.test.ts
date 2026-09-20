/**
 * Runtime layer trust boundaries (Step 17).
 *
 * Static + behavioral guarantees:
 * - the runtime packages never spawn processes, shells, or touch the host
 *   filesystem directly - the RuntimeExecutor SEAM is the only path
 * - the API never accepts commands, ports, limits, or environment values
 *   from the browser; the plan is detected server-side from evidence
 * - the preview route serves through the platform-controlled URL with
 *   sandboxing headers; the API server is NEVER the runtime
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

function readSource(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf-8');
}

describe('runtime source boundaries', () => {
  it('runtime/core + runtime/mock never spawn processes or shells', () => {
    const forbidden = [
      /child_process/,
      /require\(['"]node:fs/,
      /from ['"]node:fs['"]/,
      /spawnSync/,
      /\bexecSync\b/,
      /\bpopen\b/,
    ];
    const core =
      readSource('runtime/core/src/manager/index.ts') +
      readSource('runtime/core/src/executor/index.ts') +
      readSource('runtime/mock/src/index.ts');
    for (const pattern of forbidden) {
      expect(pattern.test(core), `pattern ${pattern} found in runtime source`).toBe(false);
    }
  });

  it('the create schema accepts only lifecycle intents (never commands or config)', () => {
    const routeSource = readSource('apps/api/src/routes/runtimes.ts');
    const schemaMatch = routeSource.match(/const createBodySchema = \{[\s\S]*?\n\};/);
    expect(schemaMatch).not.toBeNull();
    const schema = schemaMatch![0];
    expect(schema).toContain('workspaceId');
    expect(schema).not.toContain('startCommand');
    expect(schema).not.toContain('buildCommand');
    expect(schema).not.toContain('environment');
    expect(schema).not.toContain('limits');
    expect(schema).toMatch(/port.*maxLength|runtimeType|scenario/);
    expect(schema).not.toMatch(/^\s*port:/m);
  });

  it('the manager is the only caller of the executor seam', () => {
    const core = readSource('runtime/core/src/manager/index.ts');
    expect(core).toContain('this.executor.build(');
    expect(core).toContain('this.executor.start(');
    const apiService = readSource('apps/api/src/runtime-service.ts');
    expect(apiService).toContain('createMockRuntimeExecutor()');
    expect(apiService).not.toContain('.build(');
    expect(apiService).not.toContain('.start(');
  });
});

describe('runtime HTTP boundaries', () => {
  it('rejects every command-shaped payload with a strict 400', async () => {
    const app = buildApp();
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Boundary', projectType: 'web', description: 'boundary fixture' },
    });
    const projectId = project.json().id as string;
    const workspace = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workspaces`,
      payload: { name: 'main' },
    });
    const workspaceId = workspace.json().id as string;
    const hostilePayloads = [
      { workspaceId, startCommand: { executable: 'bash', arguments: ['-c', 'id'] } },
      { workspaceId, buildCommand: { executable: 'sh', arguments: [] } },
      { workspaceId, port: 22 },
      { workspaceId, environment: { PATH: '/usr/bin' } },
      { workspaceId, limits: { maxMemoryMb: 999999 } },
    ];
    for (const payload of hostilePayloads) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runtimes`,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('exposes no execution or shell endpoints', async () => {
    const routeSource = readSource('apps/api/src/routes/runtimes.ts');
    expect(routeSource).not.toMatch(/app\.(get|post)\(['"]\/api\/(exec|shell|run)/);
    expect(routeSource).toContain('/preview/:runtimeId');
  });

  it('serves the preview only through the platform-controlled sandboxed URL', async () => {
    const project = await buildApp().inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Preview Boundary', projectType: 'web', description: 'fixture' },
    });
    const app = buildApp();
    const projectId = (await (async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Preview Boundary 2', projectType: 'web', description: 'fixture' },
      });
      return response.json().id as string;
    })())!;
    void project;
    const workspace = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workspaces`,
      payload: { name: 'main' },
    });
    const workspaceId = workspace.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: {
        path: 'package.json',
        content: JSON.stringify({ scripts: { preview: 'vite preview' } }),
      },
    });
    const runtime = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes`,
      payload: { workspaceId },
    });
    const runtimeId = runtime.json().runtimeId as string;
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes/${runtimeId}/start`,
      payload: {},
    });
    const preview = await app.inject({ method: 'GET', url: `/preview/${runtimeId}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.body).toContain('SIMULATED');
  });
});
