import { describe, expect, it } from 'vitest';

import type { BackendModel, BackendReport, BackendRoute } from '../backend/index.js';
import type { FrontendStructure } from '../frontend/structure.js';

import { groupForPath, groupWorkspaceFiles } from './files.js';
import { buildAppHealth, type HealthInput } from './health.js';
import { detectCrossLayerLinks, extractRequestSites } from './links.js';
import { buildUnifiedOverview } from './overview.js';
import { UNIFIED_STATUSES, type StatusFact } from './types.js';

function route(overrides: Partial<BackendRoute> = {}): BackendRoute {
  return {
    method: 'GET',
    path: '/api/users',
    file: 'src/routes/users.ts',
    line: 4,
    handler: 'listUsers',
    auth: 'unknown',
    source: 'express-fastify',
    evidence: "app.get('/api/users', listUsers);",
    ...overrides,
  };
}

function model(name: string, file = 'prisma/schema.prisma'): BackendModel {
  return {
    name,
    source: 'prisma',
    file,
    line: 3,
    fields: [],
    indexes: [],
    relationships: [],
  };
}

function report(overrides: Partial<BackendReport> = {}): BackendReport {
  return {
    structure: {
      layout: 'node',
      framework: 'fastify',
      language: 'typescript',
      runtime: 'node',
      totals: { files: 3, bytes: 900 },
      sections: [],
    },
    routes: [route()],
    models: [],
    functions: [],
    environment: [],
    auth: {
      status: 'declared',
      provider: 'jsonwebtoken',
      evidence: ['package.json'],
      loginMethods: [],
      sessionStrategy: 'not-inspected',
      protectedRoutes: 1,
      userModel: null,
      note: 'declared only',
    },
    database: {
      status: 'declared',
      provider: 'postgresql',
      connection: 'not-configured',
      evidence: ['prisma/schema.prisma'],
      models: 1,
      note: 'no connection',
    },
    logs: { status: 'unavailable', entries: [], note: 'no source' },
    manifests: [],
    recentChanges: [],
    scanned: { files: 3, read: 3, skipped: 0, truncated: false },
    warnings: [],
    ...overrides,
  };
}

function frontend(overrides: Partial<FrontendStructure> = {}): FrontendStructure {
  return {
    layout: 'component-based',
    framework: 'react',
    language: 'typescript',
    totals: { files: 4, bytes: 400 },
    sections: [],
    ...overrides,
  } as FrontendStructure;
}

const HEALTH: Omit<HealthInput, 'backend'> = {
  frontendFiles: 4,
  frontendLayout: 'component-based',
  frontendFramework: 'react',
  configurationFiles: 2,
  testFiles: 0,
  runtime: 'none',
  unmatchedRequests: 0,
  scanCapped: false,
};

describe('file grouping', () => {
  it('places every file in exactly one group and keeps its real path', () => {
    const files = [
      { path: 'src/components/Button.tsx', size: 10 },
      { path: 'src/routes/users.ts', size: 20 },
      { path: 'src/shared/format.ts', size: 30 },
      { path: 'package.json', size: 40 },
      { path: 'src/components/Button.test.tsx', size: 50 },
      { path: 'public/logo.png', size: 60 },
      { path: 'README.md', size: 70 },
    ];
    const grouped = groupWorkspaceFiles(files);
    const listed = grouped.groups.flatMap((group) => group.files.map((file) => file.path));
    expect(listed.sort()).toEqual(files.map((file) => file.path).sort());
    expect(grouped.totals).toEqual({ files: 7, bytes: 280 });
    expect(grouped.byPath['src/components/Button.tsx']).toBe('frontend');
    expect(grouped.byPath['src/routes/users.ts']).toBe('backend');
    expect(grouped.byPath['src/shared/format.ts']).toBe('shared');
    expect(grouped.byPath['package.json']).toBe('configuration');
    expect(grouped.byPath['src/components/Button.test.tsx']).toBe('tests');
    expect(grouped.byPath['public/logo.png']).toBe('assets');
    expect(grouped.byPath['README.md']).toBe('other');
  });

  it('orders groups predictably and omits empty ones', () => {
    const grouped = groupWorkspaceFiles([{ path: 'src/app/page.tsx', size: 1 }]);
    expect(grouped.groups.map((group) => group.group)).toEqual(['frontend']);
    expect(grouped.groups[0]?.label).toBe('Frontend');
  });

  it('classifies by rule, not by renaming anything', () => {
    expect(groupForPath('migrations/0001_init.sql')).toBe('backend');
    expect(groupForPath('lib/http.ts')).toBe('shared');
    expect(groupForPath('theme/dark.css')).toBe('frontend');
    expect(groupForPath('Dockerfile')).toBe('configuration');
  });
});

describe('cross-layer link detection', () => {
  const files = [
    {
      path: 'src/components/UserList.tsx',
      content: [
        "import { useEffect } from 'react';",
        'export function UserList() {',
        "  fetch('/api/users').then((response) => response.json());",
        "  fetch('/api/users/42/notes');",
        "  fetch('/api/orders', { method: 'POST' });",
        "  fetch('https://api.stripe.com/v1/charges');",
        '  fetch(`/api/users/${id}`);',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/routes/users.ts',
      content: [
        'export function register(app) {',
        "  app.get('/api/users', listUsers);",
        "  app.get('/api/users/:id/notes', listUserNotes);",
        "  app.delete('/api/users/:id', removeUser);",
        '}',
      ].join('\n'),
    },
  ];
  const routes: BackendRoute[] = [
    route(),
    route({ method: 'GET', path: '/api/users/:id/notes', handler: 'listUserNotes', line: 3 }),
    route({ method: 'DELETE', path: '/api/users/:id', handler: 'removeUser', line: 4 }),
  ];

  it('reads request sites with their method and line', () => {
    const sites = extractRequestSites(files[0]!);
    expect(sites.find((site) => site.url === '/api/users')?.line).toBe(3);
    expect(sites.find((site) => site.url === '/api/orders')?.method).toBe('POST');
  });

  it('links an exact path and a parameterised path to their routes', () => {
    const graph = detectCrossLayerLinks({ files, routes });
    const requests = graph.links.filter((link) => link.kind === 'frontend-request');
    const exact = requests.find((link) => link.path === '/api/users');
    expect(exact?.confidence).toBe('exact');
    expect(exact?.to.file).toBe('src/routes/users.ts');
    expect(exact?.to.line).toBe(4);
    const parameterised = requests.find((link) => link.path === '/api/users/42/notes');
    expect(parameterised?.confidence).toBe('parameterised');
    expect(parameterised?.to.label).toBe('GET /api/users/:id/notes');
  });

  it('keeps unmatched requests, method mismatches and external hosts unknown', () => {
    const graph = detectCrossLayerLinks({ files, routes });
    const reasons = graph.unmatchedRequests.map((entry) => `${entry.url}:${entry.reason}`);
    expect(reasons).toContain('/api/orders:no-matching-route');
    expect(reasons).toContain('https://api.stripe.com/v1/charges:external-host');
    expect(reasons.some((entry) => entry.endsWith(':dynamic-url'))).toBe(true);
  });

  it('reports routes nothing calls without calling them broken', () => {
    const graph = detectCrossLayerLinks({ files, routes });
    expect(graph.routesWithoutCaller).toContainEqual({ method: 'DELETE', path: '/api/users/:id' });
    expect(graph.note).toMatch(/not an error/i);
  });

  it('separates a correct path with the wrong verb from a missing route', () => {
    const graph = detectCrossLayerLinks({
      files: [
        {
          path: 'src/pages/Users.tsx',
          content: "fetch('/api/users', { method: 'POST', body: JSON.stringify(next) });",
        },
      ],
      routes: [route({ method: 'GET', path: '/api/users' })],
    });
    expect(graph.links.filter((link) => link.kind === 'frontend-request')).toHaveLength(0);
    expect(graph.unmatchedRequests[0]).toMatchObject({
      url: '/api/users',
      method: 'POST',
      reason: 'method-mismatch',
    });
  });

  it('links a route to its handler and to the model its file uses', () => {
    const graph = detectCrossLayerLinks({
      files: [
        {
          path: 'src/routes/users.ts',
          content: "app.get('/api/users', async () => prisma.user.findMany());",
        },
      ],
      routes: [route({ file: 'src/routes/users.ts', handler: 'listUsers' })],
      models: [model('user')],
    });
    const handlerLink = graph.links.find((link) => link.kind === 'route-handler');
    expect(handlerLink?.to.label).toBe('listUsers');
    const modelLink = graph.links.find((link) => link.kind === 'handler-model');
    expect(modelLink?.to.label).toBe('user');
    expect(modelLink?.to.line).toBe(3);
  });

  it('links a guarded route to the authentication configuration', () => {
    const graph = detectCrossLayerLinks({
      files: [],
      routes: [route({ auth: 'declared' })],
    });
    expect(graph.links.some((link) => link.kind === 'route-auth')).toBe(true);
  });

  it('never invents an edge for a similar-looking name', () => {
    const graph = detectCrossLayerLinks({
      files: [{ path: 'src/lib/client.ts', content: "get('/users')" }],
      routes: [route({ path: '/api/users' })],
    });
    expect(graph.links.filter((link) => link.kind === 'frontend-request')).toHaveLength(0);
    expect(graph.unmatchedRequests).toHaveLength(0);
  });
});

describe('application health', () => {
  it('uses only the documented status words', () => {
    const health = buildAppHealth({ ...HEALTH, backend: report() });
    const facts: StatusFact[] = [
      health.frontend,
      health.backend,
      health.apiRoutes,
      health.database,
      health.tests,
      health.runtime,
    ];
    for (const entry of facts) expect(UNIFIED_STATUSES).toContain(entry.status);
  });

  it('calls a declared database configured, never running', () => {
    const health = buildAppHealth({ ...HEALTH, backend: report() });
    expect(health.database.status).toBe('configured');
    expect(health.database.detail).toMatch(/no connection/i);
    expect(health.runtime.status).toBe('unavailable');
  });

  it('does not call a manifest-only project a frontend or backend', () => {
    // The scan reads package.json and .env.example; they are configuration, not
    // source. Before the grouping supplied the count, a two-file manifest-only
    // project reported "2 frontend file(s)" and 2 backend files.
    const health = buildAppHealth({
      ...HEALTH,
      frontendFiles: 0,
      backendFiles: 0,
      backend: report({
        structure: { ...report().structure, totals: { files: 2, bytes: 120 } },
        routes: [],
        models: [],
      }),
    });
    expect(health.frontend).toMatchObject({ status: 'not-configured' });
    expect(health.frontend.detail).not.toMatch(/\d frontend file/);
    expect(health.backend).toMatchObject({ status: 'not-configured' });
  });

  it('reports an empty project honestly', () => {
    const health = buildAppHealth({
      ...HEALTH,
      frontendFiles: 0,
      testFiles: 0,
      backend: report({
        structure: { ...report().structure, totals: { files: 0, bytes: 0 } },
        routes: [],
        models: [],
        database: {
          status: 'absent',
          provider: null,
          connection: 'not-configured',
          evidence: [],
          models: 0,
          note: 'none',
        },
        auth: {
          status: 'absent',
          provider: null,
          evidence: [],
          loginMethods: [],
          sessionStrategy: 'not-inspected',
          protectedRoutes: 0,
          userModel: null,
          note: 'none',
        },
      }),
    });
    expect(health.frontend.status).toBe('not-configured');
    expect(health.backend.status).toBe('not-configured');
    expect(health.database.status).toBe('not-configured');
    expect(health.apiRoutes.status).toBe('not-configured');
  });

  it('never reports tests as tested without a recorded run', () => {
    const health = buildAppHealth({ ...HEALTH, testFiles: 6, backend: report() });
    expect(health.tests.status).toBe('detected');
    expect(health.tests.detail).toMatch(/no test run is recorded/i);
  });

  it('raises a warning for requests with no route and for capped scans', () => {
    const health = buildAppHealth({
      ...HEALTH,
      unmatchedRequests: 3,
      scanCapped: true,
      backend: report(),
    });
    expect(health.warnings.join(' ')).toMatch(/no matching backend route/i);
    expect(health.warnings.join(' ')).toMatch(/file cap/i);
    expect(health.inspectedCompletely).toBe(false);
  });
});

describe('unified overview', () => {
  const routes = [route()];
  const files = [{ path: 'src/components/App.tsx', content: "fetch('/api/users')" }];
  const graph = detectCrossLayerLinks({ files, routes });

  function overview(
    overrides: {
      detection?: { framework: string | null; language: string | null; runtime: string | null };
    } = {},
  ) {
    const backendReport = report({ routes });
    const grouped = groupWorkspaceFiles([
      { path: 'src/components/App.tsx', size: 100 },
      { path: 'src/routes/users.ts', size: 200 },
      { path: 'package.json', size: 50 },
      { path: 'src/components/App.test.tsx', size: 60 },
    ]);
    return buildUnifiedOverview({
      project: {
        id: 'prj_1',
        name: 'Demo',
        description: 'demo project',
        projectType: 'fullstack',
        status: 'active',
        updatedAt: '2026-11-01T09:00:00.000Z',
      },
      workspace: { id: 'ws_1', name: 'main', branch: 'main', revision: 7 },
      detection: overrides.detection ?? {
        framework: 'react',
        language: 'typescript',
        runtime: 'node',
      },
      frontend: frontend(),
      backend: backendReport,
      grouping: grouped,
      graph,
      health: buildAppHealth({ ...HEALTH, backend: backendReport }),
      recentChanges: [
        { path: 'src/routes/users.ts', action: 'updated', at: '2026-11-01T09:00:00.000Z' },
      ],
    });
  }

  it('counts from the scans rather than from assumptions', () => {
    const result = overview();
    expect(result.counts).toEqual({
      files: 4,
      bytes: 410,
      frontendFiles: 1,
      backendFiles: 1,
      configurationFiles: 1,
      testFiles: 1,
      apiRoutes: 1,
      models: 0,
      requestSites: 1,
      matchedLinks: 1,
    });
    expect(result.workspace?.revision).toBe(7);
    expect(result.lastUpdated).toBe('2026-11-01T09:00:00.000Z');
  });

  it('says the stack is unknown instead of guessing', () => {
    const result = overview({ detection: { framework: null, language: null, runtime: null } });
    expect(result.stack).toMatchObject({ framework: null, language: null, source: 'unknown' });
    expect(result.notes.join(' ')).toMatch(/framework and language are unknown/i);
  });

  it('explains when requests exist but none matched', () => {
    const backendReport = report({ routes: [route({ path: '/api/other' })] });
    const unmatchedGraph = detectCrossLayerLinks({
      files: [{ path: 'src/components/App.tsx', content: "fetch('/api/users')" }],
      routes: [route({ path: '/api/other' })],
    });
    const result = buildUnifiedOverview({
      project: {
        id: 'p',
        name: 'n',
        description: '',
        projectType: 'web',
        status: 'active',
        updatedAt: null,
      },
      workspace: null,
      detection: { framework: null, language: null, runtime: null },
      frontend: frontend(),
      backend: backendReport,
      grouping: groupWorkspaceFiles([]),
      graph: unmatchedGraph,
      health: buildAppHealth({ ...HEALTH, backend: backendReport }),
      recentChanges: [],
    });
    expect(result.notes.join(' ')).toMatch(/none of them matched a backend route/i);
    expect(result.workspace).toBeNull();
  });
});
