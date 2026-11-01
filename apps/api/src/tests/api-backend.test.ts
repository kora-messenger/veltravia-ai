import { describe, expect, it } from 'vitest';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { buildApp } from '../server.js';

const NOW = () => new Date('2026-11-01T08:00:00.000Z');

interface BackendApp {
  readonly app: ReturnType<typeof buildApp>;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly ownerRef: string;
}

async function seedProject(options?: { ownerRef?: string }): Promise<BackendApp> {
  const ownerRef = options?.ownerRef ?? 'api-test-owner';
  const projectEngine = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const project = await projectEngine.projects.createProject({
    name: 'backend-project',
    description: 'project used by the backend builder API tests',
    projectType: 'backend',
    ownerRef,
  });
  const workspace = await projectEngine.workspaces.createWorkspace(project.id, {
    name: 'main',
    branch: 'main',
  });

  const files = projectEngine.files;
  const write = async (path: string, content: string) => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      try {
        await files.createDirectory(workspace.id, directory);
      } catch {
        // Directory already exists - the engine is idempotent-enough here.
      }
    }
    await files.createFile(workspace.id, { path, content });
  };

  await write(
    'package.json',
    JSON.stringify({
      name: 'seeded-service',
      dependencies: { fastify: '^5.0.0', '@prisma/client': '^5.0.0', jsonwebtoken: '^9.0.0' },
    }),
  );
  await write(
    'src/routes/users.ts',
    [
      "import type { FastifyInstance } from 'fastify';",
      'export function registerUserRoutes(app: FastifyInstance) {',
      "  app.get('/api/users', { preHandler: requireAuth }, listUsers);",
      "  app.post('/api/users', createUser);",
      '}',
    ].join('\n'),
  );
  await write(
    'prisma/schema.prisma',
    ['model User {', '  id    String @id', '  email String @unique', '  name  String?', '}'].join(
      '\n',
    ),
  );
  await write(
    'src/config/env.ts',
    [
      'export const databaseUrl = process.env.DATABASE_URL;',
      'export const port = process.env.PORT;',
    ].join('\n'),
  );
  await write(
    '.env.example',
    'DATABASE_URL=postgres://app:supersecret@db:5432/app\nJWT_SECRET=abc123secret\n',
  );
  await write(
    'netlify/functions/send-receipt.ts',
    'export const handler = async () => ({ statusCode: 200 });',
  );

  const app = buildApp({ projectEngine });
  return { app, projectId: project.id, workspaceId: workspace.id, ownerRef };
}

function headers(ownerRef: string) {
  return { 'x-veltravia-owner-ref': ownerRef };
}

describe('GET /api/projects/:projectId/backend', () => {
  it('describes the backend from the project files', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect(response.statusCode).toBe(200);
    const { report } = response.json() as { report: Record<string, unknown> };

    expect((report.routes as unknown[]).length).toBe(2);
    expect(report.models).toEqual([expect.objectContaining({ name: 'User', source: 'prisma' })]);
    expect(report.auth).toMatchObject({
      status: 'declared',
      provider: 'JSON Web Tokens (jsonwebtoken)',
      protectedRoutes: 1,
      userModel: 'User',
    });
    expect(report.database).toMatchObject({
      status: 'declared',
      provider: 'Prisma',
      connection: 'not-configured',
    });
    expect(report.logs).toMatchObject({ available: false, entries: [] });
    expect(report.scanned).toMatchObject({ files: expect.any(Number) });
    expect(report.functions).toEqual([expect.objectContaining({ name: 'send-receipt' })]);
    app.close();
  });

  it('returns environment variable names and never a value', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend/environment?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { environment: { name: string }[]; values: string };
    expect(body.environment.map((entry) => entry.name)).toEqual([
      'DATABASE_URL',
      'JWT_SECRET',
      'PORT',
    ]);
    expect(body.values).toBe('never-read');
    expect(response.body).not.toMatch(/supersecret|abc123secret/);
    app.close();
  });

  it('serves each section through its own endpoint without extra fields', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    const routes = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend/routes?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect(routes.statusCode).toBe(200);
    expect((routes.json() as { routes: unknown[] }).routes).toHaveLength(2);

    const models = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend/models?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect((models.json() as { models: unknown[] }).models).toHaveLength(1);

    const logs = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend/logs?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect((logs.json() as { logs: { available: boolean } }).logs.available).toBe(false);

    const auth = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend/auth?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect((auth.json() as { auth: { provider: string } }).auth.provider).toBe(
      'JSON Web Tokens (jsonwebtoken)',
    );

    const database = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend/database?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect((database.json() as { database: { connection: string } }).database.connection).toBe(
      'not-configured',
    );

    const functions = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend/functions?workspaceId=${workspaceId}`,
      headers: headers(ownerRef),
    });
    expect((functions.json() as { functions: unknown[] }).functions).toHaveLength(1);
    app.close();
  });

  it('states its capabilities instead of implying more', async () => {
    const { app } = await seedProject();
    const response = await app.inject({ method: 'GET', url: '/api/backend/capabilities' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      readOnly: boolean;
      sections: Record<string, string>;
      unavailable: string[];
    };
    expect(body.readOnly).toBe(true);
    expect(body.sections.logs).toBe('unavailable');
    expect(body.sections.database).toBe('inspection-only');
    expect(body.unavailable).toContain('database connections');
    app.close();
  });

  it('refuses a project that belongs to someone else, exactly like a missing one', async () => {
    const { app, projectId, workspaceId } = await seedProject();
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend?workspaceId=${workspaceId}`,
      headers: headers('someone-else'),
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/projects/prj-does-not-exist/backend',
      headers: headers('someone-else'),
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.body).toBe(missing.body);
    app.close();
  });

  it('rejects an unknown workspace rather than scanning another one', async () => {
    const { app, projectId, ownerRef } = await seedProject();
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/backend?workspaceId=ws-not-real`,
      headers: headers(ownerRef),
    });
    expect([400, 404]).toContain(response.statusCode);
    app.close();
  });

  it('handles an empty project with honest empty states', async () => {
    const projectEngine = createProjectEngine({
      now: NOW,
      generateProjectId: createSequentialIdGenerator('prj'),
      generateWorkspaceId: createSequentialIdGenerator('ws'),
      generateNodeId: createSequentialIdGenerator('node'),
    });
    const project = await projectEngine.projects.createProject({
      name: 'empty-project',
      description: 'no files at all',
      projectType: 'backend',
      ownerRef: 'api-test-owner',
    });
    const workspace = await projectEngine.workspaces.createWorkspace(project.id, {
      name: 'main',
      branch: 'main',
    });
    const app = buildApp({ projectEngine });
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/backend?workspaceId=${workspace.id}`,
      headers: headers('api-test-owner'),
    });
    expect(response.statusCode).toBe(200);
    const { report } = response.json() as {
      report: {
        routes: unknown[];
        models: unknown[];
        auth: { status: string };
        warnings: string[];
      };
    };
    expect(report.routes).toEqual([]);
    expect(report.models).toEqual([]);
    expect(report.auth.status).toBe('absent');
    expect(report.warnings.length).toBeGreaterThan(0);
    app.close();
  });

  it('does not offer a write, execution or connection endpoint', async () => {
    const { app, projectId, workspaceId, ownerRef } = await seedProject();
    for (const [method, suffix] of [
      ['POST', ''],
      ['POST', '/routes'],
      ['POST', '/execute'],
      ['POST', '/query'],
      ['DELETE', '/models'],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/projects/${projectId}/backend${suffix}?workspaceId=${workspaceId}`,
        headers: headers(ownerRef),
        payload: {},
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    app.close();
  });
});
