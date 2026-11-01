import { describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';

/**
 * Step 30 wiring: the App Builder over the real Fastify app.
 *
 * These tests check the SEAM: does a specification reach the validator, does a
 * plan become real files through the existing project engine, is another
 * owner's plan invisible, and does the API refuse to claim a build it cannot
 * run.
 */

const ownerA = { 'x-veltravia-owner-ref': 'builder-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'builder-owner-b' };

const reactSpec = {
  name: 'Invoice Desk',
  description: 'Small invoicing app.',
  projectKind: 'web',
  frontend: 'react',
};

function createPlan(app: ReturnType<typeof buildApp>, headers: Record<string, string> = ownerA) {
  return app.inject({
    method: 'POST',
    url: '/api/app-builder/plans',
    headers,
    payload: { specification: reactSpec },
  });
}

describe('app builder API', () => {
  it('serves capabilities that do not overclaim', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/app-builder', headers: ownerA });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      capabilities: {
        supported: string[];
        notSupported: string[];
        milestones: { state: string }[];
      };
    };
    expect(body.capabilities.supported.join(' ')).toMatch(/specification validation/);
    expect(body.capabilities.notSupported.join(' ')).toMatch(/real build or test/);
    expect(body.capabilities.milestones.some((milestone) => milestone.state === 'planned')).toBe(
      true,
    );
  });

  it('lists the technology catalog with support levels', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/app-builder/registry',
      headers: ownerA,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      technologies: { id: string; supportLevel: string; kind: string }[];
    };
    const ids = body.technologies.map((entry) => entry.id);
    expect(ids).toContain('rust');
    expect(ids).toContain('flutter');
    expect(ids).toContain('solidity');
    expect(body.technologies.every((entry) => entry.supportLevel !== 'executable')).toBe(true);
  });

  it('returns one technology and 404s an unknown one', async () => {
    const app = buildApp();
    const found = await app.inject({
      method: 'GET',
      url: '/api/app-builder/registry/go',
      headers: ownerA,
    });
    expect(found.statusCode).toBe(200);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/app-builder/registry/cobol',
      headers: ownerA,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('APP_BUILDER_UNKNOWN_TECHNOLOGY');
  });

  it('validates a specification and reports issues without creating anything', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/app-builder/spec/validate',
      headers: ownerA,
      payload: { specification: { name: '', projectKind: 'web', frontend: 'qwik' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { review: { valid: boolean; issues: { code: string }[] } };
    expect(body.review.valid).toBe(false);
    expect(body.review.issues.map((issue) => issue.code)).toContain('unknown-technology');
  });

  it('detects a stack from a manifest', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/app-builder/detect',
      headers: ownerA,
      payload: {
        files: [
          { path: 'package.json', text: '{"dependencies":{"next":"15.0.0"}}' },
          { path: 'app/page.tsx' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { detection: { frameworks: { id: string }[] } };
    expect(body.detection.frameworks.map((framework) => framework.id)).toContain('nextjs');
  });

  it('creates a plan and returns its files', async () => {
    const app = buildApp();
    const response = await createPlan(app);

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      plan: { id: string; status: string; files: { path: string }[] };
    };
    expect(body.plan.status).toBe('planned');
    expect(body.plan.files.map((file) => file.path)).toContain('src/App.tsx');
  });

  it('rejects an unsupported stack with 409 instead of substituting one', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/app-builder/plans',
      headers: ownerA,
      payload: { specification: { name: 'Ledger', projectKind: 'backend', backend: 'django' } },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('APP_BUILDER_UNSUPPORTED_TECHNOLOGY');
    expect(body.error.message).toMatch(/was not replaced/);
  });

  it('rejects a malformed body at the schema boundary', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/app-builder/plans',
      headers: ownerA,
      payload: { specification: 'make me an app' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('materializes a plan into a real project with real files', async () => {
    const app = buildApp();
    const created = await createPlan(app);
    const planId = (created.json() as { plan: { id: string } }).plan.id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/materialize`,
      headers: ownerA,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      result: { projectId: string; workspaceId: string; createdFiles: string[] };
    };
    expect(body.result.createdFiles).toContain('package.json');

    // The files are really in the project engine, not just reported.
    const tree = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${body.result.workspaceId}/tree`,
      headers: ownerA,
    });
    expect(tree.statusCode).toBe(200);
    expect(tree.body).toContain('src/App.tsx');
  });

  it('detects the stack of a materialized project through the API', async () => {
    const app = buildApp();
    const created = await createPlan(app);
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    const materialized = await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/materialize`,
      headers: ownerA,
    });
    const { projectId, workspaceId } = (
      materialized.json() as { result: { projectId: string; workspaceId: string } }
    ).result;

    const response = await app.inject({
      method: 'POST',
      url: `/api/app-builder/projects/${projectId}/workspaces/${workspaceId}/detect`,
      headers: ownerA,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { detection: { frameworks: { id: string }[] } };
    expect(body.detection.frameworks.map((framework) => framework.id)).toContain('react');
  });

  it('keeps one owner out of another owner plans', async () => {
    const app = buildApp();
    const created = await createPlan(app, ownerA);
    const planId = (created.json() as { plan: { id: string } }).plan.id;

    const foreignGet = await app.inject({
      method: 'GET',
      url: `/api/app-builder/plans/${planId}`,
      headers: ownerB,
    });
    expect(foreignGet.statusCode).toBe(404);

    const foreignMaterialize = await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/materialize`,
      headers: ownerB,
    });
    expect(foreignMaterialize.statusCode).toBe(404);

    const foreignList = await app.inject({
      method: 'GET',
      url: '/api/app-builder/plans',
      headers: ownerB,
    });
    expect((foreignList.json() as { plans: unknown[] }).plans).toHaveLength(0);
  });

  it('refuses to materialize the same plan twice', async () => {
    const app = buildApp();
    const created = await createPlan(app);
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/materialize`,
      headers: ownerA,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/materialize`,
      headers: ownerA,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('APP_BUILDER_PLAN_ALREADY_MATERIALIZED');
  });

  it('answers a build request honestly instead of pretending to build', async () => {
    const app = buildApp();
    const created = await createPlan(app);
    const planId = (created.json() as { plan: { id: string } }).plan.id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/build`,
      headers: ownerA,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { outcome: { ran: boolean; reason: string } };
    expect(body.outcome.ran).toBe(false);
    expect(body.outcome.reason).toMatch(/simulated/);
  });

  it('reports preview and deployment as unavailable with a reason', async () => {
    const app = buildApp();
    const created = await createPlan(app);
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    const materialized = await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/materialize`,
      headers: ownerA,
    });
    const { projectId, workspaceId } = (
      materialized.json() as { result: { projectId: string; workspaceId: string } }
    ).result;

    const preview = await app.inject({
      method: 'POST',
      url: `/api/app-builder/projects/${projectId}/preview`,
      headers: ownerA,
      payload: { workspaceId, instruction: 'show me' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview.available).toBe(false);

    const deployment = await app.inject({
      method: 'POST',
      url: `/api/app-builder/projects/${projectId}/deploy`,
      headers: ownerA,
      payload: { target: 'static-hosting' },
    });
    expect(deployment.statusCode).toBe(200);
    expect(deployment.json().deployment.started).toBe(false);
  });

  it('hands coding work to the existing coding agent', async () => {
    const app = buildApp();
    const created = await createPlan(app);
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    const materialized = await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/materialize`,
      headers: ownerA,
    });
    const { projectId, workspaceId } = (
      materialized.json() as { result: { projectId: string; workspaceId: string } }
    ).result;

    const response = await app.inject({
      method: 'POST',
      url: `/api/app-builder/projects/${projectId}/coding`,
      headers: ownerA,
      payload: { workspaceId, instruction: 'Add a health route.' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { session: { runId: string; status: string } };
    expect(body.session.runId.length).toBeGreaterThan(0);
  });

  it('records an audit trail for the owner that acted', async () => {
    const app = buildApp();
    const created = await createPlan(app);
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    await app.inject({
      method: 'POST',
      url: `/api/app-builder/plans/${planId}/materialize`,
      headers: ownerA,
    });

    const mine = await app.inject({
      method: 'GET',
      url: '/api/app-builder/audit',
      headers: ownerA,
    });
    const actions = (mine.json() as { events: { action: string }[] }).events.map(
      (event) => event.action,
    );
    expect(actions).toEqual(['plan.create', 'plan.materialize']);

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/app-builder/audit',
      headers: ownerB,
    });
    expect((theirs.json() as { events: unknown[] }).events).toHaveLength(0);
  });
});
