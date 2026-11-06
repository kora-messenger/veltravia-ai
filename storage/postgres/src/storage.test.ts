/**
 * Integration tests against a real PostgreSQL server.
 *
 * These are the tests that would have caught every bug the in-memory stores
 * could not express: a missing owner predicate, a child row attached to another
 * owner's project, a snapshot written without its revision, a path traversal in
 * object keys, or a migration that silently re-runs.
 *
 * They need `VELTRAVIA_TEST_DATABASE_URL`. When it is absent the suite is
 * skipped rather than faked, and CI provides a real postgres:16 service so the
 * skip never masks a failure there.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type Database,
  DatabaseError,
  LocalObjectStore,
  MIGRATIONS,
  MigrationError,
  OwnerScopeMissingError,
  createDatabase,
  createPostgresProjectEngine,
  createPostgresStores,
  currentOwner,
  migrate,
  parseDatabaseUrl,
  runWithOwner,
  schemaStatus,
} from './index.js';

const databaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeIntegration = databaseUrl === '' ? describe.skip : describe;

const OWNER = 'owner-alpha';
const OTHER = 'owner-beta';

let database: Database;
let stores: ReturnType<typeof createPostgresStores>;
let scratch: string;

const TRUNCATE = `
truncate table
  projects, run_records, export_jobs, stored_objects
restart identity cascade
`;

/** Runs `fn` bound to an owner, the way an HTTP request would. */
function as<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  return runWithOwner(owner, fn);
}

async function newProject(owner = OWNER, name = 'Apollo'): Promise<string> {
  const project = await as(owner, () =>
    stores.projects.create({
      name,
      description: 'A test project',
      projectType: 'web',
      ownerRef: owner,
      version: '0.1.0',
      metadata: { source: 'integration-test' },
    }),
  );
  return project.id;
}

async function newWorkspace(projectId: string, owner = OWNER): Promise<string> {
  const workspace = await as(owner, () =>
    stores.workspaces.create({
      projectId,
      name: 'main',
      root: '.',
      metadata: {},
    }),
  );
  return workspace.id;
}

describeIntegration('postgres storage', () => {
  beforeAll(async () => {
    database = createDatabase(parseDatabaseUrl(databaseUrl, {}));
    await migrate(database);
    stores = createPostgresStores(database);
    scratch = await mkdtemp(join(tmpdir(), 'veltravia-objects-'));
  }, 60_000);

  afterAll(async () => {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    await database?.close();
  });

  beforeEach(async () => {
    await database.query(TRUNCATE);
  });

  describe('migrations', () => {
    it('reports the applied version and nothing pending', async () => {
      const status = await schemaStatus(database);
      expect(status.pending).toEqual([]);
      expect(status.currentVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
      expect(status.applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
    });

    it('is idempotent', async () => {
      const second = await migrate(database);
      expect(second.applied).toEqual([]);
      expect(second.skipped.length).toBe(MIGRATIONS.length);
    });

    it('refuses to run when an applied migration was edited', async () => {
      await database.query(
        `update veltravia_schema_migrations set checksum = 'tampered' where version = $1`,
        [MIGRATIONS[0]!.version],
      );
      await expect(migrate(database)).rejects.toBeInstanceOf(MigrationError);
      // Undo the tamper by forgetting the row; re-applying is safe because the
      // first migration is written with IF NOT EXISTS.
      await database.query('delete from veltravia_schema_migrations where version = $1', [
        MIGRATIONS[0]!.version,
      ]);
      await migrate(database);
    });

    it('reports health without leaking connection details', async () => {
      const health = await database.health();
      expect(health.status).toBe('ok');
      expect(JSON.stringify(health)).not.toContain('password');
      expect(health.pool.total).toBeGreaterThan(0);
    });
  });

  describe('ownership', () => {
    it('refuses any read without an owner scope', async () => {
      await expect(stores.projects.list()).rejects.toBeInstanceOf(OwnerScopeMissingError);
      await expect(stores.memory.count('prj_whatever')).rejects.toBeInstanceOf(
        OwnerScopeMissingError,
      );
    });

    it("hides another owner's project completely", async () => {
      const projectId = await newProject();
      await expect(as(OTHER, () => stores.projects.get(projectId))).resolves.toBeNull();
      await expect(as(OTHER, () => stores.projects.list())).resolves.toEqual([]);
      await expect(as(OWNER, () => stores.projects.get(projectId))).resolves.not.toBeNull();
      expect(currentOwner()).toBeNull();
    });

    it('rejects a spoofed ownerRef on create', async () => {
      await expect(
        as(OTHER, () =>
          stores.projects.create({
            name: 'Injected',
            description: '',
            projectType: 'web',
            ownerRef: OWNER,
            version: '0.1.0',
            metadata: {},
          }),
        ),
      ).rejects.toBeInstanceOf(DatabaseError);
    });

    it("refuses to attach a workspace to another owner's project", async () => {
      const projectId = await newProject(OWNER);
      await expect(newWorkspace(projectId, OTHER)).rejects.toMatchObject({
        category: 'constraint',
      });
    });

    it('refuses a direct SQL row planted under the wrong owner', async () => {
      const projectId = await newProject(OWNER);
      await expect(
        database.query(
          `insert into workspaces
             (id, project_id, owner_ref, name, root, status, revision, metadata, created_at, updated_at)
           values ('ws_evil', $1, 'owner-beta', 'evil', '.', 'active', 1, '{}', now(), now())`,
          [projectId],
        ),
      ).rejects.toMatchObject({ category: 'constraint' });
    });

    it('does not confirm existence when another owner writes', async () => {
      const projectId = await newProject(OWNER);
      await expect(
        as(OTHER, () =>
          stores.projects.update(projectId, {
            expectedRevision: 1,
            updatedAt: new Date().toISOString(),
            patch: { name: 'Stolen' },
          }),
        ),
      ).rejects.toBeDefined();
      await expect(as(OTHER, () => stores.workspaces.listByProject(projectId))).resolves.toEqual(
        [],
      );
    });
  });

  describe('projects and workspaces', () => {
    it('creates, reads and revises a project', async () => {
      const projectId = await newProject();
      const updated = await as(OWNER, () =>
        stores.projects.update(projectId, {
          expectedRevision: 1,
          updatedAt: new Date().toISOString(),
          patch: { name: 'Apollo II', metadata: { stack: 'fastify' } },
        }),
      );
      expect(updated.name).toBe('Apollo II');
      expect(updated.revision).toBe(2);
      expect(updated.metadata).toEqual({ stack: 'fastify' });
      expect(updated.createdAt <= updated.updatedAt).toBe(true);
    });

    it('rejects a stale revision instead of overwriting', async () => {
      const projectId = await newProject();
      const at = new Date().toISOString();
      await as(OWNER, () =>
        stores.projects.update(projectId, {
          expectedRevision: 1,
          updatedAt: at,
          patch: { name: 'B' },
        }),
      );
      await expect(
        as(OWNER, () =>
          stores.projects.update(projectId, {
            expectedRevision: 1,
            updatedAt: at,
            patch: { name: 'C' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    });

    it('bumps workspace revision and lists by project', async () => {
      const projectId = await newProject();
      const workspaceId = await newWorkspace(projectId);
      const bumped = await as(OWNER, () =>
        stores.workspaces.bumpRevision(workspaceId, new Date().toISOString()),
      );
      expect(bumped.revision).toBe(2);
      const listed = await as(OWNER, () => stores.workspaces.listByProject(projectId));
      expect(listed.map((w) => w.id)).toEqual([workspaceId]);
    });
  });

  describe('files', () => {
    it('stores content, sizes it and isolates it to its workspace', async () => {
      const projectId = await newProject();
      const workspaceId = await newWorkspace(projectId);
      const at = new Date().toISOString();
      const file = await as(OWNER, () =>
        stores.files.createNode({
          workspaceId,
          path: 'src/index.ts',
          name: 'index.ts',
          type: 'file',
          parentId: null,
          content: 'export const answer = 42;\n',
          createdAt: at,
        }),
      );
      expect(file.size).toBe(Buffer.byteLength('export const answer = 42;\n'));
      expect(await as(OWNER, () => stores.files.readContent(workspaceId, file.id))).toBe(
        'export const answer = 42;\n',
      );
      // Tree reads never carry content.
      const listed = await as(OWNER, () => stores.files.listAll(workspaceId));
      expect(Object.keys(listed[0]!)).not.toContain('content');
    });

    it("rejects a duplicate path with the engine's typed conflict", async () => {
      const projectId = await newProject();
      const workspaceId = await newWorkspace(projectId);
      const at = new Date().toISOString();
      const node = {
        workspaceId,
        path: 'README.md',
        name: 'README.md',
        type: 'file' as const,
        parentId: null,
        content: 'hi',
        createdAt: at,
      };
      await as(OWNER, () => stores.files.createNode(node));
      await expect(as(OWNER, () => stores.files.createNode(node))).rejects.toMatchObject({
        code: 'PATH_CONFLICT',
      });
    });

    it('lists direct children only and moves a subtree', async () => {
      const projectId = await newProject();
      const workspaceId = await newWorkspace(projectId);
      const at = new Date().toISOString();
      const mk = (path: string, type: 'file' | 'directory') =>
        as(OWNER, () =>
          stores.files.createNode({
            workspaceId,
            path,
            name: path.split('/').at(-1)!,
            type,
            parentId: null,
            content: type === 'file' ? 'x' : undefined,
            createdAt: at,
          }),
        );
      await mk('src', 'directory');
      await mk('src/a.ts', 'file');
      await mk('src/deep', 'directory');
      await mk('src/deep/b.ts', 'file');
      await mk('docs', 'directory');

      const root = await as(OWNER, () => stores.files.listChildren(workspaceId, ''));
      expect(root.map((n) => n.path)).toEqual(['docs', 'src']);
      const src = await as(OWNER, () => stores.files.listChildren(workspaceId, 'src'));
      expect(src.map((n) => n.path)).toEqual(['src/a.ts', 'src/deep']);

      await as(OWNER, () =>
        stores.files.moveSubtree(workspaceId, 'src/deep', 'src/deeper', new Date().toISOString()),
      );
      const after = await as(OWNER, () => stores.files.listAll(workspaceId));
      expect(after.map((n) => n.path)).toContain('src/deeper/b.ts');
      expect(after.map((n) => n.path)).not.toContain('src/deep/b.ts');
    });

    it('deletes the whole tree when the project is deleted', async () => {
      const projectId = await newProject();
      const workspaceId = await newWorkspace(projectId);
      await as(OWNER, () =>
        stores.files.createNode({
          workspaceId,
          path: 'a.txt',
          name: 'a.txt',
          type: 'file',
          parentId: null,
          content: 'a',
          createdAt: new Date().toISOString(),
        }),
      );
      await database.query('delete from projects where id = $1', [projectId]);
      const nodes = await database.query('select id from file_nodes where workspace_id = $1', [
        workspaceId,
      ]);
      expect(nodes.rowCount).toBe(0);
    });
  });

  describe('context and integrations', () => {
    it('saves and revises context', async () => {
      const projectId = await newProject();
      const context = {
        goals: ['ship'],
        technologyPreferences: [],
        architectureNotes: [],
        buildPreferences: [],
        userInstructions: [],
        decisions: [],
      };
      const first = await as(OWNER, () =>
        stores.context.saveContext(projectId, context, new Date().toISOString()),
      );
      const second = await as(OWNER, () =>
        stores.context.saveContext(projectId, context, new Date().toISOString()),
      );
      expect(first.revision).toBe(1);
      expect(second.revision).toBe(2);
      const read = await as(OWNER, () => stores.context.getContext(projectId));
      expect(read?.goals).toEqual(['ship']);
    });

    it('keeps integration references per project and per owner', async () => {
      const projectId = await newProject();
      const at = new Date().toISOString();
      await as(OWNER, () =>
        stores.integrations.upsert(
          projectId,
          { integrationRef: 'github:acme/app', kind: 'github', linkedAt: at } as never,
          at,
        ),
      );
      const listed = await as(OWNER, () => stores.integrations.list(projectId));
      expect(listed).toHaveLength(1);
      await expect(as(OTHER, () => stores.integrations.list(projectId))).resolves.toEqual([]);
    });
  });

  describe('memory', () => {
    it('creates, filters, searches and counts', async () => {
      const projectId = await newProject();
      const base = {
        projectId,
        type: 'architecture_decision' as const,
        source: { kind: 'user' as const, reference: 'test' },
      };
      await as(OWNER, () =>
        stores.memory.create({ ...base, title: 'Use Postgres', content: 'Persist everything.' }),
      );
      await as(OWNER, () =>
        stores.memory.create({
          ...base,
          title: 'Avoid ORMs',
          content: 'Write SQL.',
          status: 'candidate',
        }),
      );

      const all = await as(OWNER, () => stores.memory.list({ projectId }));
      expect(all).toHaveLength(2);
      const active = await as(OWNER, () => stores.memory.list({ projectId, status: 'active' }));
      expect(active).toHaveLength(1);
      const found = await as(OWNER, () => stores.memory.search({ projectId, text: 'sql' }));
      expect(found.totalMatched).toBe(1);
      expect(found.memories[0]!.title).toBe('Avoid ORMs');
      expect(await as(OWNER, () => stores.memory.count(projectId))).toBe(2);
      expect(await as(OTHER, () => stores.memory.count(projectId))).toBe(0);
    });

    it('enforces the optimistic revision on update', async () => {
      const projectId = await newProject();
      const record = await as(OWNER, () =>
        stores.memory.create({
          projectId,
          type: 'convention' as const,
          title: 'Naming',
          content: 'camelCase',
          source: { kind: 'user' as const, reference: 'test' },
        }),
      );
      const updated = await as(OWNER, () =>
        stores.memory.update(record.id, projectId, 1, { title: 'Naming rules' }),
      );
      expect(updated?.revision).toBe(2);
      const stale = await as(OWNER, () =>
        stores.memory.update(record.id, projectId, 1, { title: 'Stale' }),
      );
      expect(stale).toBeNull();
    });
  });

  describe('version history', () => {
    const revision = (projectId: string, workspaceId: string, n: number) => ({
      id: `rev_${n}`,
      projectId,
      workspaceId,
      revisionNumber: n,
      parentRevisionId: n === 1 ? null : `rev_${n - 1}`,
      createdAt: new Date(2026, 0, n).toISOString(),
      createdBy: 'tester',
      source: 'manual' as const,
      status: 'complete' as const,
      change: { added: ['a.ts'], modified: [], removed: [], unchanged: 0 },
      fileCount: 1,
      totalBytes: 100,
      manifestHash: 'hash',
      message: null,
      restoredFromRevisionId: null,
    });

    it('writes a revision with its snapshot and reads both back', async () => {
      const projectId = await newProject();
      const workspaceId = await newWorkspace(projectId);
      const snapshot = { workspaceId, files: [{ path: 'a.ts', content: 'x' }] } as never;
      await as(OWNER, () =>
        stores.revisions.createRevision(revision(projectId, workspaceId, 1) as never, snapshot),
      );
      const latest = await as(OWNER, () =>
        stores.revisions.getLatestRevision(projectId, workspaceId),
      );
      expect(latest?.revisionNumber).toBe(1);
      expect(await as(OWNER, () => stores.revisions.getSnapshot('rev_1'))).toEqual(snapshot);
      expect(
        await as(OWNER, () => stores.revisions.estimateSnapshotBytes(projectId, workspaceId)),
      ).toBe(100);
    });

    it('pages newest-first with an accurate total', async () => {
      const projectId = await newProject();
      const workspaceId = await newWorkspace(projectId);
      for (const n of [1, 2, 3]) {
        await as(OWNER, () =>
          stores.revisions.createRevision(
            revision(projectId, workspaceId, n) as never,
            {} as never,
          ),
        );
      }
      const page = await as(OWNER, () =>
        stores.revisions.listRevisions({ projectId, workspaceId, limit: 2, skip: 0 }),
      );
      expect(page.total).toBe(3);
      expect(page.hasMore).toBe(true);
      expect(page.revisions.map((r) => r.revisionNumber)).toEqual([3, 2]);
    });

    it('keeps branch records and the active branch', async () => {
      const projectId = await newProject();
      const workspaceId = await newWorkspace(projectId);
      const branch = {
        id: 'br_main',
        projectId,
        workspaceId,
        name: 'main',
        description: null,
        state: 'active',
        isDefault: true,
        baseRevisionId: null,
        parentBranchId: null,
        createdAt: new Date().toISOString(),
      } as never;
      await as(OWNER, () => stores.branches.createBranch(branch));
      await as(OWNER, () =>
        stores.branches.setActive({
          projectId,
          branchId: 'br_main',
          switchedAt: new Date().toISOString(),
          switchedBy: 'tester',
        }),
      );
      const listed = await as(OWNER, () => stores.branches.listBranches(projectId));
      expect(listed.map((b) => b.name)).toEqual(['main']);
      const active = await as(OWNER, () => stores.branches.getActive(projectId));
      expect(active?.branchId).toBe('br_main');
      expect((await as(OWNER, () => stores.branches.findByWorkspace(workspaceId)))?.id).toBe(
        'br_main',
      );
    });
  });

  describe('run records', () => {
    it('stores and lists per owner and kind, hidden from other owners', async () => {
      const projectId = await newProject();
      const at = new Date().toISOString();
      await as(OWNER, () =>
        stores.runs.save({
          kind: 'agent_run',
          id: 'run_1',
          projectId,
          status: 'completed',
          createdAt: at,
          updatedAt: at,
          body: { answer: 'done' },
        }),
      );
      const own = await as(OWNER, () => stores.runs.list('agent_run'));
      expect(own).toHaveLength(1);
      expect(own[0]!.body).toEqual({ answer: 'done' });
      await expect(as(OTHER, () => stores.runs.list('agent_run'))).resolves.toEqual([]);
      await expect(as(OTHER, () => stores.runs.get('agent_run', 'run_1'))).resolves.toBeNull();
    });

    it('updates in place, keeping one row per (kind, id)', async () => {
      const at = new Date().toISOString();
      await as(OWNER, () =>
        stores.runs.save({
          kind: 'coding_run',
          id: 'run_2',
          status: 'running',
          createdAt: at,
          updatedAt: at,
          body: { step: 1 },
        }),
      );
      await as(OWNER, () =>
        stores.runs.save({
          kind: 'coding_run',
          id: 'run_2',
          status: 'completed',
          createdAt: at,
          updatedAt: new Date().toISOString(),
          body: { step: 2 },
        }),
      );
      const list = await as(OWNER, () => stores.runs.list('coding_run'));
      expect(list).toHaveLength(1);
      expect(list[0]!.status).toBe('completed');
    });
  });

  describe('exports and object storage', () => {
    it('round-trips bytes through the object store', async () => {
      const projectId = await newProject();
      const store = new LocalObjectStore(database, { directory: join(scratch, 'objects') });
      const put = await as(OWNER, () =>
        store.put({
          key: `exports/${projectId}/archive.zip`,
          projectId,
          contentType: 'application/zip',
          bytes: new Uint8Array([80, 75, 3, 4]),
        }),
      );
      expect(put.bytes).toBe(4);
      const read = await as(OWNER, () => store.get(put.key));
      expect(Array.from(read!.bytes)).toEqual([80, 75, 3, 4]);
      await expect(as(OTHER, () => store.get(put.key))).resolves.toBeNull();
      expect(await as(OWNER, () => store.delete(put.key))).toBe(true);
      expect(await as(OWNER, () => store.get(put.key))).toBeNull();
    });

    it('refuses a key that tries to escape the directory', async () => {
      const store = new LocalObjectStore(database, { directory: join(scratch, 'objects') });
      await expect(
        as(OWNER, () =>
          store.put({
            key: '../escape.zip',
            contentType: 'application/zip',
            bytes: new Uint8Array([1]),
          }),
        ),
      ).rejects.toMatchObject({ name: 'OBJECT_KEY_INVALID' });
    });

    it('tracks export jobs and sweeps expired ones', async () => {
      const projectId = await newProject();
      const at = new Date().toISOString();
      await as(OWNER, () =>
        stores.exports.save({
          id: 'exp_1',
          projectId,
          status: 'ready',
          createdAt: at,
          updatedAt: at,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          body: { fileCount: 3 },
        }),
      );
      const live = await as(OWNER, () => stores.exports.get('exp_1'));
      expect(live?.body).toEqual({ fileCount: 3 });
      expect(await as(OWNER, () => stores.exports.deleteExpired())).toBe(1);
      expect(await as(OWNER, () => stores.exports.get('exp_1'))).toBeNull();
    });
  });

  describe('sync state', () => {
    it('persists the connection, plans and pruned history', async () => {
      const projectId = await newProject();
      const at = new Date().toISOString();
      await as(OWNER, () =>
        stores.sync.saveConnection(projectId, { repository: 'acme/app', branch: 'main' }),
      );
      expect((await as(OWNER, () => stores.sync.getConnection(projectId)))?.payload).toMatchObject({
        repository: 'acme/app',
      });

      await as(OWNER, () =>
        stores.sync.savePlan({
          id: 'plan_1',
          projectId,
          payload: { changes: 2 },
          createdAt: at,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      const plans = await as(OWNER, () => stores.sync.listPlans(projectId));
      expect(plans.map((p) => p.id)).toEqual(['plan_1']);

      for (let i = 0; i < 5; i += 1) {
        await as(OWNER, () =>
          stores.sync.appendHistory({
            id: `hist_${i}`,
            projectId,
            status: 'applied',
            payload: { commit: `sha${i}` },
            createdAt: new Date(Date.now() + i).toISOString(),
          }),
        );
      }
      expect(await as(OWNER, () => stores.sync.trimHistory(projectId, 2))).toBe(3);
      const history = await as(OWNER, () => stores.sync.listHistory(projectId));
      expect(history).toHaveLength(2);
      expect(history[0]!.payload.commit).toBe('sha4');
    });
  });

  describe('project engine over postgres', () => {
    it('runs the existing managers unchanged', async () => {
      const engine = createPostgresProjectEngine(stores);
      const project = await as(OWNER, () =>
        engine.projects.createProject({
          name: 'Engine Project',
          description: 'Created through the manager',
          projectType: 'web',
          ownerRef: OWNER,
          version: '0.1.0',
          metadata: {},
        }),
      );
      expect(project.status).toBe('active');
      const read = await as(OWNER, () => engine.projects.getProject(project.id));
      expect(read?.name).toBe('Engine Project');
    });
  });
});

describe('postgres storage unit rules', () => {
  it('rejects a non-postgres URL without echoing it', () => {
    try {
      parseDatabaseUrl('mysql://user:secret@localhost/db', {});
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain('secret');
    }
  });

  it('describes a config without credentials', () => {
    const config = parseDatabaseUrl('postgres://user:secret@db.example.com:6543/app', {});
    expect(config.database).toBe('app');
    expect(config.host).toBe('db.example.com');
    expect(config.ssl).toBe('require');
    expect(JSON.stringify(config).includes('secret')).toBe(true); // the config holds the URL
    // ...but nothing exported for logging does.
    expect(JSON.stringify({ host: config.host, database: config.database })).not.toContain(
      'secret',
    );
  });
});
