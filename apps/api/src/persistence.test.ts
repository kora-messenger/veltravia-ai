/**
 * The API running on PostgreSQL.
 *
 * These tests exist because "the repository works" is not the same claim as
 * "the server uses it". They boot the real Fastify app with a real database,
 * drive it through HTTP, and then look at the rows - so a missing owner scope,
 * a memory engine still being chosen, or readiness not noticing a dead database
 * all fail here rather than in production.
 *
 * Skipped without `VELTRAVIA_TEST_DATABASE_URL`; CI provides postgres:16.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prepareIsolatedTestSchema, runWithOwner } from '@veltravia/storage-postgres';
import { createPersistence, resolveDatabaseUrl, type Persistence } from './persistence.js';
import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';

const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
/** This file's own schema, bound in beforeAll so parallel files cannot collide. */
let databaseUrl = baseDatabaseUrl;
const describeDb = databaseUrl === '' ? describe.skip : describe;

describeDb('API on postgres', () => {
  let persistence: Persistence;
  let app: FastifyInstance;

  beforeAll(async () => {
    databaseUrl = (await prepareIsolatedTestSchema(baseDatabaseUrl, 'persistence')) ?? '';
    persistence = await createPersistence({ url: databaseUrl });
    app = buildApp({
      persistence,
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('chose postgres, not the in-memory engine', () => {
    expect(persistence.mode).toBe('postgres');
    expect(persistence.engine).not.toBeNull();
  });

  it('creates a project through HTTP and writes the row to the database', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': 'pg-owner-one' },
      payload: { name: 'Durable', description: 'Lives in postgres', projectType: 'web' },
    });
    expect(response.statusCode).toBe(201);
    // Project routes answer with the record itself, not an envelope.
    const created = response.json() as { id: string; name: string };
    expect(created.name).toBe('Durable');

    const rows = await runWithOwner('pg-owner-one', () => persistence.stores!.projects.list());
    const row = rows.find((project) => project.id === created.id);
    expect(row).toBeDefined();
    // The row carries the caller as owner, not a header echoed back.
    expect(row?.ownerRef).toBe('pg-owner-one');

    // And it is invisible to a query made as somebody else.
    const asOther = await runWithOwner('pg-owner-nine', () => persistence.stores!.projects.list());
    expect(asOther.map((project) => project.id)).not.toContain(created.id);
  });

  it("assigns every project to the caller and hides other owners' work", async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': 'pg-owner-two' },
    });
    expect(mine.statusCode).toBe(200);
    const body = mine.json() as { projects: { id: string }[] };

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': 'pg-owner-three' },
    });
    expect((theirs.json() as { projects: unknown[] }).projects).toEqual([]);

    // A second read for the same caller sees the same projects: the owner scope
    // is per request, not a process-wide value left over from the last one.
    const again = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': 'pg-owner-two' },
    });
    expect((again.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual(
      body.projects.map((p) => p.id),
    );
  });

  it('answers 404 for a project another owner owns', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': 'pg-owner-four' },
      payload: { name: 'Private', description: 'Not yours', projectType: 'backend' },
    });
    const id = (created.json() as { id: string }).id;

    const denied = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}`,
      headers: { 'x-veltravia-owner-ref': 'pg-owner-five' },
    });
    expect(denied.statusCode).toBe(404);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}`,
      headers: { 'x-veltravia-owner-ref': 'pg-owner-four' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('reports the database in readiness', async () => {
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    const body = ready.json() as { checks: { name: string; status: string }[] };
    const database = body.checks.find((check) => check.name === 'database');
    expect(database?.status).toBe('ok');
    // No credentials, hosts or paths in the readiness body.
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('survives a restart: a new process reads what the last one wrote', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': 'pg-owner-six' },
      payload: { name: 'Survives', description: 'Restart test', projectType: 'library' },
    });
    const id = (created.json() as { id: string }).id;

    // A second app instance with its own pool: exactly what a restart gives you.
    const second = await createPersistence({ url: databaseUrl });
    const secondApp = buildApp({
      persistence: second,
      deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    });
    await secondApp.ready();
    try {
      const read = await secondApp.inject({
        method: 'GET',
        url: `/api/projects/${id}`,
        headers: { 'x-veltravia-owner-ref': 'pg-owner-six' },
      });
      expect(read.statusCode).toBe(200);
      expect((read.json() as { name: string }).name).toBe('Survives');
    } finally {
      await secondApp.close();
    }
  });
});

describe('persistence selection', () => {
  it('prefers the product-specific variable and ignores empty values', () => {
    expect(resolveDatabaseUrl({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveDatabaseUrl({ DATABASE_URL: '  ' } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: 'postgres://a/b',
        VELTRAVIA_DATABASE_URL: 'postgres://c/d',
      } as NodeJS.ProcessEnv),
    ).toBe('postgres://c/d');
  });

  it('falls back to memory with no database configured, and says so', async () => {
    const persistence = await createPersistence({ url: null });
    expect(persistence.mode).toBe('memory');
    await expect(persistence.verify()).resolves.toBeUndefined();
    await persistence.close();
  });

  it('refuses a database URL that is not postgres, without echoing it', async () => {
    await expect(
      createPersistence({ url: 'mysql://user:hunter2@localhost/app' }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      createPersistence({ url: 'mysql://user:hunter2@localhost/app' }),
    ).rejects.toSatisfy((error: Error) => !error.message.includes('hunter2'));
  });
});
