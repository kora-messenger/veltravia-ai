import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '@veltravia/api';
import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';

import { createGatewayService } from '../apps/api/src/ai-gateway-service.js';

/**
 * Step 35 wiring: the real Fastify app, the real coding agent, a fixture
 * provider that answers with the documented coding JSON contract. Everything
 * except the HTTP call to OpenAI is the shipping path: owner resolution, the
 * execution service, the vault, usage, plan approval, the Tool System, the
 * Project Engine, and the honest capability report.
 */

const NOW = () => new Date('2026-11-01T09:00:00.000Z');
const ownerA = { 'x-veltravia-owner-ref': 'coding-model-owner-a' };
const ownerB = { 'x-veltravia-owner-ref': 'coding-model-owner-b' };

function planReply(filesToCreate: string[]): string {
  return JSON.stringify({
    type: 'plan',
    plan: {
      goal: 'Add the invoice route',
      steps: [{ summary: 'Create the route file' }],
      filesToInspect: [],
      filesToModify: [],
      filesToCreate,
      validations: [],
      acceptanceCriteria: ['src/invoices.ts exists'],
      requestSummary: 'Add the invoice route',
      projectUnderstanding: 'Routes live in src',
      approach: 'One file, mirroring the existing routes',
      risks: [],
    },
  });
}

const ACTION_REPLY = JSON.stringify({
  type: 'action',
  action: {
    type: 'create_file',
    path: 'src/invoices.ts',
    content: 'export const invoices = [];\n',
  },
});
const COMPLETE_REPLY = JSON.stringify({ type: 'complete', summary: 'Added the invoice route.' });

/** A fixture provider that answers each request with the next scripted reply. */
function sequencedTransport(replies: string[]): FixtureProviderTransport {
  let index = 0;
  return new FixtureProviderTransport({
    override: (request) => {
      // Model listing (and any other metadata call) must reach the fixture's
      // own handling: overriding it would break the connection handshake.
      if (request.method === 'GET') return undefined;
      const content = replies[Math.min(index, replies.length - 1)] ?? COMPLETE_REPLY;
      index += 1;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          id: 'chatcmpl-coding-fixture',
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 60 },
        },
        text: '',
      };
    },
  });
}

async function buildHarness(
  options: { transport?: FixtureProviderTransport; demo?: boolean } = {},
) {
  const projectEngine = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const project = await projectEngine.projects.createProject({
    name: 'coding-model-project',
    description: 'project used by the model-powered coding tests',
    projectType: 'other',
    ownerRef: 'coding-model-owner-a',
  });
  const workspace = await projectEngine.workspaces.createWorkspace(project.id, { name: 'main' });
  await projectEngine.files.createDirectory(workspace.id, 'src');

  const aiGateway = createGatewayService({
    keyring: createTestKeyring([1]),
    transport: options.transport ?? sequencedTransport([]),
  });
  const app = buildApp({ projectEngine, aiGateway });
  return { app, projectEngine, project, workspace, transport: aiGateway };
}

async function connect(app: ReturnType<typeof buildApp>, headers = ownerA) {
  return app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers,
    payload: { providerId: 'openai', apiKey: TEST_OPENAI_KEY, displayName: 'Coding key' },
  });
}

describe('coding agent: honest capability reporting', () => {
  afterEach(() => {
    delete process.env.VELTRAVIA_CODING_DEMO;
  });

  it('says no model is available until this caller connects one', async () => {
    const { app } = await buildHarness();
    const response = await app.inject({
      method: 'GET',
      url: '/api/coding/capabilities',
      headers: ownerA,
    });
    expect(response.statusCode).toBe(200);
    const capabilities = response.json().capabilities;
    expect(capabilities.decisionSource).toBe('unavailable');
    expect(capabilities.unavailableReason).toMatch(/connect a provider/i);
    expect(capabilities.phases).toContain('awaiting_approval');
  });

  it('reports the model once a provider is connected, per owner', async () => {
    const { app } = await buildHarness();
    await connect(app);
    const mine = (
      await app.inject({ method: 'GET', url: '/api/coding/capabilities', headers: ownerA })
    ).json();
    const theirs = (
      await app.inject({ method: 'GET', url: '/api/coding/capabilities', headers: ownerB })
    ).json();
    expect(mine.capabilities.decisionSource).toBe('model');
    // Another owner's key is never this owner's capability.
    expect(theirs.capabilities.decisionSource).toBe('unavailable');
  });

  it('refuses to start a run instead of falling back to a script', async () => {
    const { app, project, workspace } = await buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: ownerA,
      payload: {
        projectId: project.id,
        workspaceId: workspace.id,
        userRequirement: 'Add an invoice route',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CODING_MODEL_UNAVAILABLE');
  });

  it('only uses the scripted source when the server opts in explicitly', async () => {
    process.env.VELTRAVIA_CODING_DEMO = '1';
    const { app } = await buildHarness();
    const body = (
      await app.inject({ method: 'GET', url: '/api/coding/capabilities', headers: ownerA })
    ).json();
    expect(body.capabilities.decisionSource).toBe('scripted-demo');
    expect(body.capabilities.unavailableReason).toMatch(/VELTRAVIA_CODING_DEMO/);
  });
});

describe('coding agent: a model plan becomes an approved change', () => {
  it('plans, pauses for human approval, then writes through the Tool System', async () => {
    const transport = sequencedTransport([
      planReply(['src/invoices.ts']),
      ACTION_REPLY,
      COMPLETE_REPLY,
    ]);
    const { app, projectEngine, project, workspace } = await buildHarness({ transport });
    await connect(app);

    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: ownerA,
      payload: {
        projectId: project.id,
        workspaceId: workspace.id,
        userRequirement: 'Add a POST /api/invoices route',
      },
    });
    expect(start.statusCode).toBe(200);
    const paused = start.json();
    expect(paused.state).toBe('awaiting_approval');
    expect(paused.phase).toBe('awaiting_approval');
    // Provenance: the human is told a model wrote this plan, and which one.
    expect(paused.plan.origin).toBe('model');
    expect(paused.plan.requestSummary).toBe('Add the invoice route');
    expect(paused.model).toMatchObject({ used: true, live: true, providerId: 'openai' });
    // No file appears before approval.
    const before = await projectEngine.files.listDirectory(workspace.id, 'src');
    expect(before.map((node) => node.path)).not.toContain('src/invoices.ts');

    const done = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${paused.runId}/confirmation`,
      headers: ownerA,
      payload: { decision: 'approve' },
    });
    expect(done.statusCode).toBe(200);
    const finished = done.json();
    expect(finished.state).toBe('completed');
    expect(finished.phase).toBe('completed');
    expect(finished.changedFiles).toEqual(['src/invoices.ts']);
    expect(finished.model.decisions).toBe(3);
    const file = await projectEngine.files.readFile(workspace.id, 'src/invoices.ts');
    expect(file.content).toContain('invoices');

    // The provider really was called, and the credential never left the vault:
    // every request carries it in a header, never in a plan, view or file.
    expect(transport.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(paused)).not.toContain(TEST_OPENAI_KEY);
    expect(JSON.stringify(finished)).not.toContain('sk-');
  });

  it('rejects an unparseable model answer without inventing a plan', async () => {
    const transport = sequencedTransport(['I am not able to produce JSON today.']);
    const { app, project, workspace } = await buildHarness({ transport });
    await connect(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: ownerA,
      payload: {
        projectId: project.id,
        workspaceId: workspace.id,
        userRequirement: 'Add an invoice route',
      },
    });
    const body = response.json();
    expect(body.state).toBe('failed');
    expect(body.plan ?? null).toBeNull();
    expect(JSON.stringify(body)).toMatch(/invalid|not valid JSON|rejected/i);
  });

  it('surfaces a provider outage as a failed run, not a completed one', async () => {
    // Connect while the provider is healthy, then take it down: the run must
    // report the outage instead of quietly producing nothing.
    let down = false;
    const transport = new FixtureProviderTransport({
      override: (request) =>
        request.method === 'GET' || !down
          ? undefined
          : { status: 503, headers: {}, body: { error: { message: 'upstream down' } }, text: '' },
    });
    const { app, project, workspace } = await buildHarness({ transport });
    await connect(app);
    down = true;
    const response = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: ownerA,
      payload: {
        projectId: project.id,
        workspaceId: workspace.id,
        userRequirement: 'Add an invoice route',
      },
    });
    const body = response.json();
    expect(body.state).toBe('failed');
    expect(body.changedFiles).toEqual([]);
  });
});
