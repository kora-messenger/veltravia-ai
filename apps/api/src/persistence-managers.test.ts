/**
 * Restart persistence, manager by manager.
 *
 * The claim being tested is narrow and specific: after an export, a run, or a
 * GitHub connection is created, a SECOND app instance - new managers, new
 * caches, new mirror, same database - can read it back. Nothing here asserts
 * that a live run can be resumed in another process; it cannot, and the API
 * says so.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`; CI provides postgres:16.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithOwner } from '@veltravia/storage-postgres';
import { DurableState } from './durable-state.js';
import { createPersistence, type Persistence } from './persistence.js';
import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';

const databaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = databaseUrl === '' ? describe.skip : describe;

// A real directory: the local object store refuses to invent one.
let archiveDir = '';

function makeApp(persistence: Persistence): FastifyInstance {
  return buildApp({
    persistence,
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
}

describeDb('managers survive a restart', () => {
  let first: Persistence;
  let app: FastifyInstance;
  let reopened: Persistence;
  let reopenedApp: FastifyInstance;

  const owner = 'restart-owner';

  beforeAll(async () => {
    archiveDir = await mkdtemp(join(tmpdir(), 'veltravia-archives-'));
    first = await createPersistence({ url: databaseUrl, archiveDirectory: archiveDir });
    app = makeApp(first);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await reopenedApp?.close();
  });

  async function seedProject(): Promise<{ projectId: string; workspaceId: string }> {
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { name: 'Durable restart', projectType: 'web' },
    });
    expect(project.statusCode).toBe(201);
    const { id: projectId } = project.json() as { id: string };

    const workspace = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workspaces`,
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { name: 'main' },
    });
    expect(workspace.statusCode).toBe(201);
    const { id: workspaceId } = workspace.json() as { id: string };

    const directory = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/directories`,
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { path: 'src' },
    });
    expect([201, 200]).toContain(directory.statusCode);

    const file = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/files`,
      headers: { 'x-veltravia-owner-ref': owner },
      payload: { path: 'src/app.ts', content: 'export const answer = 42;\n' },
    });
    expect(file.statusCode).toBe(201);

    return { projectId, workspaceId };
  }

  /** Everything the second instance needs, then the instance itself. */
  async function reopen(): Promise<void> {
    if (reopenedApp !== undefined) await reopenedApp.close();
    reopened = await createPersistence({ url: databaseUrl, archiveDirectory: archiveDir });
    reopenedApp = makeApp(reopened);
    await reopenedApp.ready();
  }

  it('serves an export created by the previous instance, bytes included', async () => {
    const { projectId } = await seedProject();

    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/exports`,
      headers: { 'x-veltravia-owner-ref': owner },
      payload: {},
    });
    expect([200, 201]).toContain(created.statusCode);
    const exportId = (created.json() as { exportId: string }).exportId;
    expect(exportId).toBeTruthy();

    await reopen();

    const listed = await reopenedApp.inject({
      method: 'GET',
      url: `/api/exports?projectId=${projectId}`,
      headers: { 'x-veltravia-owner-ref': owner },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { exports: { exportId: string }[] };
    expect(body.exports.map((item) => item.exportId)).toContain(exportId);

    const download = await reopenedApp.inject({
      method: 'GET',
      url: `/api/exports/${exportId}/download`,
      headers: { 'x-veltravia-owner-ref': owner },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    // A ZIP that opens: the local header of the first entry.
    expect(download.rawPayload.subarray(0, 2).toString()).toBe('PK');
  }, 60_000);

  it("does not hand a previous instance's export to another owner", async () => {
    const listed = await reopenedApp.inject({
      method: 'GET',
      url: '/api/exports',
      headers: { 'x-veltravia-owner-ref': 'restart-intruder' },
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { exports: unknown[] }).exports).toEqual([]);
  });

  it('keeps a GitHub connection, and the base a later sync compares against', async () => {
    const { projectId } = await seedProject();
    const states: DurableState[] = [first.durable!, reopened.durable!];
    const connection = {
      projectId,
      owner,
      repository: 'owner/repo',
      branch: 'main',
      connectedAt: '2026-11-06T10:00:00.000Z',
      lastSyncedCommit: 'abc123',
      lastSyncedAt: '2026-11-06T10:05:00.000Z',
    };
    await runWithOwner(owner, async () => {
      states[0]!.syncStore.putConnection(owner, connection);
      states[0]!.syncStore.putBase(owner, projectId, new Map([['src/app.ts', 'hash-one']]));
      await states[0]!.flush();
    });

    await reopen();
    const seeds = await runWithOwner(owner, () => reopened.durable!.prepare(owner));
    void seeds;
    const read = await runWithOwner(owner, async () => ({
      connection: reopened.durable!.syncStore.getConnection(owner, projectId),
      base: reopened.durable!.syncStore.getBase(owner, projectId),
    }));
    expect(read.connection?.repository).toBe('owner/repo');
    expect(read.connection?.lastSyncedCommit).toBe('abc123');
    expect([...(read.base ?? new Map())]).toEqual([['src/app.ts', 'hash-one']]);
  }, 60_000);

  it('keeps the record of a run, readable after the process that ran it is gone', async () => {
    const { projectId } = await seedProject();
    const runId = 'run-restart-1';
    await runWithOwner(owner, async () => {
      first.durable!.rememberRun('coding', {
        id: runId,
        projectId,
        status: 'completed',
        createdAt: '2026-11-06T10:00:00.000Z',
        updatedAt: '2026-11-06T10:02:00.000Z',
      });
      await first.durable!.flush();
    });

    await reopen();

    const read = await reopenedApp.inject({
      method: 'GET',
      url: `/api/run-records/coding/${runId}`,
      headers: { 'x-veltravia-owner-ref': owner },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json() as { status: string; live: boolean; view: { id: string } };
    expect(body.status).toBe('completed');
    expect(body.view.id).toBe(runId);
    // History, not a control surface: the run itself is not resumable here.
    expect(body.live).toBe(false);

    const foreign = await reopenedApp.inject({
      method: 'GET',
      url: `/api/run-records/coding/${runId}`,
      headers: { 'x-veltravia-owner-ref': 'restart-intruder' },
    });
    expect(foreign.statusCode).toBe(404);
    expect((foreign.json() as { error: { code: string } }).error.code).toBe('RUN_RECORD_NOT_FOUND');
  }, 60_000);
});
