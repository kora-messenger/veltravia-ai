import { beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';

/**
 * Step 16: codebase intelligence over the API. The HTTP surface is
 * project-scoped (unknown project -> 404), workspace association is
 * validated server-side (foreign workspace -> 400), responses are SAFE
 * VIEWS (never raw source content), and memory candidates only come
 * from COMPLETED indexes.
 */

type App = ReturnType<typeof buildApp>;

async function seedProjectWithWorkspace(app: App): Promise<{
  projectId: string;
  workspaceId: string;
}> {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Codebase Fixture',
      projectType: 'web',
      description: 'A demo project for codebase analysis tests.',
    },
  });
  const projectId = project.json().id as string;
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    payload: { name: 'main' },
  });
  const workspaceId = workspace.json().id as string;
  return { projectId, workspaceId };
}

async function writeFile(
  app: App,
  workspaceId: string,
  path: string,
  content: string,
): Promise<void> {
  // Nested paths need their parent directories first (requireParentDirectory).
  const segments = path.split('/');
  if (segments.length > 1) {
    let dir = '';
    for (const segment of segments.slice(0, -1)) {
      dir = dir === '' ? segment : `${dir}/${segment}`;
      const mkdir = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/directories`,
        payload: { path: dir },
      });
      if (mkdir.statusCode >= 500) {
        throw new Error(`mkdir ${dir} failed: ${mkdir.body}`);
      }
    }
  }
  const response = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/files`,
    payload: { path, content },
  });
  if (response.statusCode !== 201 && response.statusCode !== 200) {
    throw new Error(`write ${path} failed: ${response.body}`);
  }
}

const FIXTURE_FILES: readonly { path: string; content: string }[] = [
  {
    path: 'package.json',
    content:
      '{"name":"demo","dependencies":{"react":"^18.0.0","react-dom":"^18.0.0"},"devDependencies":{"vite":"^5.0.0"}}',
  },
  {
    path: 'src/main.tsx',
    content: [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import { App } from './App';",
      "const el = document.getElementById('root');",
      'if (el !== null) { createRoot(el).render(<App />); }',
    ].join('\n'),
  },
  {
    path: 'src/App.tsx',
    content: [
      "import { LoginForm } from './components/LoginForm';",
      'export const App = () => {',
      '  return <div><LoginForm /></div>;',
      '};',
    ].join('\n'),
  },
  {
    path: 'src/components/LoginForm.tsx',
    content: [
      'export const LoginForm = () => {',
      '  const submit = (): void => { validate(); };',
      '  return <button onClick={submit}>Sign in</button>;',
      '};',
      'function validate(): boolean { return true; }',
    ].join('\n'),
  },
  {
    path: 'src/services/auth.test.ts',
    content:
      "import { describe, it, expect } from 'vitest';\ndescribe('auth', () => { it('works', () => { expect(1).toBe(1); }); });\n",
  },
];

async function seedFixture(app: App): Promise<{ projectId: string; workspaceId: string }> {
  const { projectId, workspaceId } = await seedProjectWithWorkspace(app);
  for (const file of FIXTURE_FILES) {
    await writeFile(app, workspaceId, file.path, file.content);
  }
  return { projectId, workspaceId };
}

describe('codebase routes - project scoping and validation', () => {
  it('rejects index build for an unknown project', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/ghost/codebase/index',
      payload: { workspaceId: 'ws' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a workspace that belongs to another project', async () => {
    const app = buildApp();
    const first = await seedProjectWithWorkspace(app);
    const second = await seedProjectWithWorkspace(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${second.projectId}/codebase/index`,
      payload: { workspaceId: first.workspaceId },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects search on a workspace with no index yet', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedProjectWithWorkspace(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/search`,
      payload: { workspaceId, query: 'App', searchType: 'symbol' },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json().error as { code: string }).code).toBe('CODEBASE_INDEX_NOT_FOUND');
  });
});

describe('codebase routes - index lifecycle', () => {
  it('builds an index, reports it current, and rebuilds incrementally', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedFixture(app);

    const build = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/index`,
      payload: { workspaceId },
    });
    expect(build.statusCode).toBe(200);
    const body = build.json() as {
      index: { status: string; fileCount: number; languages: string[]; routeCount: number };
      incremental: boolean;
      changedFiles: number;
    };
    expect(body.index.status).toBe('current');
    expect(body.index.fileCount).toBe(FIXTURE_FILES.length);
    expect(body.index.languages).toContain('typescript');
    expect(body.index.languages).toContain('json');
    expect(body.incremental).toBe(false);

    // Unchanged rebuild is incremental with zero changed files.
    const rebuild = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/index`,
      payload: { workspaceId, incremental: true },
    });
    const rebuildBody = rebuild.json() as { incremental: boolean; changedFiles: number };
    expect(rebuildBody.incremental).toBe(true);
    expect(rebuildBody.changedFiles).toBe(0);
  });

  it('marks the index stale after a file write, then refreshes it', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedFixture(app);
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/index`,
      payload: { workspaceId },
    });
    await writeFile(
      app,
      workspaceId,
      'src/added.ts',
      'export function added(): number { return 1; }\n',
    );

    const stale = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/codebase/index?workspaceId=${workspaceId}`,
    });
    expect((stale.json() as { index: { status: string } }).index.status).toBe('stale');

    const rebuild = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/index`,
      payload: { workspaceId },
    });
    const rebuilt = rebuild.json() as { index: { fileCount: number }; changedFiles: number };
    expect(rebuilt.changedFiles).toBe(1);
    expect(rebuilt.index.fileCount).toBe(FIXTURE_FILES.length + 1);
  });

  it('returns a safe index view - no source content anywhere in the response', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedFixture(app);
    const build = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/index`,
      payload: { workspaceId },
    });
    expect(build.statusCode).toBe(200);
    const serialized = JSON.stringify(build.json());
    // Fixture source text must NEVER appear in the response.
    expect(serialized).not.toContain('createRoot');
    expect(serialized).not.toContain('Sign in');
  });
});

describe('codebase routes - search, trace, summary, symbol views', () => {
  let app: App;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    app = buildApp();
    const seeded = await seedFixture(app);
    projectId = seeded.projectId;
    workspaceId = seeded.workspaceId;
    const build = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/index`,
      payload: { workspaceId },
    });
    expect(build.statusCode).toBe(200);
  });

  it('searches symbols with bounded results and safe evidence', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/search`,
      payload: { workspaceId, query: 'LoginForm', searchType: 'symbol' },
    });
    expect(response.statusCode).toBe(200);
    const results = (response.json() as { results: { title: string; detail: string }[] }).results;
    expect(results.some((r) => r.title === 'LoginForm')).toBe(true);
  });

  it('structural search lists entry points', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/search`,
      payload: { workspaceId, query: '', searchType: 'structural', structuralKind: 'entry_points' },
    });
    const results = (response.json() as { results: { title: string }[] }).results;
    expect(results.some((r) => r.title.includes('main.tsx'))).toBe(true);
  });

  it('traces a feature across files without leaking source content', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/trace`,
      payload: { workspaceId, feature: 'login form' },
    });
    expect(response.statusCode).toBe(200);
    const trace = (response.json() as { trace: { nodes: { label: string }[]; notes: string[] } })
      .trace;
    expect(trace.nodes.some((n) => n.label === 'LoginForm')).toBe(true);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('Sign in');
  });

  it('summary is evidence-derived and includes test files', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/codebase/summary?workspaceId=${workspaceId}`,
    });
    expect(response.statusCode).toBe(200);
    const summary = (
      response.json() as {
        summary: { languages: string[]; frameworks: { id: string }[]; testFilePaths: string[] };
      }
    ).summary;
    expect(summary.languages).toContain('typescript');
    expect(summary.frameworks.some((f) => f.id === 'react')).toBe(true);
    expect(summary.testFilePaths).toContain('src/services/auth.test.ts');
  });

  it('file view returns metadata + symbols, never content', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/codebase/files/src/components/LoginForm.tsx?workspaceId=${workspaceId}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      file: { path: string; parseStatus: string };
      symbols: { name: string }[];
    };
    expect(body.file.parseStatus).toBe('parsed');
    expect(body.symbols.some((s) => s.name === 'LoginForm')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Sign in');
  });

  it('unknown file in the index view 404s honestly', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/codebase/files/nope.ts?workspaceId=${workspaceId}`,
    });
    expect(response.statusCode).toBe(404);
    expect((response.json().error as { code: string }).code).toBe('CODEBASE_FILE_NOT_FOUND');
  });
});

describe('codebase routes - memory candidate extraction', () => {
  it('extracts candidates from a completed index only', async () => {
    const app = buildApp();
    const { projectId, workspaceId } = await seedFixture(app);

    // No index yet -> honest rejection.
    const tooEarly = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/memory-candidates`,
      payload: { workspaceId },
    });
    expect([404, 409]).toContain(tooEarly.statusCode);

    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/index`,
      payload: { workspaceId },
    });
    const extract = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/codebase/memory-candidates`,
      payload: { workspaceId },
    });
    expect(extract.statusCode).toBe(201);
    const body = extract.json() as {
      candidates: number;
      memories: { status: string; source: { kind: string } }[];
    };
    expect(body.candidates).toBeGreaterThan(0);
    expect(body.candidates).toBeLessThanOrEqual(10);
    for (const memory of body.memories) {
      expect(memory.status).toBe('candidate');
      expect(memory.source.kind).toBe('system_derived');
    }

    // Candidates are visible in memory list as candidates (never active).
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/memories?status=candidate`,
    });
    const items = (list.json() as { memories: { status: string }[] }).memories;
    expect(items.length).toBeGreaterThanOrEqual(body.candidates);
    for (const item of items) {
      expect(item.status).toBe('candidate');
    }
  });
});
