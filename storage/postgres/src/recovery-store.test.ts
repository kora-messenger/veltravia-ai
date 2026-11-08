/**
 * Recovery cases against a real PostgreSQL server (Step 49).
 *
 * What only a database can prove: the dashboard's filters are predicates in
 * SQL, not a client-side pass over a truncated page, and another owner's rows
 * are invisible to every filter.
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
import { prepareIsolatedTestSchema } from './test-schema.js';
import type { RecoveryCaseRecord } from '@veltravia/recovery-core';

const RUN = Math.random().toString(36).slice(2, 8);
const id = (base: string): string => `${base}_${RUN}`;

const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
let databaseUrl = baseDatabaseUrl;
const describeDb = databaseUrl === '' ? describe.skip : describe;

const owner = 'recovery-db-owner';
const other = 'recovery-db-other';

function record(overrides: Partial<RecoveryCaseRecord> & { id: string }): RecoveryCaseRecord {
  const at = new Date().toISOString();
  return {
    ownerRef: owner,
    projectId: id('prj_recovery_db'),
    taskId: id('tsk_recovery_db'),
    workerId: id('wkr_recovery_db'),
    workerType: 'backend',
    status: 'open',
    diagnosis: null,
    observation: {
      projectId: id('prj_recovery_db'),
      taskId: id('tsk_recovery_db'),
      workerId: id('wkr_recovery_db'),
      workerType: 'backend',
      workerStatus: 'awaiting_review',
      failure: null,
      declaration: {
        deliverables: ['src/settings/load.ts'],
        acceptanceCriteria: ['loads settings'],
        scope: ['src/settings'],
        allowedTools: ['project.read'],
        permissions: { readProject: true, writeProject: true, runTools: false, network: false },
        limits: { maxDurationMs: 60_000, maxToolCalls: 20, maxDeliverables: 3 },
        checkpoints: [],
        cancellationConditions: [],
        reporting: [],
        primaryRunId: null,
      },
      deliverables: { declared: ['src/settings/load.ts'], produced: [], missing: [] },
      verification: null,
      changeSet: null,
      conflict: null,
      toolFailures: [],
      revision: { base: null, now: null },
    } as RecoveryCaseRecord['observation'],
    limits: {
      maxAttempts: 3,
      maxTotalDurationMs: 600_000,
      maxReassignments: 1,
      maxModelCalls: 20,
      maxConcurrentRepairs: 1,
      backoffBaseMs: 1000,
      backoffCeilingMs: 30_000,
    },
    attempts: 0,
    reassignments: 0,
    modelCalls: 0,
    nextAttemptNotBefore: null,
    preservedChangeSets: [],
    stoppedReason: null,
    escalation: null,
    verification: null,
    revisionAtStart: null,
    revisionAtRecovery: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
    eventSeq: 0,
    ...overrides,
  };
}

function withDiagnosis(
  caseId: string,
  primary: 'missing_deliverables' | 'verification_failed' | null,
): RecoveryCaseRecord {
  return record({
    id: caseId,
    diagnosis:
      primary === null
        ? null
        : ({
            primary,
            classification: 'permanent',
            findings: [],
            likelyCause: 'declared work was not produced',
            affectedDeliverables: ['src/settings/load.ts'],
            recommendedAction: 'repair_worker',
            requiredPermissions: [],
            confidence: 'medium',
            reason: 'one evidence source',
            evidence: [{ kind: 'worker_result', ref: 'wkr', detail: 'nothing produced' }],
            insufficient: false,
          } as RecoveryCaseRecord['diagnosis']),
  });
}

describeDb('recovery cases in PostgreSQL', () => {
  let database: Database;
  let stores: PostgresStores;

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'recovery-store')) ?? '';
    database = createDatabase(parseDatabaseUrl(databaseUrl, { maxConnections: 4 }));
    await migrate(database);
    stores = createPostgresStores(database);

    await runWithOwner(owner, async () => {
      await stores.recovery.insertCase(withDiagnosis(id('case_open'), 'missing_deliverables'), []);
      await stores.recovery.insertCase(
        record({
          id: id('case_recovered'),
          status: 'recovered',
          attempts: 1,
          verification: {
            runId: id('run_passed'),
            status: 'passed',
            executed: true,
            executedCount: 1,
            failedOperations: [],
            evidence: [],
          },
        }),
        [],
      );
      await stores.recovery.insertCase(
        record({
          id: id('case_failed_verification'),
          status: 'escalated',
          attempts: 3,
          verification: {
            runId: id('run_failed'),
            status: 'failed',
            executed: true,
            executedCount: 2,
            failedOperations: ['unit'],
            evidence: [],
          },
        }),
        [],
      );
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it('filters by status, category, worker and verification in SQL', async () => {
    await runWithOwner(owner, async () => {
      const open = await stores.recovery.listCases(owner, { status: ['open'] });
      expect(open.map((entry) => entry.id)).toEqual([id('case_open')]);

      const permanent = await stores.recovery.listCases(owner, {
        category: ['missing_deliverables'],
      });
      expect(permanent.map((entry) => entry.id)).toEqual([id('case_open')]);

      const passed = await stores.recovery.listCases(owner, { verification: 'passed' });
      expect(passed.map((entry) => entry.id)).toEqual([id('case_recovered')]);

      const notRun = await stores.recovery.listCases(owner, { verification: 'not_run' });
      expect(notRun.map((entry) => entry.id)).toEqual([id('case_open')]);

      const failed = await stores.recovery.listCases(owner, { verification: 'failed' });
      expect(failed.map((entry) => entry.id)).toEqual([id('case_failed_verification')]);

      const byWorker = await stores.recovery.listCases(owner, {
        workerId: id('wkr_recovery_db'),
      });
      expect(byWorker).toHaveLength(3);

      const future = new Date(Date.now() + 3_600_000).toISOString();
      const after = await stores.recovery.listCases(owner, { createdAfter: future });
      expect(after).toHaveLength(0);
    });
  });

  it("does not show one owner's cases to another", async () => {
    await runWithOwner(other, async () => {
      const cases = await stores.recovery.listCases(other, {});
      expect(cases).toHaveLength(0);
    });
  });
});
