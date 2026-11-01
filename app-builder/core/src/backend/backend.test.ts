import { describe, expect, it } from 'vitest';

import {
  extractEnvironment,
  extractFunctions,
  extractManifest,
  extractModels,
  extractRoutes,
} from './extract.js';
import { redactSensitiveText } from './redact.js';
import { analyseBackend } from './report.js';
import { classifyBackendPath, classifyBackendStructure } from './structure.js';

describe('backend route extraction', () => {
  it('reads express and fastify declarations with method, path and line', () => {
    const content = [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', healthCheck);",
      "app.post('/api/users', createUser);",
      "router.delete('/api/users/:id', removeUser);",
      "app.patch('/api/users/:id', updateUser);",
    ].join('\n');

    const routes = extractRoutes({ path: 'src/routes/users.ts', content });
    expect(routes).toHaveLength(4);
    expect(routes[0]).toMatchObject({
      method: 'GET',
      path: '/health',
      handler: 'healthCheck',
      file: 'src/routes/users.ts',
      line: 3,
      source: 'express-fastify',
      auth: 'unknown',
    });
    expect(routes.map((route) => route.method)).toEqual(['GET', 'POST', 'DELETE', 'PATCH']);
  });

  it('never reports a keyword as a handler name', () => {
    const content = [
      "app.post('/api/orders', async (request, reply) => {",
      '  return reply.code(201).send({ ok: true });',
      '});',
      "app.get('/api/health', async () => ({ status: 'ok' }));",
      "app.get('/api/ready', handler);",
    ].join('\n');
    const routes = extractRoutes({ path: 'src/routes/orders.ts', content });
    expect(routes.map((route) => route.handler)).toEqual([null, null, 'handler']);
  });

  it('names a handler that sits behind an options object', () => {
    const content = [
      "app.get('/api/orders', { preHandler: requireAuth }, listOrders);",
      "app.post('/api/orders', { schema: bodySchema }, createOrder);",
    ].join('\n');
    const routes = extractRoutes({ path: 'src/routes/orders.ts', content });
    expect(routes.map((route) => route.handler)).toEqual(['listOrders', 'createOrder']);
    expect(routes.map((route) => route.auth)).toEqual(['declared', 'unknown']);
  });

  it('reads a fastify route object', () => {
    const content = `
      await fastify.route({
        method: 'PUT',
        url: '/api/orders/:id',
        handler: updateOrder,
      });
    `;
    const routes = extractRoutes({ path: 'src/routes/orders.ts', content });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'PUT',
      path: '/api/orders/:id',
      source: 'fastify-route-object',
    });
  });

  it('marks a route as guarded only when its own file shows a guard', () => {
    const guarded = "app.get('/admin/keys', { preHandler: requireAuth }, listKeys);";
    const [route] = extractRoutes({ path: 'src/routes/admin.ts', content: guarded });
    expect(route?.auth).toBe('declared');

    const unguarded = "app.get('/health', healthCheck);";
    const [plain] = extractRoutes({ path: 'src/routes/health.ts', content: unguarded });
    expect(plain?.auth).toBe('unknown');
  });

  it('derives Next.js app-router routes from the file path and exported verbs', () => {
    const content = [
      'export async function GET(request: Request) {}',
      'export async function POST() {}',
    ].join('\n');
    const routes = extractRoutes({ path: 'app/api/orders/[id]/route.ts', content });
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      method: 'GET',
      path: '/api/orders/:id',
      source: 'next-app-router',
    });
    expect(routes[1]?.method).toBe('POST');
  });

  it('derives Next.js pages-api routes and their declared methods', () => {
    const content = `
      export default async function handler(req, res) {
        if (req.method === 'POST') return res.status(200).json({});
        return res.status(405).end();
      }
    `;
    const routes = extractRoutes({ path: 'pages/api/session.ts', content });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'POST',
      path: '/api/session',
      source: 'next-pages-api',
    });
  });

  it('reads Python decorators and says so when a urlconf declares no method', () => {
    const fastapi = ["@app.get('/health')", 'def health():', '    return {"ok": True}'].join('\n');
    const [route] = extractRoutes({ path: 'app/main.py', content: fastapi });
    expect(route).toMatchObject({ method: 'GET', path: '/health', source: 'python-decorator' });

    const urls = ["urlpatterns = [path('users/<int:id>/', views.detail)]"].join('\n');
    const [django] = extractRoutes({ path: 'app/urls.py', content: urls });
    expect(django?.source).toBe('django-urlconf');
    expect(django?.evidence).toMatch(/urlconf declares no method/);
  });

  it('reports a route declared for any method as GET and says so', () => {
    const [route] = extractRoutes({
      path: 'src/routes/all.ts',
      content: "app.all('/ping', ping);",
    });
    expect(route?.method).toBe('GET');
    expect(route?.evidence).toMatch(/any method/);
  });

  it('extracts nothing from a file with no declarations', () => {
    const routes = extractRoutes({
      path: 'src/services/maths.ts',
      content: 'export const add = (a, b) => a + b;',
    });
    expect(routes).toEqual([]);
  });
});

describe('backend model extraction', () => {
  it('parses a Prisma model into fields, keys and relationships', () => {
    const content = `
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  posts     Post[]
  profile   Profile?
}

model Post {
  id       String @id
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId String
}

model Profile {
  id     String @id
  user   User   @relation(fields: [userId], references: [id])
  userId String @unique
  @@unique([userId])
}
`;
    const models = extractModels({ path: 'prisma/schema.prisma', content });
    expect(models.map((model) => model.name)).toEqual(['User', 'Post', 'Profile']);

    const user = models[0];
    expect(user?.source).toBe('prisma');
    expect(user?.fields[0]).toMatchObject({
      name: 'id',
      type: 'String',
      primaryKey: true,
      required: true,
    });
    expect(user?.fields[1]).toMatchObject({ name: 'email', unique: true });
    expect(user?.fields[2]).toMatchObject({ name: 'name', required: false });
    expect(user?.relationships).toEqual([
      { field: 'posts', target: 'Post', cardinality: 'list', derivedFrom: 'prisma-relation' },
      {
        field: 'profile',
        target: 'Profile',
        cardinality: 'single',
        derivedFrom: 'prisma-relation',
      },
    ]);

    const profile = models[2];
    expect(profile?.indexes).toEqual(['userId']);
  });

  it('parses SQL tables, foreign keys and indexes', () => {
    const content = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  nickname TEXT
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL
);

CREATE INDEX posts_user_idx ON posts (user_id);
`;
    const models = extractModels({ path: 'db/schema.sql', content });
    expect(models.map((model) => model.name)).toEqual(['users', 'posts']);
    expect(models[0]?.fields[0]).toMatchObject({ name: 'id', primaryKey: true, required: true });
    expect(models[0]?.fields[2]).toMatchObject({ name: 'nickname', required: false });
    expect(models[1]?.relationships).toEqual([
      { field: 'user_id', target: 'users', cardinality: 'single', derivedFrom: 'sql-foreign-key' },
    ]);
    expect(models[1]?.indexes).toEqual(['posts_user_idx (user_id)']);
  });

  it('does not invent models from a file that declares none', () => {
    expect(
      extractModels({ path: 'src/types.ts', content: 'export interface User { id: string }' }),
    ).toEqual([]);
  });
});

describe('backend function extraction', () => {
  it('finds serverless entry points under a functions directory', () => {
    const functions = extractFunctions(
      {
        path: 'netlify/functions/send-receipt.ts',
        content: 'export const handler = async () => ({ statusCode: 200 });',
      },
      'node',
    );
    expect(functions).toHaveLength(1);
    expect(functions[0]).toMatchObject({
      name: 'send-receipt',
      kind: 'serverless-function',
      runtime: 'node',
      inputSchema: 'not-declared',
      outputSchema: 'not-declared',
    });
  });

  it('does not treat a Next.js route as a serverless function', () => {
    expect(
      extractFunctions(
        { path: 'pages/api/session.ts', content: 'export default function handler() {}' },
        null,
      ),
    ).toEqual([]);
  });
});

describe('backend environment extraction', () => {
  it('keeps variable names and drops values', () => {
    const content = [
      'DATABASE_URL=postgres://user:hunter2@db.internal:5432/app',
      'JWT_SECRET=super-secret-value',
      'PORT=3000',
    ].join('\n');
    const variables = extractEnvironment({ path: '.env.example', content });
    expect(variables.map((entry) => entry.name)).toEqual(['DATABASE_URL', 'JWT_SECRET', 'PORT']);
    expect(variables.every((entry) => entry.kind === 'template')).toBe(true);
    expect(JSON.stringify(variables)).not.toMatch(/hunter2|super-secret-value|3000/);
  });

  it('reads process.env, os.environ and Deno.env names only', () => {
    const content = [
      'const url = process.env.DATABASE_URL;',
      "const mode = process.env['NODE_ENV'];",
      "const port = os.environ.get('PORT_FLASK');",
      "const token = Deno.env.get('DENO_TOKEN');",
      'const other = import.meta.env.VITE_API_BASE;',
    ].join('\n');
    const names = extractEnvironment({ path: 'src/config/env.ts', content }).map(
      (entry) => entry.name,
    );
    expect(names).toEqual([
      'DATABASE_URL',
      'NODE_ENV',
      'PORT_FLASK',
      'DENO_TOKEN',
      'VITE_API_BASE',
    ]);
  });

  it('ignores lowercase lookalikes', () => {
    expect(extractEnvironment({ path: 'src/a.ts', content: 'process.env.myVariable' })).toEqual([]);
  });
});

describe('manifest reading', () => {
  it('reads dependency names from package.json and never versions', () => {
    const content = JSON.stringify({
      dependencies: { fastify: '^5.0.0', express: '^4.19.2' },
      devDependencies: { vitest: '^2.0.0' },
    });
    const manifest = extractManifest({ path: 'package.json', content });
    expect(manifest?.dependencies).toEqual(['express', 'fastify', 'vitest']);
  });

  it('reads requirements.txt names without pinned versions', () => {
    const manifest = extractManifest({
      path: 'requirements.txt',
      content: 'fastapi==0.115.0\nuvicorn\n# comment\n',
    });
    expect(manifest?.dependencies).toEqual(['fastapi', 'uvicorn']);
  });

  it('returns null for a file that is not a manifest', () => {
    expect(extractManifest({ path: 'src/index.ts', content: '' })).toBeNull();
  });
});

describe('redaction', () => {
  it('masks keys, bearer tokens, connection strings and password assignments', () => {
    const text =
      'key sk-abcdefghijklmnop1234 Bearer abcdefghijklmnop password=hunter2value postgres://u:p@host:5432/db';
    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain('sk-abcdefghijklmnop1234');
    expect(redacted).not.toContain('hunter2value');
    expect(redacted).not.toContain('u:p@host');
    expect(redacted).toContain('[redacted');
  });

  it('leaves ordinary engineering text alone', () => {
    expect(redactSensitiveText('GET /api/users returned 200 in 12ms')).toBe(
      'GET /api/users returned 200 in 12ms',
    );
  });
});

describe('backend structure classification', () => {
  it('classifies by directory and file name', () => {
    expect(classifyBackendPath('src/routes/users.ts')).toBe('routes');
    expect(classifyBackendPath('src/services/billing.ts')).toBe('services');
    expect(classifyBackendPath('src/models/user.ts')).toBe('models');
    expect(classifyBackendPath('src/middleware/auth.ts')).toBe('middleware');
    expect(classifyBackendPath('package.json')).toBe('config');
    expect(classifyBackendPath('docker-compose.yml')).toBe('config');
    expect(classifyBackendPath('db/schema.sql')).toBe('database');
    expect(classifyBackendPath('netlify/functions/send.ts')).toBe('functions');
    expect(classifyBackendPath('src/lib/hash.ts')).toBe('utilities');
  });

  it('reports a neutral layout when nothing identifies a stack', () => {
    const structure = classifyBackendStructure({
      framework: null,
      files: [{ path: 'src/routes/users.ts', size: 120 }],
    });
    expect(structure.layout).toBe('neutral');
    expect(structure.framework).toBeNull();
    expect(structure.sections.find((section) => section.section === 'routes')?.count).toBe(1);
  });
});

describe('backend report', () => {
  const files = [
    {
      path: 'package.json',
      size: 200,
      content: JSON.stringify({
        dependencies: { fastify: '^5.0.0', '@prisma/client': '^5.0.0', jsonwebtoken: '^9.0.0' },
      }),
    },
    {
      path: 'src/routes/users.ts',
      size: 180,
      content:
        "app.get('/api/users', { preHandler: requireAuth }, listUsers);\napp.post('/api/users', createUser);",
    },
    {
      path: 'prisma/schema.prisma',
      size: 90,
      content: 'model User {\n  id String @id\n  email String @unique\n}',
    },
    {
      path: 'src/config/env.ts',
      size: 60,
      content: 'export const url = process.env.DATABASE_URL;',
    },
  ];

  it('reports what the files say, with evidence', () => {
    const report = analyseBackend({
      files,
      framework: 'fastify',
      language: 'typescript',
      runtime: null,
    });
    expect(report.routes).toHaveLength(2);
    expect(report.models[0]?.name).toBe('User');
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
    expect(report.environment.map((entry) => entry.name)).toEqual(['DATABASE_URL']);
  });

  it('stays honest with no backend evidence at all', () => {
    const report = analyseBackend({
      files: [{ path: 'src/app.tsx', size: 20, content: 'export const App = () => null;' }],
      framework: null,
      language: null,
      runtime: null,
    });
    expect(report.routes).toEqual([]);
    expect(report.auth.status).toBe('absent');
    expect(report.auth.provider).toBeNull();
    expect(report.database.status).toBe('absent');
    expect(report.logs).toMatchObject({ available: false, entries: [] });
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('never returns a secret value even when a file contains one', () => {
    const report = analyseBackend({
      files: [
        {
          path: '.env.example',
          size: 40,
          content: 'API_KEY=sk-live-abcdefghijklmnop\n',
        },
        {
          path: 'src/routes/auth.ts',
          size: 90,
          content: "app.post('/api/login', login); // token sk-live-abcdefghijklmnop",
        },
      ],
      framework: null,
      language: null,
      runtime: null,
    });
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('sk-live-abcdefghijklmnop');
    expect(report.environment.map((entry) => entry.name)).toEqual(['API_KEY']);
  });

  it('says when a scan was capped instead of pretending it was complete', () => {
    const report = analyseBackend({
      files: [],
      framework: null,
      language: null,
      runtime: null,
      skippedFiles: 12,
      truncated: true,
    });
    expect(report.scanned).toMatchObject({ skipped: 12, truncated: true });
    expect(report.warnings.join(' ')).toMatch(/read limit/);
    expect(report.warnings.join(' ')).toMatch(/scan limit/);
  });
});
