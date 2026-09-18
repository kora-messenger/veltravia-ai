import { describe, expect, it } from 'vitest';
import { createTestingManager } from '../testing.js';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { createMockSandboxManager } from '@veltravia/sandbox-mock';
import { buildApp } from '../server.js';

/** The mock sandbox runtime: offline, deterministic, marker-driven. */
const sandboxManager = () =>
  createMockSandboxManager({ now: NOW, auditSink: () => undefined }).manager;

const NOW = () => new Date('2026-09-18T07:00:00.000Z');

async function createTestedApp(options?: { manifest?: string }): Promise<{
  app: ReturnType<typeof buildApp>;
  projectId: string;
  workspaceId: string;
}> {
  const projectEngine = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const project = await projectEngine.projects.createProject({
    name: 'api-testing-project',
    description: 'project used by the testing API tests',
    projectType: 'other',
    ownerRef: 'api-test-owner',
  });
  const workspace = await projectEngine.workspaces.createWorkspace(project.id, {
    name: 'main',
    branch: 'main',
  });
  await projectEngine.files.createFile(workspace.id, {
    path: 'package.json',
    content:
      options?.manifest ??
      `${JSON.stringify(
        {
          name: 'api-fixture',
          scripts: { test: 'node --version' },
          dependencies: { express: '*' },
        },
        null,
        2,
      )}\n`,
  });
  const testing = createTestingManager({ projectEngine, now: NOW, sandboxes: sandboxManager() });
  const app = buildApp({ projectEngine, testing });
  return { app, projectId: project.id, workspaceId: workspace.id };
}

describe('testing API routes', () => {
  it('starts a run, pauses for plan approval, and completes after approval', async () => {
    const { app, projectId, workspaceId } = await createTestedApp();
    const started = await app.inject({
      method: 'POST',
      url: '/api/testing/runs',
      payload: { projectId, workspaceId },
    });
    expect(started.statusCode).toBe(200);
    const body = started.json();
    expect(body.state).toBe('awaiting_approval');
    expect(body.pendingApproval?.kind).toBe('plan_approval');
    // Safe plan view: paths, labels, and purposes - never file contents.
    expect(body.plan.commands).toEqual([
      expect.objectContaining({ executable: 'node', arguments: ['--version'] }),
    ]);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/testing/runs/${body.runId}/approval`,
      payload: { decision: 'approve' },
    });
    // The forced sandbox.execute confirmation pauses the run again.
    expect(approved.statusCode).toBe(200);
    const mid = approved.json();
    expect(mid.state).toBe('awaiting_approval');
    expect(mid.pendingApproval?.kind).toBe('tool_confirmation');

    const done = await app.inject({
      method: 'POST',
      url: `/api/testing/runs/${body.runId}/approval`,
      payload: { decision: 'approve' },
    });
    expect(done.statusCode).toBe(200);
    const final = done.json();
    expect(final.state).toBe('completed');
    expect(final.results.success).toBe(true);
    expect(final.commandsExecuted).toBe(1);

    const fetched = await app.inject({ method: 'GET', url: `/api/testing/runs/${body.runId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().state).toBe('completed');
  });

  it('fails honestly when the plan is rejected', async () => {
    const { app, projectId, workspaceId } = await createTestedApp();
    const started = await app.inject({
      method: 'POST',
      url: '/api/testing/runs',
      payload: { projectId, workspaceId },
    });
    const body = started.json();
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/testing/runs/${body.runId}/approval`,
      payload: { decision: 'reject' },
    });
    // Failures are honest terminal views (HTTP 200), never exceptions.
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().state).toBe('failed');
    expect(rejected.json().failure.code).toBe('TESTING_PLAN_REJECTED');
  });

  it('validates the request body strictly', async () => {
    const { app, projectId, workspaceId } = await createTestedApp();
    const unknownProp = await app.inject({
      method: 'POST',
      url: '/api/testing/runs',
      payload: { projectId, workspaceId, exec: 'rm -rf /' },
    });
    expect(unknownProp.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/testing/runs',
      payload: { projectId },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('returns 404 for an unknown run and 409 when nothing is pending', async () => {
    const { app, projectId, workspaceId } = await createTestedApp();
    const unknown = await app.inject({ method: 'GET', url: '/api/testing/runs/nope' });
    expect(unknown.statusCode).toBe(404);
    const started = await app.inject({
      method: 'POST',
      url: '/api/testing/runs',
      payload: { projectId, workspaceId },
    });
    const body = started.json();
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/testing/runs/${body.runId}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().state).toBe('cancelled');
    const afterCancel = await app.inject({
      method: 'POST',
      url: `/api/testing/runs/${body.runId}/approval`,
      payload: { decision: 'approve' },
    });
    expect(afterCancel.statusCode).toBe(409);
  });

  it('reports unsupported projects as an honest terminal failure view', async () => {
    const projectEngine = createProjectEngine({
      now: NOW,
      generateProjectId: createSequentialIdGenerator('prj'),
      generateWorkspaceId: createSequentialIdGenerator('ws'),
      generateNodeId: createSequentialIdGenerator('node'),
    });
    const project = await projectEngine.projects.createProject({
      name: 'empty',
      description: 'project without a package manifest',
      projectType: 'other',
      ownerRef: 'api-test-owner',
    });
    const workspace = await projectEngine.workspaces.createWorkspace(project.id, {
      name: 'main',
      branch: 'main',
    });
    const testing = createTestingManager({ projectEngine, now: NOW, sandboxes: sandboxManager() });
    const app = buildApp({ projectEngine, testing });
    const started = await app.inject({
      method: 'POST',
      url: '/api/testing/runs',
      payload: { projectId: project.id, workspaceId: workspace.id },
    });
    // Failures are honest terminal views (HTTP 200), never exceptions.
    expect(started.statusCode).toBe(200);
    expect(started.json().state).toBe('failed');
    expect(started.json().failure.code).toBe('TESTING_UNSUPPORTED_PROJECT');
  });
});
