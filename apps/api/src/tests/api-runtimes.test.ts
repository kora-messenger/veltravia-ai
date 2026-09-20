import { describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';

/**
 * Step 17: preview / app runtime over the API. The HTTP surface is
 * project-scoped (unknown project -> 404, foreign runtime -> 404),
 * workspace association and revision binding are validated server-side,
 * the plan is DETECTED from evidence (the browser never supplies commands,
 * ports, limits, or environment values), failures are structured and
 * honest, and the preview page is served through the platform-controlled
 * /preview/:runtimeId URL.
 */

type App = ReturnType<typeof buildApp>;

interface RuntimeView {
  runtimeId: string;
  projectId: string;
  workspaceId: string;
  revision: number;
  status: string;
  runtimeType: string;
  isolationLevel: string;
  executorId: string;
  previewUrl: string | null;
  lastHealth: string | null;
  stale: boolean;
  currentRevision: number;
  failure: { kind: string; phase: string; message: string } | null;
  plan: {
    buildCommand: { executable: string; arguments: string[] } | null;
    startCommand: { executable: string; arguments: string[] };
    port: number;
    environment: Record<string, string>;
  };
}

const WEB_MANIFEST = JSON.stringify({
  name: 'preview-demo',
  scripts: { build: 'vite build', preview: 'vite preview --port 4173' },
  dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
  devDependencies: { vite: '^5.0.0' },
});

async function seedWorkspace(
  app: App,
  files: readonly { path: string; content: string }[] = [
    { path: 'package.json', content: WEB_MANIFEST },
    { path: 'index.html', content: '<html><body><div id="root"></div></body></html>' },
  ],
): Promise<{ projectId: string; workspaceId: string }> {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Runtime Fixture',
      projectType: 'web',
      description: 'A demo project for preview runtime tests.',
    },
  });
  const projectId = project.json().id as string;
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    payload: { name: 'main' },
  });
  const workspaceId = workspace.json().id as string;
  for (const file of files) {
    const segments = file.path.split('/');
    if (segments.length > 1) {
      let dir = '';
      for (const segment of segments.slice(0, -1)) {
        dir = dir === '' ? segment : `${dir}/${segment}`;
        await app.inject({
          method: 'POST',
          url: `/api/workspaces/${workspaceId}/directories`,
          payload: { path: dir },
        });
      }
    }
    const response = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path: file.path, content: file.content },
    });
    if (response.statusCode !== 201 && response.statusCode !== 200) {
      throw new Error(`write ${file.path} failed: ${response.body}`);
    }
  }
  return { projectId, workspaceId };
}

async function createRuntime(
  app: App,
  projectId: string,
  workspaceId: string,
  scenario?: string,
): Promise<RuntimeView> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/runtimes`,
    payload: {
      workspaceId,
      ...(scenario !== undefined ? { scenario } : {}),
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`create runtime failed: ${response.body}`);
  }
  return response.json() as RuntimeView;
}

async function startRuntime(app: App, projectId: string, runtimeId: string): Promise<RuntimeView> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/runtimes/${runtimeId}/start`,
    payload: {},
  });
  return response.json() as RuntimeView;
}

describe('runtime API: create + plan detection', () => {
  it('detects a web plan from manifest evidence (build + preview)', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const view = await createRuntime(app, projectId, workspaceId);
    expect(view.status).toBe('created');
    expect(view.runtimeType).toBe('web');
    expect(view.plan.buildCommand?.arguments).toEqual(['run', 'build']);
    expect(view.plan.startCommand.arguments).toEqual(['run', 'preview']);
    expect(view.plan.port).toBe(4173);
    expect(view.plan.environment).toEqual({});
    // Honesty first: the simulated executor is labeled as such.
    expect(view.isolationLevel).toBe('simulated');
    expect(view.executorId).toBe('mock-runtime');
  });

  it('rejects an unknown project with 404', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj_nope/runtimes',
      payload: { workspaceId: 'ws_any' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a foreign runtime on another project with 404', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const other = await seedWorkspace(app);
    const view = await createRuntime(app, projectId, workspaceId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${other.projectId}/runtimes/${view.runtimeId}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a workspace without preview evidence with 422', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app, [
      { path: 'notes.txt', content: 'no manifest here' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes`,
      payload: { workspaceId },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('RUNTIME_PLAN_REJECTED');
  });

  it('rejects unsupported runtime types with 422', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes`,
      payload: { workspaceId, runtimeType: 'mobile-preview' },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('RUNTIME_TYPE_UNSUPPORTED');
  });

  it('rejects extra body fields (strict schema)', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes`,
      payload: { workspaceId, port: 3000, command: 'bash' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('runtime API: start lifecycle + failure matrix', () => {
  it('starts a healthy preview with a platform-controlled URL', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId);
    const view = await startRuntime(app, projectId, created.runtimeId);
    expect(view.status).toBe('running');
    expect(view.previewUrl).toBe(`/preview/${created.runtimeId}`);
    expect(view.lastHealth).toBe('healthy');
  });

  it('reports structured build failures honestly (scenario matrix)', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    for (const [scenario, kind] of [
      ['build-failure', 'build_failed'],
      ['missing-dependency', 'missing_dependency'],
      ['resource-limit', 'resource_exhausted'],
    ] as const) {
      const created = await createRuntime(app, projectId, workspaceId, scenario);
      const view = await startRuntime(app, projectId, created.runtimeId);
      expect(view.status).toBe('failed');
      expect(view.failure?.kind).toBe(kind);
      expect(view.previewUrl).toBeNull();
    }
  });

  it('reports structured start failures (start-failure, port-conflict)', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    for (const [scenario, kind] of [
      ['start-failure', 'start_failed'],
      ['port-conflict', 'port_conflict'],
    ] as const) {
      const created = await createRuntime(app, projectId, workspaceId, scenario);
      const view = await startRuntime(app, projectId, created.runtimeId);
      expect(view.status).toBe('failed');
      expect(view.failure?.kind).toBe(kind);
    }
  });

  it('fails honestly when health checks never pass', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId, 'health-failure');
    const view = await startRuntime(app, projectId, created.runtimeId);
    expect(view.status).toBe('failed');
    expect(view.failure?.kind).toBe('health_failed');
  });

  it('serves bounded, structured logs for a started runtime', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId);
    await startRuntime(app, projectId, created.runtimeId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runtimes/${created.runtimeId}/logs`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: { phase: string }[] };
    expect(body.entries.length).toBeGreaterThan(3);
    expect(body.entries.some((entry) => entry.phase === 'build')).toBe(true);
  });
});

describe('runtime API: stop / cancel / restart + staleness', () => {
  it('stops, cancels, and rejects double stops', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId);
    await startRuntime(app, projectId, created.runtimeId);
    const stopped = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes/${created.runtimeId}/stop`,
      payload: {},
    });
    expect(stopped.statusCode).toBe(200);
    expect((stopped.json() as RuntimeView).status).toBe('stopped');
    const again = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes/${created.runtimeId}/stop`,
      payload: {},
    });
    expect(again.statusCode).toBe(400);
  });

  it('restarts at the latest revision after a workspace change', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId);
    await startRuntime(app, projectId, created.runtimeId);
    // Advance the workspace revision with a new file.
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path: 'extra.txt', content: 'v2' },
    });
    const stale = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runtimes/${created.runtimeId}`,
    });
    expect((stale.json() as RuntimeView).stale).toBe(true);
    const restart = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes/${created.runtimeId}/restart`,
      payload: {},
    });
    expect(restart.statusCode).toBe(200);
    const body = restart.json() as { previous: RuntimeView; next: RuntimeView };
    expect(body.previous.status).toBe('stopped');
    expect(body.next.status).toBe('running');
    expect(body.next.revision).toBe(body.next.currentRevision);
    expect(body.next.stale).toBe(false);
    expect(body.next.runtimeId).not.toBe(created.runtimeId);
  });

  it('rejects starting a stale runtime with 409 and a typed code', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId);
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      payload: { path: 'extra.txt', content: 'v2' },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes/${created.runtimeId}/start`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('RUNTIME_REVISION_MISMATCH');
  });
});

describe('runtime API: preview route', () => {
  it('serves the simulated preview page with sandboxing headers', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId);
    await startRuntime(app, projectId, created.runtimeId);
    const response = await app.inject({
      method: 'GET',
      url: `/preview/${created.runtimeId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toContain('SIMULATED');
    expect(response.body).toContain('Runtime Fixture');
    expect(response.body).not.toContain('<script>');
  });

  it('rejects the preview for a non-running runtime', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId);
    const response = await app.inject({
      method: 'GET',
      url: `/preview/${created.runtimeId}`,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('runtime API: security boundaries', () => {
  it('never accepts commands, ports, or env from the client', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    // Strict schema: command-shaped fields are rejected outright.
    const hostile = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runtimes`,
      payload: {
        workspaceId,
        startCommand: { executable: 'bash', arguments: ['-c', 'id'] },
      },
    });
    expect(hostile.statusCode).toBe(400);
    // And the detected plan carries ONLY what evidence supports.
    const view = await createRuntime(app, projectId, workspaceId);
    expect(view.plan.environment).toEqual({});
    expect(view.plan.startCommand.executable).toBe('npm');
  });

  it('lists runtimes scoped to the project only', async () => {
    const app = buildApp();
    const a = await seedWorkspace(app);
    const b = await seedWorkspace(app);
    await createRuntime(app, a.projectId, a.workspaceId);
    await createRuntime(app, b.projectId, b.workspaceId);
    const listA = await app.inject({
      method: 'GET',
      url: `/api/projects/${a.projectId}/runtimes`,
    });
    const body = listA.json() as { runtimes: RuntimeView[] };
    expect(body.runtimes.length).toBe(1);
    expect(body.runtimes[0]?.projectId).toBe(a.projectId);
  });

  it('returns typed 404s for unknown runtimes', async () => {
    const app = buildApp();
    const { projectId } = await seedWorkspace(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runtimes/rt_missing`,
    });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('RUNTIME_NOT_FOUND');
  });

  it('health reports a bounded probe, not a polling endpoint', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedWorkspace(app);
    const created = await createRuntime(app, projectId, workspaceId);
    await startRuntime(app, projectId, created.runtimeId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runtimes/${created.runtimeId}/health`,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe('healthy');
  });
});
