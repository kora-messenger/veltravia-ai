import { describe, expect, it } from 'vitest';
import { createGenerationManager } from '../generation.js';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { buildApp } from '../server.js';
import { createMockSandboxManager } from '@veltravia/sandbox-mock';

const NOW = () => new Date('2026-09-17T09:00:00.000Z');

const IDEA = 'Build me a task management web app with accounts, projects, tasks, and a dashboard';

interface GenerationApp {
  readonly app: ReturnType<typeof buildApp>;
}

async function createGenerationApp(): Promise<GenerationApp> {
  const projectEngine = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const sandboxes = createMockSandboxManager({ now: NOW, auditSink: () => undefined }).manager;
  const generation = createGenerationManager({ projectEngine, sandboxes, now: NOW });
  const app = buildApp({ projectEngine, generation });
  return { app };
}

interface RunPayload {
  readonly runId: string;
  readonly state: string;
  readonly pendingApproval: { kind: string; toolId?: string } | null;
  readonly projectId: string | null;
  readonly changedFiles: readonly { path: string; action: string }[];
  readonly result: {
    outcome: string;
    validation?: { passed: boolean };
    tests?: { executed: boolean };
  } | null;
  readonly failure: { code: string; message: string } | null;
}

describe('POST /api/app-generations', () => {
  it('plans the idea and pauses for human approval (201, safe view)', async () => {
    const { app } = await createGenerationApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: IDEA, runId: 'gen-1' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<RunPayload>();
    expect(body.state).toBe('awaiting_approval');
    expect(body.pendingApproval).toEqual({ kind: 'plan_approval' });
    expect(body.projectId).toBeNull();
    // The response is the SAFE view: no file content ever ships.
    expect(JSON.stringify(body)).not.toContain('generateFiles');
  });

  it('rejects malformed bodies with strict 400s', async () => {
    const { app } = await createGenerationApp();
    const tooShort = await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: 'short' },
    });
    expect(tooShort.statusCode).toBe(400);
    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: IDEA, template: 'web-react' },
    });
    expect(unknownField.statusCode).toBe(400);
  });

  it('rejects secret-shaped ideas with 400', async () => {
    const { app } = await createGenerationApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: 'Build an app around my token ghp_abcdefghijklmnopqrst' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'GENERATION_SECRET_REJECTED',
    );
  });
});

describe('generation lifecycle through the API', () => {
  it('drives a run end-to-end with human approvals at every gate', async () => {
    const { app } = await createGenerationApp();
    await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: IDEA, runId: 'lifecycle' },
    });

    // Plan approval.
    const approved = await app.inject({
      method: 'POST',
      url: '/api/app-generations/lifecycle/approve',
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(200);
    let body = approved.json<RunPayload>();
    expect(body.pendingApproval?.kind).toBe('tool_confirmation');
    expect(body.pendingApproval?.toolId).toBe('sandbox.execute');

    // Forced sandbox confirmation.
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/app-generations/lifecycle/approve',
      payload: { decision: 'approve' },
    });
    expect(confirmed.statusCode).toBe(200);
    body = confirmed.json<RunPayload>();
    expect(body.state).toBe('completed');
    expect(body.result?.outcome).toBe('completed');
    expect(body.result?.validation?.passed).toBe(true);
    expect(body.result?.tests?.executed).toBe(true);
    expect(body.changedFiles.length).toBeGreaterThan(0);
  });

  it('rejecting the plan fails honestly with no project created', async () => {
    const { app } = await createGenerationApp();
    await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: IDEA, runId: 'rej' },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/app-generations/rej/approve',
      payload: { decision: 'reject' },
    });
    expect(rejected.statusCode).toBe(200);
    const body = rejected.json<RunPayload>();
    expect(body.state).toBe('failed');
    expect(body.failure?.code).toBe('GENERATION_PLAN_REJECTED');
    expect(body.projectId).toBeNull();
  });

  it('cancels a paused run one-way and then refuses everything', async () => {
    const { app } = await createGenerationApp();
    await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: IDEA, runId: 'cancel' },
    });
    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/app-generations/cancel/cancel',
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<RunPayload>().state).toBe('cancelled');
    const late = await app.inject({
      method: 'POST',
      url: '/api/app-generations/cancel/approve',
      payload: { decision: 'approve' },
    });
    expect(late.statusCode).toBe(409);
  });
});

describe('plan + result views', () => {
  it('serves the plan view (paths + sizes, never content)', async () => {
    const { app } = await createGenerationApp();
    await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: IDEA, runId: 'plan-view' },
    });
    const plan = await app.inject({ method: 'GET', url: '/api/app-generations/plan-view/plan' });
    expect(plan.statusCode).toBe(200);
    const body = plan.json<{
      templateId: string;
      filesToCreate: readonly { path: string; bytes: number }[];
      risk: { confirmationRequiringTools: string[] };
    }>();
    expect(body.templateId).toBe('web-react');
    expect(body.filesToCreate.every((file) => typeof file.bytes === 'number')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('<!doctype html>');
    expect(body.risk.confirmationRequiringTools).toContain('sandbox.execute');
  });

  it('serves the result view only after the run is terminal', async () => {
    const { app } = await createGenerationApp();
    await app.inject({
      method: 'POST',
      url: '/api/app-generations',
      payload: { idea: IDEA, runId: 'res' },
    });
    const early = await app.inject({ method: 'GET', url: '/api/app-generations/res/result' });
    expect(early.statusCode).toBe(409);
    await app.inject({
      method: 'POST',
      url: '/api/app-generations/res/approve',
      payload: { decision: 'approve' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/app-generations/res/approve',
      payload: { decision: 'approve' },
    });
    const result = await app.inject({ method: 'GET', url: '/api/app-generations/res/result' });
    expect(result.statusCode).toBe(200);
    expect(result.json<RunPayload['result']>().outcome).toBe('completed');
  });

  it('returns 404 for unknown runs on every endpoint', async () => {
    const { app } = await createGenerationApp();
    for (const url of [
      '/api/app-generations/ghost',
      '/api/app-generations/ghost/plan',
      '/api/app-generations/ghost/result',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
    }
    const cancel = await app.inject({ method: 'POST', url: '/api/app-generations/ghost/cancel' });
    expect(cancel.statusCode).toBe(404);
  });
});
