import { describe, expect, it } from 'vitest';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { buildApp } from '../server.js';

const NOW = () => new Date('2026-09-13T15:30:00.000Z');

function buildProjectApp() {
  const engine = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  return { app: buildApp({ projectEngine: engine }), engine };
}

const CREATE_BODY = {
  name: 'MarketScope Mobile',
  description: 'AI trading companion app',
  projectType: 'mobile',
  ownerRef: 'user-1',
};

async function createProject(
  app: ReturnType<typeof buildApp>,
): Promise<{ id: string; revision: number }> {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: CREATE_BODY });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function createWorkspace(
  app: ReturnType<typeof buildApp>,
  projectId: string,
): Promise<{ id: string; revision: number }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    payload: { name: 'main' },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe('Project API', () => {
  it('assigns a development owner server-side when the client omits ownerRef', async () => {
    const { app } = buildProjectApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Frontend-created project',
        description: 'Created without a frontend-owned identity',
        projectType: 'web',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { ownerRef: string };
    expect(body.ownerRef).toBe('veltravia-dev-user');
  });

  it('creates, lists, and retrieves projects', async () => {
    const { app } = buildProjectApp();
    const project = await createProject(app);
    expect(project.status).toBe('active');
    expect(project.revision).toBe(1);

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.statusCode).toBe(200);
    expect(list.json().projects).toHaveLength(1);

    const one = await app.inject({ method: 'GET', url: `/api/projects/${project.id}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().id).toBe(project.id);
  });

  it('patches a project with the correct revision', async () => {
    const { app } = buildProjectApp();
    const project = await createProject(app);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { description: 'updated', expectedRevision: project.revision },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().revision).toBe(2);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { description: 'stale', expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('REVISION_CONFLICT');
  });

  it('archives and restores projects', async () => {
    const { app } = buildProjectApp();
    const project = await createProject(app);
    const archived = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/archive`,
    });
    expect(archived.json().status).toBe('archived');
    const restored = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/restore`,
    });
    expect(restored.json().status).toBe('active');
  });

  it('rejects malformed input with 400s', async () => {
    const { app } = buildProjectApp();
    const missing = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(400);

    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...CREATE_BODY, projectType: 'quantum' },
    });
    expect(wrongType.statusCode).toBe(400);

    const unknownExtra = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...CREATE_BODY, surprise: true },
    });
    expect(unknownExtra.statusCode).toBe(400);
  });

  it('returns 404 for unknown resources', async () => {
    const { app } = buildProjectApp();
    const project = await app.inject({ method: 'GET', url: '/api/projects/prj-404' });
    expect(project.statusCode).toBe(404);
    expect(project.json().error.code).toBe('PROJECT_NOT_FOUND');

    const workspace = await app.inject({ method: 'GET', url: '/api/workspaces/ws-404' });
    expect(workspace.statusCode).toBe(404);
  });

  it('rejects secret-like metadata with a scrubbed 400', async () => {
    const { app } = buildProjectApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...CREATE_BODY, metadata: { githubToken: 'ghp_' + 'a'.repeat(30) } },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('SECRET_REJECTED');
    expect(JSON.stringify(body)).not.toContain('ghp_');
  });
});

describe('Workspace + File API', () => {
  it('creates workspaces under a project and reads the tree', async () => {
    const { app } = buildProjectApp();
    const project = await createProject(app);
    const workspace = await createWorkspace(app, project.id);

    const list = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/workspaces` });
    expect(list.json().workspaces).toHaveLength(1);

    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/directories`,
      payload: { path: 'src' },
    });
    const file = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/files`,
      payload: { path: 'src/App.tsx', content: 'export {}' },
    });
    expect(file.statusCode).toBe(201);

    const tree = await app.inject({ method: 'GET', url: `/api/workspaces/${workspace.id}/tree` });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().nodes.map((node: { path: string }) => node.path)).toEqual([
      'src',
      'src/App.tsx',
    ]);

    const read = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspace.id}/files/src/App.tsx`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().content).toBe('export {}');
  });

  it('rejects path traversal through the API with 400s', async () => {
    const { app } = buildProjectApp();
    const project = await createProject(app);
    const workspace = await createWorkspace(app, project.id);

    const traversal = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/files`,
      payload: { path: '../../etc/passwd' },
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error.code).toBe('PATH_INVALID');

    const absolute = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspace.id}/files/${encodeURIComponent('/etc/passwd')}`,
    });
    expect(absolute.statusCode).toBe(400);

    const windows = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/directories`,
      payload: { path: 'C:\\Windows\\System32' },
    });
    expect(windows.statusCode).toBe(400);
  });

  it('enforces revision conflicts on file updates', async () => {
    const { app } = buildProjectApp();
    const project = await createProject(app);
    const workspace = await createWorkspace(app, project.id);
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/files`,
      payload: { path: 'README.md', content: 'v1' },
    });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspace.id}/files/README.md`,
      payload: { content: 'v2', expectedRevision: 99 },
    });
    expect(stale.statusCode).toBe(409);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspace.id}/files/README.md`,
      payload: { content: 'v2', expectedRevision: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().revision).toBe(2);
  });

  it('rejects duplicate paths and forbidden operations', async () => {
    const { app } = buildProjectApp();
    const project = await createProject(app);
    const workspace = await createWorkspace(app, project.id);
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/files`,
      payload: { path: 'App.tsx', content: '' },
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/files`,
      payload: { path: 'App.tsx', content: '' },
    });
    expect(duplicate.statusCode).toBe(409);

    // Mutations against an archived workspace are forbidden (409)
    await app.inject({ method: 'POST', url: `/api/projects/${project.id}/archive` });
    const archived = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/files`,
      payload: { path: 'new.txt', content: '' },
    });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.code).toBe('WORKSPACE_NOT_ACTIVE');
  });

  it('moves, renames, and deletes through the API', async () => {
    const { app } = buildProjectApp();
    const project = await createProject(app);
    const workspace = await createWorkspace(app, project.id);
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/directories`,
      payload: { path: 'src' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/files`,
      payload: { path: 'App.tsx', content: 'x' },
    });

    const moved = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/nodes/move`,
      payload: { fromPath: 'App.tsx', toDirectory: 'src' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().path).toBe('src/App.tsx');

    const renamed = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/nodes/rename`,
      payload: { path: 'src/App.tsx', newName: 'index.tsx' },
    });
    expect(renamed.json().path).toBe('src/index.tsx');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspace.id}/files/src/index.tsx`,
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspace.id}/files/src/index.tsx`,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('returns 400 for unknown workspaces on file ops (workspace must exist first)', async () => {
    const { app } = buildProjectApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-404/files',
      payload: { path: 'x.txt', content: '' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('WORKSPACE_NOT_FOUND');
  });
});
