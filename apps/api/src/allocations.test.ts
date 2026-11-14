/**
 * Workspace credit allocation over HTTP (Step 62).
 *
 * The suite proves the promises a person relies on:
 *
 *  - a pool is a ceiling: allocations cannot add up to more than it holds;
 *  - credit is reserved before work, so two runs cannot both be told there is
 *    room for the last of an allowance;
 *  - an allocation is per workspace and per owner: another account cannot read
 *    it, and a forged workspace id is a 404 and never a lookup;
 *  - the two credit categories never mix.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from './server.js';

const OWNER = 'alloc-owner';
const OTHER = 'alloc-other';

interface Seeded {
  readonly projectId: string;
  readonly workspaceId: string;
}

async function seedWorkspace(app: FastifyInstance, owner = OWNER): Promise<Seeded> {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { 'x-veltravia-owner-ref': owner },
    payload: { name: 'Allocation Fixture', description: 'Fixture', projectType: 'web' },
  });
  expect(project.statusCode).toBe(201);
  const projectId = (project.json() as { id: string }).id;
  // A project does not create a workspace by itself, so the fixture makes one and
  // uses its id: the same route the product uses.
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    headers: { 'x-veltravia-owner-ref': owner },
    payload: { name: 'Primary' },
  });
  expect(workspace.statusCode).toBe(201);
  return { projectId, workspaceId: (workspace.json() as { id: string }).id };
}

describe('workspace credit allocation over HTTP', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp({ env: {} as NodeJS.ProcessEnv });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('publishes its capabilities without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/allocations/capabilities' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      categories: string[];
      policies: string[];
      limits: { maxPoolCredits: number };
    };
    expect(body.categories).toEqual(['ai_tokens', 'integration_credits']);
    expect(body.policies).toContain('temporary');
    expect(body.limits.maxPoolCredits).toBeGreaterThan(0);
  });

  it('sets a pool, allocates from it and reports what is left', async () => {
    const { workspaceId } = await seedWorkspace(app);
    const pool = await app.inject({
      method: 'PUT',
      url: '/api/allocations/pool',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { workspaceId, category: 'ai_tokens', total: 5_000 },
    });
    expect(pool.statusCode).toBe(200);

    const allocation = await app.inject({
      method: 'POST',
      url: '/api/allocations',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        workspaceId,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: 'prj_fixture',
        amount: 2_000,
      },
    });
    expect(allocation.statusCode).toBe(201);
    const allocationId = (allocation.json() as { allocation: { id: string } }).allocation.id;

    const summary = await app.inject({
      method: 'GET',
      url: `/api/allocations?workspaceId=${workspaceId}`,
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as {
      categories: {
        category: string;
        pool: { total: number; allocated: number; available: number };
        allocations: { id: string; available: number }[];
      }[];
    };
    const ai = body.categories.find((entry) => entry.category === 'ai_tokens');
    expect(ai?.pool.total).toBe(5_000);
    expect(ai?.pool.allocated).toBe(2_000);
    expect(ai?.pool.available).toBe(3_000);
    expect(ai?.allocations[0]?.id).toBe(allocationId);
    expect(ai?.allocations[0]?.available).toBe(2_000);

    // The integration lane is untouched by an AI-token allocation.
    const integration = body.categories.find((entry) => entry.category === 'integration_credits');
    expect(integration?.pool.total).toBe(0);
  });

  it('refuses an allocation beyond the pool', async () => {
    const { workspaceId } = await seedWorkspace(app);
    await app.inject({
      method: 'PUT',
      url: '/api/allocations/pool',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { workspaceId, category: 'ai_tokens', total: 100 },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/allocations',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        workspaceId,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: 'prj_big',
        amount: 500,
      },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { code: string; available: number };
    expect(body.code).toBe('POOL_EXCEEDED');
    expect(body.available).toBe(100);
  });

  it('refuses an allocation with no pool at all', async () => {
    const { workspaceId } = await seedWorkspace(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/allocations',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        workspaceId,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: 'prj_nopool',
        amount: 10,
      },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { code: string }).code).toBe('POOL_NOT_SET');
  });

  it('will not show another account a workspace it does not own', async () => {
    const { workspaceId } = await seedWorkspace(app);
    await app.inject({
      method: 'PUT',
      url: '/api/allocations/pool',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { workspaceId, category: 'ai_tokens', total: 1_000 },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/allocations?workspaceId=${workspaceId}`,
      headers: { 'x-veltravia-owner-ref': OTHER },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { code: string }).code).toBe('ALLOCATION_NOT_FOUND');
  });

  it('reserves credit and refuses the second run when the allowance is spent', async () => {
    const { workspaceId } = await seedWorkspace(app);
    await app.inject({
      method: 'PUT',
      url: '/api/allocations/pool',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { workspaceId, category: 'ai_tokens', total: 1_000 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/allocations',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        workspaceId,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: 'prj_gate',
        amount: 300,
      },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/allocations/authorize',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        workspaceId,
        category: 'ai_tokens',
        amount: 200,
        operationKey: 'op:first',
        operationKind: 'chat.message',
        projectId: 'prj_gate',
      },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { allowed: boolean }).allowed).toBe(true);

    const second = await app.inject({
      method: 'POST',
      url: '/api/allocations/authorize',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        workspaceId,
        category: 'ai_tokens',
        amount: 200,
        operationKey: 'op:second',
        operationKind: 'chat.message',
        projectId: 'prj_gate',
      },
    });
    const body = second.json() as { allowed: boolean; code: string };
    expect(body.allowed).toBe(false);
    expect(body.code).toBe('ALLOCATION_EXHAUSTED');
  });

  it('reports history for every movement', async () => {
    const { workspaceId } = await seedWorkspace(app);
    await app.inject({
      method: 'PUT',
      url: '/api/allocations/pool',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { workspaceId, category: 'ai_tokens', total: 1_000 },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/allocations',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        workspaceId,
        category: 'ai_tokens',
        targetKind: 'member',
        targetRef: 'ijezie',
        amount: 400,
      },
    });
    const allocationId = (created.json() as { allocation: { id: string } }).allocation.id;

    const increased = await app.inject({
      method: 'POST',
      url: `/api/allocations/${allocationId}/increase`,
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { amount: 100 },
    });
    expect(increased.statusCode).toBe(200);
    expect((increased.json() as { allocation: { allocated: number } }).allocation.allocated).toBe(
      500,
    );

    const history = await app.inject({
      method: 'GET',
      url: `/api/allocations/history?workspaceId=${workspaceId}&limit=20`,
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    const events = (history.json() as { events: { kind: string }[] }).events;
    expect(events.map((event) => event.kind)).toEqual(['increased', 'allocated', 'pool_set']);
  });

  it('distributes a budget across targets exactly', async () => {
    const { workspaceId } = await seedWorkspace(app);
    await app.inject({
      method: 'PUT',
      url: '/api/allocations/pool',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { workspaceId, category: 'ai_tokens', total: 3_000 },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/allocations/distribute',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        workspaceId,
        category: 'ai_tokens',
        policy: 'equal',
        budget: 900,
        targets: [
          { kind: 'project', ref: 'prj_a' },
          { kind: 'project', ref: 'prj_b' },
          { kind: 'project', ref: 'prj_c' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      planned: { unallocated: number; planned: { amount: number }[] };
      applied: { allocated: number }[];
    };
    expect(body.planned.unallocated).toBe(0);
    expect(body.applied).toHaveLength(3);
    const total = body.applied.reduce((sum, entry) => sum + entry.allocated, 0);
    expect(total).toBe(900);
  });
});
