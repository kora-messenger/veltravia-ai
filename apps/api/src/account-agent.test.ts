/**
 * The Personal Account Agent over HTTP (Step 62).
 *
 * What this suite is proving, in the order a person would meet it:
 *
 *  - the catalogue is readable and honest: a capability this build does not have
 *    is listed as unavailable with a reason, not offered;
 *  - a read runs under the caller's own identity;
 *  - a write really writes: the project it claims to create is there afterwards;
 *  - the identity cannot be borrowed: an argument naming an owner is refused;
 *  - a member cannot administer the workspace, and says so;
 *  - a sensitive action waits for a confirmation that is bound to its arguments;
 *  - the trail shows what happened, including refusals, and only to its owner.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from './server.js';

const OWNER = 'account-owner';
const OTHER = 'account-other';

interface Seed {
  readonly workspaceId: string;
  readonly projectId: string;
}

async function seed(app: FastifyInstance): Promise<Seed> {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { 'x-veltravia-owner-ref': OWNER },
    payload: { name: 'Agent Fixture', description: 'Fixture', projectType: 'web' },
  });
  const projectId = (project.json() as { id: string }).id;
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    headers: { 'x-veltravia-owner-ref': OWNER },
    payload: { name: 'Primary' },
  });
  return { projectId, workspaceId: (workspace.json() as { id: string }).id };
}

interface ActionResponse {
  status: string;
  result: { ok: boolean; summary: string; data?: unknown } | null;
  error: { code: string; message: string } | null;
  approval: { token: string; preview: string; risk: number } | null;
  auditId: string;
}

async function action(
  app: FastifyInstance,
  body: Record<string, unknown>,
  owner = OWNER,
  role?: string,
): Promise<ActionResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/account/actions',
    headers: {
      'x-veltravia-owner-ref': owner,
      ...(role === undefined ? {} : { 'x-veltravia-role': role }),
    },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ActionResponse;
}

describe('the personal account agent over HTTP', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp({ env: {} as NodeJS.ProcessEnv });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('publishes an honest catalogue', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/account/catalog',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      tools: {
        name: string;
        risk: number;
        availability: { available: boolean; reason?: string };
      }[];
      permissions: string[];
    };
    const names = body.tools.map((tool) => tool.name);
    expect(names).toContain('project.create');
    expect(names).toContain('allocation.allocate');
    expect(names).toContain('account.summary');
    const invite = body.tools.find((tool) => tool.name === 'member.invite');
    expect(invite?.availability.available).toBe(false);
    expect(invite?.availability.reason).toMatch(/membership/);
    expect(body.permissions).toContain('workspace:owner');
  });

  it('answers a question about the account', async () => {
    const outcome = await action(app, { tool: 'account.summary' });
    expect(outcome.status).toBe('executed');
    expect(outcome.result?.summary).toMatch(/plan/);
  });

  it('really creates the project it says it created', async () => {
    const outcome = await action(app, {
      tool: 'project.create',
      args: { name: 'Quarterly Research', projectType: 'web' },
      idempotencyKey: 'create-quarterly-research',
    });
    expect(outcome.status).toBe('executed');
    expect(outcome.result?.summary).toContain('Quarterly Research');

    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    const projects = (list.json() as { projects: { name: string }[] }).projects;
    expect(projects.map((project) => project.name)).toContain('Quarterly Research');
  });

  it('runs a repeated request once', async () => {
    const first = await action(app, {
      tool: 'project.create',
      args: { name: 'Only Once' },
      idempotencyKey: 'create-only-once',
    });
    const second = await action(app, {
      tool: 'project.create',
      args: { name: 'Only Once' },
      idempotencyKey: 'create-only-once',
    });
    expect(first.status).toBe('executed');
    expect(second.status).toBe('replayed');

    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    const named = (list.json() as { projects: { name: string }[] }).projects.filter(
      (project) => project.name === 'Only Once',
    );
    expect(named).toHaveLength(1);
  });

  it('refuses an argument that tries to name an account', async () => {
    const outcome = await action(app, {
      tool: 'project.create',
      args: { name: 'Forged', ownerRef: OTHER },
    });
    expect(outcome.status).toBe('refused');
    expect(outcome.error?.code).toBe('IDENTITY_IN_ARGUMENTS');
  });

  it('will not let a member administer the workspace', async () => {
    const seedResult = await seed(app);
    const outcome = await action(
      app,
      {
        tool: 'allocation.allocate',
        args: {
          workspaceId: seedResult.workspaceId,
          category: 'ai_tokens',
          targetKind: 'project',
          targetRef: seedResult.projectId,
          amount: 100,
        },
      },
      OWNER,
      'member',
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.error?.code).toBe('PERMISSION_DENIED');
  });

  it('waits for a confirmation before allocating credit, then does it once', async () => {
    const seedResult = await seed(app);
    await app.inject({
      method: 'PUT',
      url: '/api/allocations/pool',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { workspaceId: seedResult.workspaceId, category: 'ai_tokens', total: 1_000 },
    });

    const prepared = await action(app, {
      tool: 'allocation.allocate',
      args: {
        workspaceId: seedResult.workspaceId,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: seedResult.projectId,
        amount: 400,
      },
      idempotencyKey: 'allocate-400',
    });
    expect(prepared.status).toBe('awaiting_confirmation');
    expect(prepared.approval?.preview).toContain('Allocate');
    expect(prepared.approval?.risk).toBe(3);

    // Nothing exists until the person confirms.
    const before = await app.inject({
      method: 'GET',
      url: `/api/allocations/list?workspaceId=${seedResult.workspaceId}`,
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect((before.json() as { allocations: unknown[] }).allocations).toHaveLength(0);

    const confirmed = await action(app, {
      tool: 'allocation.allocate',
      args: {
        workspaceId: seedResult.workspaceId,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: seedResult.projectId,
        amount: 400,
      },
      approvalToken: prepared.approval?.token,
      idempotencyKey: 'allocate-400',
    });
    expect(confirmed.status).toBe('executed');

    const after = await app.inject({
      method: 'GET',
      url: `/api/allocations/list?workspaceId=${seedResult.workspaceId}`,
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    const allocations = (after.json() as { allocations: { allocated: number }[] }).allocations;
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.allocated).toBe(400);
  });

  it('will not reuse a confirmation for a different amount', async () => {
    const seedResult = await seed(app);
    await app.inject({
      method: 'PUT',
      url: '/api/allocations/pool',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { workspaceId: seedResult.workspaceId, category: 'ai_tokens', total: 5_000 },
    });
    const prepared = await action(app, {
      tool: 'allocation.allocate',
      args: {
        workspaceId: seedResult.workspaceId,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: seedResult.projectId,
        amount: 100,
      },
      idempotencyKey: 'approve-small',
    });
    const different = await action(app, {
      tool: 'allocation.allocate',
      args: {
        workspaceId: seedResult.workspaceId,
        category: 'ai_tokens',
        targetKind: 'project',
        targetRef: seedResult.projectId,
        amount: 4_000,
      },
      approvalToken: prepared.approval?.token,
      idempotencyKey: 'approve-large',
    });
    expect(different.status).toBe('refused');
    expect(different.error?.code).toBe('APPROVAL_INVALID');
  });

  it('keeps the trail for its owner, including refusals', async () => {
    await action(app, { tool: 'account.summary' });
    await action(app, { tool: 'project.create', args: { name: 'Trail', ownerRef: OTHER } });

    const activity = await app.inject({
      method: 'GET',
      url: '/api/account/activity?limit=20',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    const entries = (activity.json() as { entries: { status: string; tool: string }[] }).entries;
    expect(entries.map((entry) => entry.status)).toContain('executed');
    expect(entries.map((entry) => entry.status)).toContain('refused');

    const other = await app.inject({
      method: 'GET',
      url: '/api/account/activity',
      headers: { 'x-veltravia-owner-ref': OTHER },
    });
    expect((other.json() as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it('says an unavailable operation is unavailable instead of pretending', async () => {
    const outcome = await action(app, { tool: 'member.invite', args: {} });
    expect(outcome.status).toBe('refused');
    expect(outcome.error?.code).toBe('TOOL_NOT_AVAILABLE');
    expect(outcome.error?.message).toMatch(/membership/);
  });

  it('refuses an operation that does not exist', async () => {
    const outcome = await action(app, { tool: 'account.deleteEverything' });
    expect(outcome.status).toBe('refused');
    expect(outcome.error?.code).toBe('UNKNOWN_TOOL');
  });
});
