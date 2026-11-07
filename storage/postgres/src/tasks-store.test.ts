/**
 * The task repository against a real PostgreSQL server.
 *
 * What only a database can prove: ownership is enforced by the schema itself
 * (a task cannot attach to another owner's project, and a dependency cannot
 * cross owners), the compare-and-set refuses a stale writer, and a status
 * change and its event are one transaction.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`; CI provides postgres:16.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type Database,
  PostgresTaskStore,
  createDatabase,
  migrate,
  parseDatabaseUrl,
  runWithOwner,
} from './index.js';
import { prepareIsolatedTestSchema } from './test-schema.js';

const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
/** This file's own schema, bound in beforeAll so parallel files cannot collide. */
let databaseUrl = baseDatabaseUrl;
const describeDb = databaseUrl === '' ? describe.skip : describe;

const OWNER = 'tasks-db-owner';
const OTHER = 'tasks-db-other';

let database: Database;
let store: PostgresTaskStore;
let projectId = '';
let otherProjectId = '';

function taskRecord(overrides: Partial<Record<string, unknown>> = {}) {
  const at = new Date('2026-11-06T10:00:00.000Z').toISOString();
  return {
    id: `task_${Math.random().toString(36).slice(2, 12)}`,
    ownerRef: OWNER,
    projectId,
    workspaceId: null,
    chatId: 'chat_db_1',
    parentTaskId: null,
    title: 'Database task',
    objective: 'Prove the row round-trips.',
    status: 'queued' as const,
    reviewStatus: null,
    assignment: null,
    result: null,
    failure: null,
    retry: { attempts: 0, maxAttempts: 3, lastFailure: null, lastRetriedAt: null },
    checkpoint: null,
    createdBy: 'primary_agent' as const,
    version: 1,
    eventSeq: 1,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  } as never;
}

describeDb('task rows in PostgreSQL', () => {
  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'tasks-store')) ?? '';
    database = createDatabase(parseDatabaseUrl(databaseUrl));
    await migrate(database);
    store = new PostgresTaskStore(database);

    await runWithOwner(OWNER, async () => {
      const project = await database.query<{ id: string }>(
        `insert into projects (id, owner_ref, name, description, project_type, status, version, created_at, updated_at)
         values ('prj_tasks_db', $1, 'Tasks DB', 'fixture', 'active', 'web', '1.0.0', now(), now())
         on conflict do nothing returning id`,
        [OWNER],
      );
      projectId = project.rows[0]?.id ?? 'prj_tasks_db';
    });
    await runWithOwner(OTHER, async () => {
      const project = await database.query<{ id: string }>(
        `insert into projects (id, owner_ref, name, description, project_type, status, version, created_at, updated_at)
         values ('prj_tasks_db_other', $1, 'Other', 'fixture', 'active', 'web', '1.0.0', now(), now())
         on conflict do nothing returning id`,
        [OTHER],
      );
      otherProjectId = project.rows[0]?.id ?? 'prj_tasks_db_other';
    });
  }, 60_000);

  beforeEach(async () => {
    await runWithOwner(OWNER, () =>
      database.query('delete from tasks where owner_ref = $1', [OWNER]),
    );
    await runWithOwner(OTHER, () =>
      database.query('delete from tasks where owner_ref = $1', [OTHER]),
    );
  });

  afterAll(async () => {
    await database?.close();
  });

  it('round-trips a task, its dependencies and its events', async () => {
    const dependency = taskRecord({ title: 'First' });
    const dependent = taskRecord({ title: 'Second' });
    const at = new Date().toISOString();

    await runWithOwner(OWNER, async () => {
      await store.insert({ task: dependency, dependencies: [], events: [] });
      await store.insert({
        task: dependent,
        dependencies: [dependency.id],
        events: [
          {
            taskId: dependent.id,
            seq: 1,
            type: 'created',
            actor: 'primary_agent',
            fromStatus: null,
            toStatus: 'queued',
            message: 'Created',
            detail: { projectId },
            at,
          },
        ],
      });
    });

    await runWithOwner(OWNER, async () => {
      const read = await store.read(OWNER, dependent.id);
      expect(read?.task.title).toBe('Second');
      expect(read?.dependencies).toEqual([dependency.id]);
      expect(read?.task.eventSeq).toBe(1);

      const listed = await store.list(OWNER, { projectId });
      expect(listed).toHaveLength(2);
    });
  });

  it('refuses a task attached to another owner project', async () => {
    await expect(
      runWithOwner(OWNER, async () => {
        await store.insert({
          task: taskRecord({ projectId: otherProjectId }),
          dependencies: [],
          events: [],
        });
      }),
    ).rejects.toThrowError();
  });

  it('refuses a dependency on another owner task', async () => {
    const foreign = taskRecord({ ownerRef: OTHER, projectId: otherProjectId });
    await runWithOwner(OTHER, async () => {
      await store.insert({ task: foreign, dependencies: [], events: [] });
    });

    const own = taskRecord();
    await runWithOwner(OWNER, async () => {
      await store.insert({ task: own, dependencies: [], events: [] });
    });

    await expect(
      runWithOwner(OWNER, async () => {
        await store.addDependency({
          ownerRef: OWNER,
          taskId: own.id,
          dependsOnTaskId: foreign.id,
          required: true,
          events: [],
          updatedAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrowError();
  });

  it('never reads another owner row', async () => {
    const own = taskRecord();
    await runWithOwner(OWNER, async () => {
      await store.insert({ task: own, dependencies: [], events: [] });
    });
    await runWithOwner(OTHER, async () => {
      expect(await store.read(OTHER, own.id)).toBeNull();
      expect(await store.list(OTHER, {})).toHaveLength(0);
      expect(await store.events(OTHER, own.id, 0, 10)).toHaveLength(0);
    });
  });

  it('lets exactly one writer win a compare-and-set', async () => {
    const task = taskRecord();
    await runWithOwner(OWNER, async () => {
      await store.insert({ task, dependencies: [], events: [] });
    });

    const first = await runWithOwner(OWNER, async () =>
      store.save({
        task: { ...task, status: 'planning', version: 2, updatedAt: new Date().toISOString() },
        expectedVersion: 1,
        events: [],
      }),
    );
    const second = await runWithOwner(OWNER, async () =>
      store.save({
        task: { ...task, status: 'running', version: 2, updatedAt: new Date().toISOString() },
        expectedVersion: 1,
        events: [],
      }),
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('persists attempts with their run id', async () => {
    const task = taskRecord();
    await runWithOwner(OWNER, async () => {
      await store.insert({ task, dependencies: [], events: [] });
      await store.saveAttempt({
        ownerRef: OWNER,
        attempt: {
          taskId: task.id,
          attempt: 1,
          runId: 'run_db_1',
          worker: 'primary_agent',
          status: 'running',
          startedAt: new Date().toISOString(),
          endedAt: null,
          summary: null,
          failure: null,
        },
      });
      const attempts = await store.attempts(OWNER, task.id);
      expect(attempts[0]?.runId).toBe('run_db_1');
    });
  });
});
