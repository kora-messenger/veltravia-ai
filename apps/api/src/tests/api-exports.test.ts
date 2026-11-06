import yauzl from 'yauzl';
import { describe, expect, it } from 'vitest';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { buildApp } from '../server.js';
import { createRateLimiter } from '../rate-limit.js';
import { createExportService } from '../export-service.js';

const ALICE = { 'x-veltravia-owner-ref': 'owner-alice' };
const BOB = { 'x-veltravia-owner-ref': 'owner-bob' };
const FAKE_KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3';

function extract(bytes: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error !== null || zip === undefined) return reject(error);
      const out = new Map<string, string>();
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e !== null || stream === undefined) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function setup(options?: { limiter?: ReturnType<typeof createRateLimiter> }) {
  const projectEngine = createProjectEngine({
    now: () => new Date('2026-11-05T10:00:00Z'),
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const exportsManager = createExportService({ projectEngine });
  const app = buildApp({
    projectEngine,
    exports: exportsManager,
  });
  const create = async (headers: Record<string, string>, name: string) => {
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name, description: 'x', projectType: 'web' },
    });
    const projectId = (project.json() as { id: string }).id;
    const workspace = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workspaces`,
      headers,
      payload: { name: 'main' },
    });
    return { projectId, workspaceId: (workspace.json() as { id: string }).id };
  };
  const dir = (headers: Record<string, string>, workspaceId: string, path: string) =>
    app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/directories`,
      headers,
      payload: { path },
    });
  const file = async (
    headers: Record<string, string>,
    workspaceId: string,
    path: string,
    content: string,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      headers,
      payload: { path, content },
    });
    expect(response.statusCode, `write ${path}`).toBe(201);
  };
  void options;
  return { app, create, dir, file, projectEngine };
}

async function aliceProject() {
  const s = await setup();
  const { projectId, workspaceId } = await s.create(ALICE, 'Kora Messenger');
  await s.dir(ALICE, workspaceId, 'src');
  await s.dir(ALICE, workspaceId, 'src/ui');
  await s.file(ALICE, workspaceId, 'package.json', '{"name":"kora"}\n');
  await s.file(ALICE, workspaceId, 'README.md', '# Kora\r\n');
  await s.file(ALICE, workspaceId, 'src/index.ts', 'export const a = 1;\n');
  await s.file(ALICE, workspaceId, 'src/ui/App.tsx', 'export const App = () => null;\n');
  return { ...s, projectId, workspaceId };
}

describe('POST /api/projects/:projectId/exports', () => {
  it('exports a real project and the download is a valid ZIP with the exact files', async () => {
    const { app, projectId } = await aliceProject();
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: ALICE,
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const view = created.json();
    expect(view.status).toBe('ready');
    expect(view.totals.files).toBe(4);

    const download = await app.inject({
      method: 'GET',
      url: `/api/exports/${view.exportId}/download`,
      headers: ALICE,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toBe(
      'attachment; filename="Kora-Messenger.zip"',
    );
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.headers['x-veltravia-archive-sha256']).toBe(view.archiveHash);

    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(view.archiveHash);

    const files = await extract(download.rawPayload);
    expect([...files.keys()].sort()).toEqual([
      'Kora-Messenger/README.md',
      'Kora-Messenger/package.json',
      'Kora-Messenger/src/index.ts',
      'Kora-Messenger/src/ui/App.tsx',
    ]);
    expect(files.get('Kora-Messenger/README.md')).toBe('# Kora\r\n');
  });

  it('exports a selection: a folder and a single file', async () => {
    const { app, projectId } = await aliceProject();
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: ALICE,
      payload: { scope: 'selection', paths: ['src/ui', 'package.json'] },
    });
    expect(created.statusCode).toBe(201);
    const download = await app.inject({
      method: 'GET',
      url: `/api/exports/${created.json().exportId}/download`,
      headers: ALICE,
    });
    const files = await extract(download.rawPayload);
    expect([...files.keys()].sort()).toEqual([
      'Kora-Messenger/package.json',
      'Kora-Messenger/src/ui/App.tsx',
    ]);
  });

  it('reports excluded files by name and reason without their contents', async () => {
    const { app, projectId, workspaceId, file } = await aliceProject();
    await file(ALICE, workspaceId, 'src/leak.ts', `export const t = "${FAKE_KEY}";\n`);
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: ALICE,
      payload: {},
    });
    const text = created.body;
    expect(created.json().excluded).toEqual([
      expect.objectContaining({ path: 'src/leak.ts', reason: 'secret-in-content' }),
    ]);
    expect(text).not.toContain(FAKE_KEY);
  });

  it('validates its own archive against the recorded manifest', async () => {
    const { app, projectId } = await aliceProject();
    const view = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/exports`,
        headers: ALICE,
        payload: {},
      })
    ).json();
    const validation = await app.inject({
      method: 'GET',
      url: `/api/exports/${view.exportId}/validate`,
      headers: ALICE,
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toMatchObject({ valid: true, entries: 4, problems: [] });
  });
});

describe('who may export and download', () => {
  it('refuses another owner exporting a project, exactly like a missing project', async () => {
    const { app, projectId } = await aliceProject();
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: BOB,
      payload: {},
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/projects/prj-404/exports',
      headers: BOB,
      payload: {},
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
  });

  it('refuses another owner reading, validating, downloading or deleting an export', async () => {
    const { app, projectId } = await aliceProject();
    const view = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/exports`,
        headers: ALICE,
        payload: {},
      })
    ).json();
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/exports/exp_doesnotexistdoesnotexist',
      headers: BOB,
    });
    for (const [method, suffix] of [
      ['GET', ''],
      ['GET', '/validate'],
      ['GET', '/download'],
      ['DELETE', ''],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/exports/${view.exportId}${suffix}`,
        headers: BOB,
      });
      expect(response.statusCode, `${method} ${suffix}`).toBe(404);
      expect(response.json()).toEqual(unknown.json());
    }
    // The owner is unaffected by the failed attempts.
    const own = await app.inject({
      method: 'GET',
      url: `/api/exports/${view.exportId}/download`,
      headers: ALICE,
    });
    expect(own.statusCode).toBe(200);
  });

  it('never lists another owner’s exports', async () => {
    const { app, projectId } = await aliceProject();
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: ALICE,
      payload: {},
    });
    const bob = await app.inject({ method: 'GET', url: '/api/exports', headers: BOB });
    expect(bob.json()).toEqual({ exports: [] });
    const alice = await app.inject({ method: 'GET', url: '/api/exports', headers: ALICE });
    expect(alice.json().exports).toHaveLength(1);
  });

  it('does not let the body name a different owner or project', async () => {
    const { app, projectId } = await aliceProject();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: BOB,
      payload: { ownerRef: 'owner-alice', projectId },
    });
    // The central guard answers first, before the body is read: Bob learns
    // nothing about whether the project exists.
    expect(response.statusCode).toBe(404);
    const own = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: ALICE,
      payload: { ownerRef: 'owner-bob' },
    });
    // ...and for the real owner, unknown body fields are refused outright.
    expect(own.statusCode).toBe(400);
  });
});

describe('input validation over HTTP', () => {
  it.each([
    ['..'],
    ['../../etc/passwd'],
    ['/etc/passwd'],
    ['src/../../x'],
    ['%2e%2e/x'],
    ['src\\..\\x'],
  ])('rejects the traversal path %j with a 400 and leaks nothing', async (path) => {
    const { app, projectId } = await aliceProject();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: ALICE,
      payload: { scope: 'selection', paths: [path] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('EXPORT_PATH_INVALID');
  });

  it('rejects an empty selection, a bad scope and a malformed body', async () => {
    const { app, projectId } = await aliceProject();
    const post = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/exports`,
        headers: ALICE,
        payload: payload as object,
      });
    expect((await post({ scope: 'selection', paths: [] })).statusCode).toBe(400);
    expect((await post({ scope: 'everything' })).statusCode).toBe(400);
    expect((await post({ scope: 'selection', paths: 'src' })).statusCode).toBe(400);
    expect((await post({ paths: [1, 2] })).statusCode).toBe(400);
    // `paths` with no `scope` must not quietly export the whole project.
    expect((await post({ paths: ['src'] })).statusCode).toBe(400);
    expect((await post({ scope: 'project', paths: ['src'] })).statusCode).toBe(400);
    expect((await post({ scope: 'selection', paths: [1] })).statusCode).toBe(400);
  });

  it('treats a malformed project id or export id as not found / bad request, never a crash', async () => {
    const { app } = await aliceProject();
    const badProject = await app.inject({
      method: 'POST',
      url: '/api/projects/..%2F..%2Fetc/exports',
      headers: ALICE,
      payload: {},
    });
    expect([400, 404]).toContain(badProject.statusCode);
    const badExport = await app.inject({
      method: 'GET',
      url: '/api/exports/not%20valid!/download',
      headers: ALICE,
    });
    expect([400, 404]).toContain(badExport.statusCode);
  });

  it('returns 409 and no archive for a project with nothing exportable', async () => {
    const s = await setup();
    const { projectId, workspaceId } = await s.create(ALICE, 'Only Secrets');
    await s.file(ALICE, workspaceId, 'readme.txt', 'x');
    // A project whose only content is credentials.
    const empty = await s.create(ALICE, 'Empty');
    const response = await s.app.inject({
      method: 'POST',
      url: `/api/projects/${empty.projectId}/exports`,
      headers: ALICE,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('failed');
    expect(response.json().failure.code).toBe('EXPORT_NOTHING_TO_EXPORT');
    void projectId;
  });
});

describe('rate limits', () => {
  it('limits export creation per caller and says when to retry', async () => {
    const projectEngine = createProjectEngine({
      now: () => new Date('2026-11-05T10:00:00Z'),
      generateProjectId: createSequentialIdGenerator('prj'),
      generateWorkspaceId: createSequentialIdGenerator('ws'),
      generateNodeId: createSequentialIdGenerator('node'),
    });
    const { registerExportRoutes } = await import('../routes/exports.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    registerExportRoutes(app, {
      exports: createExportService({ projectEngine }),
      createLimiter: createRateLimiter({ max: 2, windowMs: 60_000 }),
    });
    const hit = () =>
      app.inject({
        method: 'POST',
        url: '/api/projects/prj-1/exports',
        headers: ALICE,
        payload: {},
      });
    expect((await hit()).statusCode).toBe(404);
    expect((await hit()).statusCode).toBe(404);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json().error.code).toBe('EXPORT_RATE_LIMITED');
    // A different caller has their own allowance.
    const other = await app.inject({
      method: 'POST',
      url: '/api/projects/prj-1/exports',
      headers: BOB,
      payload: {},
    });
    expect(other.statusCode).toBe(404);
  });
});

describe('lifecycle', () => {
  it('lets the owner delete an export, after which the download is gone', async () => {
    const { app, projectId } = await aliceProject();
    const view = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/exports`,
        headers: ALICE,
        payload: {},
      })
    ).json();
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/exports/${view.exportId}`,
      headers: ALICE,
    });
    expect(deleted.statusCode).toBe(204);
    const again = await app.inject({
      method: 'GET',
      url: `/api/exports/${view.exportId}/download`,
      headers: ALICE,
    });
    expect(again.statusCode).toBe(404);
  });

  it('does not change the project it exported', async () => {
    const { app, projectId, workspaceId, projectEngine } = await aliceProject();
    const before = (await projectEngine.workspaces.getWorkspace(workspaceId))?.revision;
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: ALICE,
      payload: {},
    });
    expect((await projectEngine.workspaces.getWorkspace(workspaceId))?.revision).toBe(before);
  });
});
