/**
 * Worker records against a real PostgreSQL server.
 *
 * What only a database can prove:
 *  - a worker cannot attach to another owner's task (composite foreign key);
 *  - a task cannot hold two live workers, even if two writers race
 *    (partial unique index, not an application check);
 *  - the compare-and-set refuses a stale write.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  runWithOwner,
  createDatabase,
  parseDatabaseUrl,
  migrate,
  createPostgresStores,
  type Database,
  type PostgresStores,
} from './index.js';
import type { WorkerRecord, WorkerEvent, WorkerAssignment } from '@veltravia/worker-core';

const RUN = Math.random().toString(36).slice(2, 8);
const id = (base: string): string => `${base}_${RUN}`;

const databaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = databaseUrl === '' ? describe.skip : describe;

const owner = 'workers-db-owner';
const other = 'workers-db-other';

const assignment: WorkerAssignment = {
  objective: 'Implement the settings panel.',
  scope: ['src/settings'],
  exclusions: ['src/settings/secrets.ts'],
  deliverables: [
    { name: 'panel', kind: 'file', path: 'src/settings/panel.tsx', summary: 'The panel' },
  ],
  acceptanceCriteria: ['the panel renders'],
  allowedTools: ['project.read', 'project.write'],
  permissions: { readProject: true, writeProject: true, runTools: true, network: false },
  limits: { maxDurationMs: 60_000, maxToolCalls: 40, maxDeliverables: 5 },
  dependencies: [],
  checkpoints: ['after first render'],
  cancellationConditions: ['the owner cancels'],
  reporting: ['list files written'],
  primaryRunId: null,
  workerType: 'frontend',
};

function worker(id: string, taskId: string, status: WorkerRecord['status']): WorkerRecord {
  const at = new Date().toISOString();
  return {
    id,
    ownerRef: owner,
    taskId,
    parentTaskId: null,
    primaryRunId: null,
    workerType: 'frontend',
    status,
    assignment,
    resources: [{ kind: 'directory', path: 'src/settings' }],
    result: null,
    review: null,
    failure: null,
    attempts: 0,
    retryNotBefore: null,
    startedAt: null,
    endedAt: null,
    lastHeartbeatAt: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
    eventSeq: 0,
  };
}

function event(workerId: string, seq: number): WorkerEvent {
  return {
    workerId,
    seq,
    type: 'created',
    actor: 'primary_agent',
    at: new Date().toISOString(),
    fromStatus: null,
    toStatus: 'queued',
    message: null,
  };
}

describeDb('worker records in PostgreSQL', () => {
  let database: Database;
  let stores: PostgresStores;

  beforeAll(async () => {
    database = createDatabase(parseDatabaseUrl(databaseUrl, { maxConnections: 4 }));
    await migrate(database);
    stores = createPostgresStores(database);
    await runWithOwner(owner, async () => {
      await database.query(
        `insert into projects (id, owner_ref, name, description, project_type, status, version, created_at, updated_at)
         values ($1, $2, 'Workers DB', 'fixture', 'active', 'web', '1.0.0', now(), now())
         on conflict (id) do nothing`,
        [id('prj_workers_db'), owner],
      );
      await database.query(
        `insert into tasks (id, owner_ref, project_id, title, objective, status, version, created_at, updated_at)
         values ($1, $2, $3, 'Fixture', 'Fixture task', 'queued', 1, now(), now())
         on conflict (id, owner_ref) do nothing`,
        [id('tsk_workers_db'), owner, id('prj_workers_db')],
      );
      await database.query(
        `insert into tasks (id, owner_ref, project_id, title, objective, status, version, created_at, updated_at)
         values ($1, $2, $3, 'Fixture 2', 'Second task', 'queued', 1, now(), now())
         on conflict (id, owner_ref) do nothing`,
        [id('tsk_workers_db'), owner, id('prj_workers_db')],
      );
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it('writes, reads and lists a worker', async () => {
    await runWithOwner(owner, async () => {
      await stores.workers.insert(worker(id('wkr_a'), id('tsk_workers_db'), 'queued'), [
        event(id('wkr_a'), 1),
      ]);
      const read = await stores.workers.read(owner, id('wkr_a'));
      expect(read?.status).toBe('queued');
      expect(read?.assignment.objective).toContain('settings panel');
      const listed = await stores.workers.list(owner, { taskId: id('tsk_workers_db') });
      expect(listed.map((entry) => entry.id)).toContain(id('wkr_a'));
      const events = await stores.workers.events(owner, id('wkr_a'), 0, 10);
      expect(events).toHaveLength(1);
    });
  });

  it('refuses a second live worker for the same task', async () => {
    await runWithOwner(owner, async () => {
      await expect(
        stores.workers.insert(worker(id('wkr_dup'), id('tsk_workers_db'), 'running'), []),
      ).rejects.toBeDefined();
    });
  });

  it("refuses a worker that points at another owner's task", async () => {
    await runWithOwner(other, async () => {
      const foreign = {
        ...worker(id('wkr_foreign'), id('tsk_workers_db'), 'queued'),
        ownerRef: other,
      };
      await expect(stores.workers.insert(foreign, [])).rejects.toBeDefined();
    });
  });

  it('refuses a stale write', async () => {
    await runWithOwner(owner, async () => {
      const current = await stores.workers.read(owner, id('wkr_a'));
      expect(current).not.toBeNull();
      const saved = await stores.workers.save(
        { ...current!, status: 'assigned', version: current!.version + 1, eventSeq: 1 },
        current!.version,
        [],
      );
      expect(saved).toBe(true);
      const stale = await stores.workers.save(
        { ...current!, status: 'cancelled', version: current!.version + 1 },
        current!.version,
        [],
      );
      expect(stale).toBe(false);
    });
  });

  it('records a scheduling decision with its reasons', async () => {
    await runWithOwner(owner, async () => {
      await stores.workers.recordDecision({
        id: `dec_${Date.now().toString(36)}`,
        ownerRef: owner,
        at: new Date().toISOString(),
        limit: 2,
        active: 1,
        selected: [id('wkr_a')],
        skipped: [
          { workerId: id('wkr_b'), taskId: id('tsk_workers_db_2'), reason: 'limit_reached' },
        ],
      });
      const decisions = await stores.workers.decisions(owner, 5);
      expect(decisions[0]?.limit).toBe(2);
      expect(decisions[0]?.skipped[0]?.reason).toBe('limit_reached');
    });
  });

  it("hides another owner's worker", async () => {
    await runWithOwner(other, async () => {
      expect(await stores.workers.read(other, id('wkr_a'))).toBeNull();
      expect(await stores.workers.list(other, {})).toHaveLength(0);
    });
  });
});
