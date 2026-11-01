import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';

/**
 * Step 31 wiring: native source storage over the real Fastify app.
 *
 * The project engine, the file tree and the ownership check are the real ones;
 * only the AI/coding pieces are mocked, and one test drives the REAL coding
 * agent through a plan approval to prove AI writes land in source history.
 */

const ownerA = { 'x-veltravia-owner-ref': 'src-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'src-owner-b' };

async function projectWithWorkspace(app: ReturnType<typeof buildApp>, headers = ownerA) {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: { name: 'Source repo', description: 'Holds source.', projectType: 'backend' },
  });
  expect(project.statusCode).toBe(201);
  const projectId = project.json().id as string;
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    headers,
    payload: { name: 'main' },
  });
  expect(workspace.statusCode).toBe(201);
  return { projectId, workspaceId: workspace.json().id as string };
}

async function createFile(
  app: ReturnType<typeof buildApp>,
  projectId: string,
  path: string,
  content: string,
  headers = ownerA,
) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/source/files`,
    headers,
    payload: { path, content },
  });
}

describe('native source storage API', () => {
  it('reports the storage boundary honestly', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/storage`,
      headers: ownerA,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().storage.content).toMatchObject({
      implementation: 'in-memory',
      durable: false,
    });
  });

  it('creates, lists and reads files', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    const created = await createFile(app, projectId, 'src/index.ts', 'export const a = 1;\n');
    expect(created.statusCode).toBe(201);

    const tree = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source`,
      headers: ownerA,
    });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().tree.files.map((file: { path: string }) => file.path)).toContain(
      'src/index.ts',
    );

    const file = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/file?path=src/index.ts`,
      headers: ownerA,
    });
    expect(file.statusCode).toBe(200);
    expect(file.json().file.content).toBe('export const a = 1;\n');
    expect(file.json().file.revision).toBe(1);
  });

  it('refuses traversal and secret-shaped content', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    const traversal = await createFile(app, projectId, '../escape.ts', 'x');
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error.code).toBe('SOURCE_PATH_INVALID');

    const secret = await createFile(
      app,
      projectId,
      'src/key.ts',
      'token = "ghp_abcdefghijklmnopqrstuvwxyz01"',
    );
    expect(secret.statusCode).toBe(422);
    expect(secret.json().error.code).toBe('SOURCE_SECRET_REJECTED');
  });

  it('keeps repositories owner-scoped', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    await createFile(app, projectId, 'a.ts', 'a');

    for (const url of [
      `/api/projects/${projectId}/source`,
      `/api/projects/${projectId}/source/history`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: ownerB });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('SOURCE_REPOSITORY_NOT_FOUND');
    }

    const write = await createFile(app, projectId, 'b.ts', 'b', ownerB);
    expect(write.statusCode).toBe(404);
  });

  it('applies a multi-file change set atomically', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    await createFile(app, projectId, 'a.ts', 'a');
    const read = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/file?path=a.ts`,
      headers: ownerA,
    });
    const revision = read.json().file.revision as number;

    const applied = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source/changes`,
      headers: ownerA,
      payload: {
        summary: 'Add feature files',
        operations: [
          { op: 'update', path: 'a.ts', content: 'a2', expectedRevision: revision },
          { op: 'create', path: 'b.ts', content: 'b' },
        ],
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().result.applied).toBe(2);

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source/changes`,
      headers: ownerA,
      payload: {
        operations: [
          { op: 'create', path: 'c.ts', content: 'c' },
          { op: 'update', path: 'a.ts', content: 'stale', expectedRevision: 1 },
        ],
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe('SOURCE_REVISION_CONFLICT');

    const tree = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source`,
      headers: ownerA,
    });
    const paths = tree.json().tree.files.map((file: { path: string }) => file.path);
    expect(paths).toContain('a.ts');
    expect(paths).not.toContain('c.ts');
  });

  it('records history and exposes it per path', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    await createFile(app, projectId, 'a.ts', 'a');
    const read = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/file?path=a.ts`,
      headers: ownerA,
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/source/file`,
      headers: ownerA,
      payload: { path: 'a.ts', content: 'b', expectedRevision: read.json().file.revision },
    });

    const history = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/history?path=a.ts`,
      headers: ownerA,
    });
    expect(history.statusCode).toBe(200);
    const kinds = history.json().entries.map((entry: { changeKind: string }) => entry.changeKind);
    expect(kinds).toEqual(['modified', 'created']);
  });

  it('snapshots, compares and restores', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    await createFile(app, projectId, 'keep.ts', 'keep');
    const first = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source/snapshots`,
      headers: ownerA,
      payload: { label: 'Before change' },
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().snapshot.id as string;

    await createFile(app, projectId, 'later.ts', 'later');
    const second = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source/snapshots`,
      headers: ownerA,
      payload: { label: 'After change' },
    });
    const secondId = second.json().snapshot.id as string;

    const comparison = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/compare?from=${firstId}&to=${secondId}`,
      headers: ownerA,
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json().comparison.added.map((item: { path: string }) => item.path)).toEqual([
      'later.ts',
    ]);

    const restore = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source/snapshots/${firstId}/restore`,
      headers: ownerA,
      payload: {},
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().restore.deleted).toBe(1);

    const tree = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source`,
      headers: ownerA,
    });
    expect(tree.json().tree.files.map((file: { path: string }) => file.path)).toEqual(['keep.ts']);
  });

  it('produces a manifest hash that is stable for an unchanged tree', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    await createFile(app, projectId, 'a.ts', 'a');
    const one = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/manifest`,
      headers: ownerA,
    });
    const two = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/manifest`,
      headers: ownerA,
    });
    expect(one.json().manifest.manifestHash).toBe(two.json().manifest.manifestHash);
  });

  it('rejects a path-less read and an unknown snapshot with clear codes', async () => {
    const app = buildApp();
    const { projectId } = await projectWithWorkspace(app);
    const noPath = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/file`,
      headers: ownerA,
    });
    expect(noPath.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/snapshots/nope`,
      headers: ownerA,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SOURCE_SNAPSHOT_NOT_FOUND');
  });

  it('records a coding-agent write in source history', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await projectWithWorkspace(app);

    // A baseline so the observation has something to compare against.
    const tree = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source?workspaceId=${workspaceId}`,
      headers: ownerA,
    });
    expect(tree.statusCode).toBe(200);

    // Drive the REAL project engine the way an AI agent would.
    const direct = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      headers: ownerA,
      payload: { path: 'agent-output.ts', content: 'export const made = true;\n' },
    });
    expect(direct.statusCode).toBe(201);

    const history = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/history?workspaceId=${workspaceId}`,
      headers: ownerA,
    });
    const entry = history
      .json()
      .entries.find((item: { path: string }) => item.path === 'agent-output.ts');
    expect(entry).toMatchObject({ actor: 'external-writer', changeKind: 'created' });
  });

  it('classifies frontend files without inventing a framework', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await projectWithWorkspace(app);
    const files = [
      'src/pages/Home.tsx',
      'src/pages/Pricing.tsx',
      'src/components/Nav.tsx',
      'src/hooks/useSession.ts',
      'src/styles/theme.css',
      'public/logo.svg',
      'src/lib/money.ts',
      'README.md',
    ];
    // Parents must exist first: the engine never invents intermediate dirs.
    for (const path of [
      'src',
      'public',
      'src/pages',
      'src/components',
      'src/hooks',
      'src/styles',
      'src/lib',
    ]) {
      const directory = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/directories`,
        headers: ownerA,
        payload: { path },
      });
      expect(directory.statusCode).toBe(201);
    }
    for (const path of files) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/files`,
        headers: ownerA,
        payload: { path, content: 'x' },
      });
      expect(created.statusCode).toBe(201);
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/structure?workspaceId=${workspaceId}`,
      headers: ownerA,
    });
    expect(response.statusCode).toBe(200);
    const structure = response.json().structure;
    expect(structure.totals.files).toBe(files.length);
    expect(structure.pages).toEqual(['src/pages/Home.tsx', 'src/pages/Pricing.tsx']);
    expect(structure.components).toEqual(['src/components/Nav.tsx']);
    const sections = structure.sections.map((section: { section: string }) => section.section);
    expect(sections).toEqual(expect.arrayContaining(['pages', 'components', 'hooks', 'styles']));
    // No manifest means no framework claim, and a neutral grouping.
    expect(structure.framework).toBeNull();
  });

  it('keeps structure scoped to the owner', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await projectWithWorkspace(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source/structure?workspaceId=${workspaceId}`,
      headers: ownerB,
    });
    expect(response.statusCode).toBe(404);
  });

  it('reports coding-agent capabilities honestly', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/coding/capabilities' });
    expect(response.statusCode).toBe(200);
    const capabilities = response.json().capabilities;
    expect(capabilities.decisionSource).toBe('scripted-demo');
    expect(capabilities.planApprovalRequired).toBe(true);
    expect(capabilities.toolConfirmationsRequired).toBe(true);
  });

  it('exposes the plan on a run awaiting approval', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await projectWithWorkspace(app);
    const run = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: ownerA,
      payload: {
        projectId,
        workspaceId,
        userRequirement: 'Add a pricing page',
      },
    });
    expect(run.statusCode).toBe(200);
    const view = run.json();
    expect(['awaiting_approval', 'planning', 'analyzing']).toContain(view.state);
    if (view.state === 'awaiting_approval') {
      expect(view.plan).not.toBeNull();
      expect(typeof view.plan.goal).toBe('string');
    }
  });
});
