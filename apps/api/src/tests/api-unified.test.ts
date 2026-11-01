import { describe, expect, it } from 'vitest';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { buildApp } from '../server.js';

const NOW = () => new Date('2026-11-01T10:00:00.000Z');

interface UnifiedApp {
  readonly app: ReturnType<typeof buildApp>;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly ownerRef: string;
}

async function seedProject(options?: {
  ownerRef?: string;
  withDatabase?: boolean;
}): Promise<UnifiedApp> {
  const ownerRef = options?.ownerRef ?? 'unified-owner';
  const projectEngine = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const project = await projectEngine.projects.createProject({
    name: 'unified-project',
    description: 'one project, both layers',
    projectType: 'fullstack',
    ownerRef,
  });
  const workspace = await projectEngine.workspaces.createWorkspace(project.id, {
    name: 'main',
    branch: 'main',
  });

  const files = projectEngine.files;
  const write = async (path: string, content: string): Promise<void> => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      try {
        await files.createDirectory(workspace.id, parts.slice(0, index).join('/'));
      } catch {
        // Already present.
      }
    }
    await files.createFile(workspace.id, { path, content });
  };

  await write(
    'package.json',
    JSON.stringify({
      name: 'unified-app',
      dependencies: { react: '^19.0.0', fastify: '^5.0.0', '@prisma/client': '^5.0.0' },
    }),
  );
  await write(
    'src/routes/users.ts',
    [
      'export function register(app) {',
      "  app.get('/api/users', listUsers);",
      "  app.post('/api/users', createUser);",
      '}',
      'async function listUsers() { return prisma.user.findMany(); }',
      'async function createUser() { return prisma.user.create({}); }',
    ].join('\n'),
  );
  if (options?.withDatabase !== false) {
    await write(
      'prisma/schema.prisma',
      ['model User {', '  id    String @id', '  email String @unique', '}'].join('\n'),
    );
  }
  await write(
    'src/components/UserList.tsx',
    [
      'export function UserList() {',
      "  fetch('/api/users');",
      "  fetch('/api/users', { method: 'POST', body: '{}' });",
      "  fetch('/api/invoices');",
      '}',
    ].join('\n'),
  );
  await write('src/components/UserList.test.tsx', 'export const nothing = 1;\n');
  await write('.env.example', 'DATABASE_URL=postgres://app:supersecret@db:5432/app\n');

  const app = buildApp({ projectEngine });
  return { app, projectId: project.id, workspaceId: workspace.id, ownerRef };
}

interface HealthPayload {
  readonly [key: string]: { readonly status: string };
}

interface UnifiedPayload {
  readonly project: { readonly id: string; readonly name: string };
  readonly workspace: { readonly id: string } | null;
  readonly overview: { readonly counts: Record<string, number> };
  readonly health: HealthPayload;
  readonly files: {
    readonly groups: readonly { readonly group: string; readonly count: number }[];
  };
  readonly links: {
    readonly links: readonly {
      readonly kind: string;
      readonly to: { readonly label: string };
    }[];
    readonly unmatchedRequests: readonly { readonly url: string; readonly reason: string }[];
  };
}

function headers(ownerRef: string) {
  return { 'x-veltravia-owner-ref': ownerRef };
}

describe('GET /api/projects/:projectId/app', () => {
  it('composes overview, health, files and links from the project files', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/app?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as UnifiedPayload;

    expect(body.project).toMatchObject({ id: projectId, name: 'unified-project' });
    expect(body.workspace.id).toBe(workspaceId);
    expect(body.overview.counts.apiRoutes).toBe(2);
    expect(body.overview.counts.models).toBe(1);
    expect(body.overview.counts.files).toBeGreaterThanOrEqual(5);

    // Frontend requests: two users calls match, the invoices call does not.
    const requests = body.links.links.filter((link) => link.kind === 'frontend-request');
    expect(requests).toHaveLength(2);
    expect(body.links.unmatchedRequests).toEqual([
      expect.objectContaining({ url: '/api/invoices', reason: 'no-matching-route' }),
    ]);

    // A model edge exists because the route file names the model.
    expect(
      body.links.links.some((link) => link.kind === 'handler-model' && link.to.label === 'User'),
    ).toBe(true);

    // Grouping uses the real paths, and test files are separated.
    const groups = Object.fromEntries(body.files.groups.map((group) => [group.group, group.count]));
    expect(groups.frontend).toBeGreaterThanOrEqual(1);
    expect(groups.backend).toBeGreaterThanOrEqual(2);
    expect(groups.tests).toBe(1);
    app.close();
  });

  it('reports health with the documented vocabulary only', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/app/health?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    const { health } = response.json() as { health: HealthPayload };
    const allowed = [
      'configured',
      'detected',
      'tested',
      'running',
      'unavailable',
      'not-configured',
    ];
    for (const key of ['frontend', 'backend', 'apiRoutes', 'database', 'tests', 'runtime']) {
      expect(allowed).toContain(health[key].status);
    }
    expect(health.database.status).toBe('configured');
    expect(health.runtime.status).toBe('unavailable');
    expect(health.tests.status).toBe('detected');
    app.close();
  });

  it('does not claim models when the project has no schema', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject({ withDatabase: false });
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/app?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    const body = response.json() as UnifiedPayload;
    // The client library is declared in package.json, which is what "configured"
    // means here. No model exists, and the counts say so.
    expect(body.overview.counts.models).toBe(0);
    expect(body.health.database.detail).toMatch(/0 model/i);
    app.close();
  });

  it('keeps a foreign owner out of the whole workspace', async () => {
    const { app, projectId, workspaceId } = await seedProject({ ownerRef: 'owner-a' });
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/app?workspaceId=${workspaceId}`,
      headers: headers('owner-b'),
    });
    expect(response.statusCode).toBe(404);
    app.close();
  });

  it('returns 404 for an unknown project', async () => {
    const { app, ownerRef } = await seedProject();
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects/prj_missing/app',
      headers: headers(ownerRef),
    });
    expect(response.statusCode).toBe(404);
    app.close();
  });

  it('exposes names and paths but never a secret value', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/app?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    const text = response.body;
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('postgres://app');
    app.close();
  });

  it('offers no write surface: the unified routes are read-only', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    for (const [method, url] of [
      ['POST', `/api/projects/${projectId}/app`],
      ['PUT', `/api/projects/${projectId}/app/files`],
      ['DELETE', `/api/projects/${projectId}/app/links`],
    ] as const) {
      const response = await app.inject({ method, url, headers: headers(ownerRef) });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(workspaceId).toBeTruthy();
    app.close();
  });
});

describe('POST /api/projects/:projectId/app/group', () => {
  it('classifies the paths a change set would touch', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/app/group?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
      payload: {
        paths: [
          'src/components/New.tsx',
          'src/routes/invoices.ts',
          'package.json',
          'src/broken.ts',
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { groups: Record<string, string>; backendSource: number };
    expect(body.groups).toMatchObject({
      'src/components/New.tsx': 'frontend',
      'src/routes/invoices.ts': 'backend',
      'package.json': 'configuration',
    });
    expect(body.backendSource).toBeGreaterThanOrEqual(1);
    app.close();
  });

  it('rejects a malformed payload and a foreign project', async () => {
    const { app, projectId, ownerRef } = await seedProject({ ownerRef: 'owner-a' });
    const bad = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/app/group`,
      headers: headers(ownerRef),
      payload: { paths: 'nope' },
    });
    expect(bad.statusCode).toBe(400);

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/app/group`,
      headers: headers('owner-b'),
      payload: { paths: ['src/app/page.tsx'] },
    });
    expect(foreign.statusCode).toBe(404);
    app.close();
  });
});

describe('GET /api/app-builder/unified', () => {
  it('states what is implemented and what is not', async () => {
    const { app } = await seedProject();
    const response = await app.inject({ method: 'GET', url: '/api/app-builder/unified' });
    const body = response.json() as UnifiedPayload;
    expect(body.readOnly).toBe(true);
    expect(body.composition).toMatchObject({ duplicateStores: false, secondAiSystem: false });
    expect(body.unavailable).toContain('deployment');
    expect(body.writes).toBe('coding-agent-run-with-human-approval');
    app.close();
  });
});
