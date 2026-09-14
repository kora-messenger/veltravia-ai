import { describe, expect, it } from 'vitest';
import type { CodingDecision, CodingDecisionContext } from '@veltravia/coding-agent-core';
import { createCodingManager } from '../coding.js';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { buildApp } from '../server.js';

const NOW = () => new Date('2026-09-14T06:00:00.000Z');

interface CodedApp {
  readonly app: ReturnType<typeof buildApp>;
  readonly projectId: string;
  readonly workspaceId: string;
}

async function createCodedApp(
  decisions: CodingDecision[],
  options?: { requirePlanApproval?: boolean },
): Promise<CodedApp> {
  const projectEngine = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const project = await projectEngine.projects.createProject({
    name: 'api-coding-project',
    description: 'project used by the coding API tests',
    projectType: 'other',
    ownerRef: 'api-test-owner',
  });
  const workspace = await projectEngine.workspaces.createWorkspace(project.id, {
    name: 'main',
    branch: 'main',
  });

  let index = 0;
  const decisionSource = {
    nextDecision: async (_context: CodingDecisionContext): Promise<CodingDecision> =>
      decisions[index++] ?? { type: 'fail', reason: 'script exhausted' },
  };
  const coding = createCodingManager({
    projectEngine,
    decisionSource,
    now: NOW,
    requirePlanApproval: options?.requirePlanApproval ?? true,
  });
  const app = buildApp({ projectEngine, coding });
  return { app, projectId: project.id, workspaceId: workspace.id };
}

const PLAN: CodingDecision = {
  type: 'plan',
  plan: {
    goal: 'Add a README file describing the service.',
    steps: [{ summary: 'Create README.md at the workspace root' }],
    filesToInspect: [],
    filesToModify: ['README.md'],
    validations: [],
    acceptanceCriteria: ['README.md exists'],
  },
};

describe('POST /api/coding/runs', () => {
  it('starts a run that pauses for human plan approval', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([
      PLAN,
      { type: 'complete', summary: 'done' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId, workspaceId, userRequirement: 'Add a README' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.state).toBe('awaiting_approval');
    expect(body.pendingApproval).toMatchObject({ kind: 'plan_approval' });
    expect(body.failure).toBeNull();
    app.close();
  });

  it('rejects malformed bodies with 400 (strict schema, no unknown fields)', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([PLAN]);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId },
    });
    expect(missing.statusCode).toBe(400);

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: {
        projectId,
        workspaceId,
        userRequirement: 'Add a README',
        limitOverrides: { maxToolCalls: 9999 },
      },
    });
    expect(unknownField.statusCode).toBe(400);
    app.close();
  });

  it('fails the run typed when the project does not exist', async () => {
    const { app, workspaceId } = await createCodedApp([
      PLAN,
      { type: 'action', action: { type: 'inspect_project' } },
    ]);
    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: {
        projectId: 'missing-project',
        workspaceId,
        userRequirement: 'Add a README',
      },
    });
    const runId = start.json().runId;
    const approval = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${runId}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(approval.statusCode).toBe(200);
    const body = approval.json();
    expect(body.state).toBe('failed');
    expect(body.failure?.code).toBe('CODING_PROJECT_NOT_FOUND');
    app.close();
  });

  it('rejects secret-shaped requirements with 400 and no secret echo', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([PLAN]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: {
        projectId,
        workspaceId,
        userRequirement: 'use this api_key = sk-live-0123456789abcdefghijklmnop to deploy',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('CODING_SECRET_REJECTED');
    expect(response.body).not.toMatch(/sk-live-0123456789/);
    app.close();
  });
});

describe('POST /api/coding/runs/:runId/confirmation', () => {
  it('completes the run after the human approves the plan', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([
      PLAN,
      { type: 'complete', summary: 'Created README.md.' },
    ]);
    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId, workspaceId, userRequirement: 'Add a README' },
    });
    const runId = start.json().runId;

    const approval = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${runId}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(approval.statusCode).toBe(200);
    const body = approval.json();
    expect(body.state).toBe('completed');
    expect(body.summary).toBe('Created README.md.');
    expect(body.failure).toBeNull();
    app.close();
  });

  it('fails the run with CODING_PLAN_REJECTED when the human rejects the plan', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([PLAN]);
    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId, workspaceId, userRequirement: 'Add a README' },
    });
    const runId = start.json().runId;

    const rejection = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${runId}/confirmation`,
      payload: { decision: 'reject' },
    });
    expect(rejection.statusCode).toBe(200);
    const body = rejection.json();
    expect(body.state).toBe('failed');
    expect(body.failure).toMatchObject({ code: 'CODING_PLAN_REJECTED' });
    app.close();
  });

  it('409s when confirming a run that is already terminal', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([
      PLAN,
      { type: 'complete', summary: 'done' },
    ]);
    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId, workspaceId, userRequirement: 'Add a README' },
    });
    const runId = start.json().runId;
    await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${runId}/confirmation`,
      payload: { decision: 'approve' },
    });

    const second = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${runId}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CODING_RUN_TERMINAL');
    app.close();
  });

  it('400s on an invalid decision value', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([PLAN]);
    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId, workspaceId, userRequirement: 'Add a README' },
    });
    const runId = start.json().runId;
    const response = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${runId}/confirmation`,
      payload: { decision: 'maybe' },
    });
    expect(response.statusCode).toBe(400);
    app.close();
  });
});

describe('GET /api/coding/runs/:runId', () => {
  it('returns the safe run view for an existing run', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([PLAN]);
    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId, workspaceId, userRequirement: 'Add a README' },
    });
    const runId = start.json().runId;
    const response = await app.inject({ method: 'GET', url: `/api/coding/runs/${runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runId, state: 'awaiting_approval' });
    app.close();
  });

  it('404s with a typed error for unknown runs', async () => {
    const { app } = await createCodedApp([PLAN]);
    const response = await app.inject({ method: 'GET', url: '/api/coding/runs/never-started' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('CODING_RUN_NOT_FOUND');
    app.close();
  });
});

describe('POST /api/coding/runs/:runId/cancel', () => {
  it('cancels a paused run and keeps it terminal', async () => {
    const { app, projectId, workspaceId } = await createCodedApp([PLAN]);
    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      payload: { projectId, workspaceId, userRequirement: 'Add a README' },
    });
    const runId = start.json().runId;

    const cancel = await app.inject({ method: 'POST', url: `/api/coding/runs/${runId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().state).toBe('cancelled');

    const after = await app.inject({ method: 'GET', url: `/api/coding/runs/${runId}` });
    expect(after.json().state).toBe('cancelled');

    const approveAfterCancel = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${runId}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(approveAfterCancel.statusCode).toBe(409);
    app.close();
  });

  it('404s when cancelling an unknown run', async () => {
    const { app } = await createCodedApp([PLAN]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/coding/runs/never-started/cancel',
    });
    expect(response.statusCode).toBe(404);
    app.close();
  });
});
