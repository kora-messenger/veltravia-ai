/**
 * Operation billing through the real routes (Step 55).
 *
 * The unit tests prove the accounting rules against a stand-in wallet. This file
 * proves the wiring: a coding run and an agent worker each make several provider
 * calls, and the owner is charged once per operation - not once per call, and not
 * twice when the operation is closed twice.
 *
 * Everything except the HTTP call to OpenAI is the shipping path: the real app,
 * the real vault, the real plan/credits routes, the real coding agent and the
 * real model-powered worker executor. The fixture provider reports the documented
 * `usage` block including cached tokens, so the numbers asserted here are the
 * numbers a deployment receives.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FixtureProviderTransport,
  TEST_OPENAI_KEY,
  createTestKeyring,
} from '@veltravia/ai-gateway-mock';
import { prepareIsolatedTestSchema } from '@veltravia/storage-postgres';

import { createGatewayService } from './ai-gateway-service.js';
import { createPersistence } from './persistence.js';
import { buildApp } from './server.js';
import { resolveDeploymentConfig } from './deployment/config.js';

process.env['VELTRAVIA_USAGE_ADMIN_TOKEN'] = 'op-billing-usage-admin';
process.env['VELTRAVIA_WALLET_ADMIN_TOKEN'] = 'op-billing-wallet-admin';
// No scripted run here: the point of these tests is real model turns.
delete process.env['VELTRAVIA_CODING_DEMO'];
delete process.env['VELTRAVIA_WORKER_EXECUTOR'];

// A plan change is a durable fact by design, so these tests need the database
// CI provides. Without one they are skipped rather than faked in memory.
const baseDatabaseUrl = process.env.VELTRAVIA_TEST_DATABASE_URL?.trim() ?? '';
const describeDb = baseDatabaseUrl === '' ? describe.skip : describe;

const operator = { 'x-veltravia-admin': 'op-billing-usage-admin' };
const walletOperator = { authorization: 'Bearer op-billing-wallet-admin' };
const owner = { 'x-veltravia-owner-ref': 'op-billing-owner' };

/** Tokens every fixture reply reports, so the expected total is arithmetic. */
const INPUT_PER_CALL = 120;
const OUTPUT_PER_CALL = 60;
const CACHED_PER_CALL = 40;

interface ChargeView {
  id: string;
  kind: string;
  state: string;
  credits: number;
  estimatedCredits: number;
  measuredTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  measurementSource: string;
  runId: string | null;
  taskId: string | null;
  limitations: string[];
}

const codingPlanReply = JSON.stringify({
  type: 'plan',
  plan: {
    goal: 'Add the invoice route',
    steps: [{ summary: 'Create the route file' }],
    filesToInspect: [],
    filesToModify: [],
    filesToCreate: ['src/invoices.ts'],
    validations: [],
    acceptanceCriteria: ['src/invoices.ts exists'],
    requestSummary: 'Add the invoice route',
    projectUnderstanding: 'Routes live in src',
    approach: 'One file',
    risks: [],
  },
});

const codingActionReply = JSON.stringify({
  type: 'action',
  action: { type: 'create_file', path: 'src/invoices.ts', content: 'export const x = 1;\n' },
});
const codingCompleteReply = JSON.stringify({ type: 'complete', summary: 'Added the route.' });

const workerWriteReply = JSON.stringify({
  action: { tool: 'project.write', arguments: { path: 'src/screen/file.tsx', content: 'x\n' } },
});
const workerFinalReply = JSON.stringify({
  final: {
    status: 'completed',
    summary: 'Wrote the screen file.',
    deliverables: [
      { name: 'file', kind: 'file', path: 'src/screen/file.tsx', summary: 'The file' },
    ],
  },
});

/** A provider that answers with the next scripted reply and counts real calls. */
function sequencedProvider(replies: string[]) {
  let index = 0;
  const transport = new FixtureProviderTransport({
    override: (request) => {
      if (request.method === 'GET') return undefined;
      const content = replies[Math.min(index, replies.length - 1)] ?? '';
      index += 1;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          id: `chatcmpl-op-billing-${index}`,
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: INPUT_PER_CALL,
            completion_tokens: OUTPUT_PER_CALL,
            prompt_tokens_details: { cached_tokens: CACHED_PER_CALL },
          },
        },
        text: '',
      };
    },
  });
  return { transport, calls: () => index };
}

async function harness(replies: string[]) {
  const provider = sequencedProvider(replies);
  const schema = `op_billing_${Math.random().toString(36).slice(2, 8)}`;
  const url = (await prepareIsolatedTestSchema(baseDatabaseUrl, schema)) ?? baseDatabaseUrl;
  const persistence = await createPersistence({ url });
  const aiGateway = createGatewayService({
    keyring: createTestKeyring([1]),
    transport: provider.transport,
  });
  // No injected project engine: the app's own durable engine is the one the
  // routes guard, so a project created over HTTP is the same project everywhere.
  const app = buildApp({
    aiGateway,
    persistence,
    deployment: resolveDeploymentConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
  });
  await app.ready();
  return { app, provider, persistence };
}

/** A project with one workspace and a `src` directory, created over HTTP. */
async function seedProject(
  app: FastifyInstance,
): Promise<{ projectId: string; workspaceId: string }> {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: owner,
    payload: {
      name: `Billing ${Math.random().toString(36).slice(2, 8)}`,
      description: 'operation-billing project',
      projectType: 'web',
    },
  });
  expect(project.statusCode).toBeLessThan(300);
  const projectId = (project.json() as { id: string }).id;
  const workspace = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workspaces`,
    headers: owner,
    payload: { name: 'main' },
  });
  const workspaceId = (workspace.json() as { id: string }).id;
  const directory = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/directories`,
    headers: owner,
    payload: { path: 'src' },
  });
  // A workspace file needs its parent directory before it can be written.
  expect(directory.statusCode).toBeLessThan(400);
  return { projectId, workspaceId };
}

async function connectProvider(app: FastifyInstance): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/ai/providers/connections',
    headers: owner,
    payload: { providerId: 'openai', apiKey: TEST_OPENAI_KEY, displayName: 'Billing key' },
  });
  expect(response.statusCode).toBe(201);
}

async function fundPaidOwner(app: FastifyInstance, credits: number): Promise<void> {
  const plan = await app.inject({
    method: 'PUT',
    url: '/api/usage/entitlement',
    headers: { ...operator, ...owner },
    payload: { planId: 'paid' },
  });
  expect(plan.statusCode).toBe(200);
  const grant = await app.inject({
    method: 'POST',
    url: '/api/wallet/credits',
    headers: { ...walletOperator, ...owner },
    payload: {
      ownerRef: 'op-billing-owner',
      amount: credits,
      reason: 'test funding',
      idempotencyKey: `fund-${credits}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  expect(grant.statusCode).toBe(201);
}

async function charges(app: FastifyInstance): Promise<ChargeView[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/message-credits/charges',
    headers: owner,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { charges: ChargeView[] }).charges;
}

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describeDb('operation billing: a coding run', () => {
  it('holds once and settles one charge for every decision the model made', async () => {
    const built = await harness([codingPlanReply, codingActionReply, codingCompleteReply]);
    app = built.app;
    await connectProvider(app);
    await fundPaidOwner(app, 100);
    const { projectId, workspaceId } = await seedProject(app);

    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: owner,
      payload: { projectId, workspaceId, userRequirement: 'Add an invoice route' },
    });
    expect(start.statusCode).toBe(200);
    const paused = start.json() as { runId: string; state: string };
    expect(paused.state).toBe('awaiting_approval');

    // While the run waits for a human it holds its credit and is still one charge.
    const held = await charges(app);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: 'coding.run', state: 'reserved' });
    expect(held[0].estimatedCredits).toBeGreaterThan(0);

    const done = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${paused.runId}/confirmation`,
      headers: owner,
      payload: { decision: 'approve' },
    });
    expect(done.statusCode).toBe(200);
    expect((done.json() as { state: string }).state).toBe('completed');

    const calls = built.provider.calls();
    expect(calls).toBeGreaterThan(1);
    const settled = await charges(app);
    // Three model decisions, one charge. This is the whole point of the layer.
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      kind: 'coding.run',
      // 'committed' is the state of a charge that was settled and paid.
      state: 'committed',
      measurementSource: 'provider',
      inputTokens: INPUT_PER_CALL * calls,
      outputTokens: OUTPUT_PER_CALL * calls,
      cachedTokens: CACHED_PER_CALL * calls,
    });
    expect((settled[0].inputTokens ?? 0) + (settled[0].outputTokens ?? 0)).toBe(
      (INPUT_PER_CALL + OUTPUT_PER_CALL) * calls,
    );
  }, 30_000);

  it('releases the hold when the run is cancelled instead of planning', async () => {
    // The plan is the first call; a cancellation before approval must not bill it
    // as finished work.
    const built = await harness([codingPlanReply, codingActionReply, codingCompleteReply]);
    app = built.app;
    await connectProvider(app);
    await fundPaidOwner(app, 100);
    const { projectId, workspaceId } = await seedProject(app);

    const start = await app.inject({
      method: 'POST',
      url: '/api/coding/runs',
      headers: owner,
      payload: { projectId, workspaceId, userRequirement: 'Add an invoice route' },
    });
    expect(start.statusCode).toBe(200);
    const paused = start.json() as { runId: string };
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/coding/runs/${paused.runId}/cancel`,
      headers: owner,
      payload: { reason: 'not now' },
    });
    expect(cancel.statusCode).toBe(200);

    const after = await charges(app);
    expect(after).toHaveLength(1);
    expect(after[0].state).toBe('released');
    expect(after[0].credits).toBe(0);
  }, 30_000);
});

describeDb('operation billing: an agent worker', () => {
  async function seedWorker(
    server: FastifyInstance,
  ): Promise<{ projectId: string; taskId: string }> {
    const { projectId } = await seedProject(server);
    const task = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: owner,
      payload: { projectId, title: 'Screen', objective: 'Build the screen.' },
    });
    return { projectId, taskId: (task.json() as { task: { id: string } }).task.id };
  }

  it('tallies every model turn of a worker into one settled charge', async () => {
    const built = await harness([workerWriteReply, workerFinalReply]);
    app = built.app;
    await connectProvider(app);
    await fundPaidOwner(app, 100);

    const { taskId } = await seedWorker(app);
    const delegated = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/workers`,
      headers: owner,
      payload: {
        workerType: 'frontend',
        assignment: {
          objective: 'Write one file for the screen.',
          scope: ['src'],
          exclusions: ['src/secret.ts'],
          deliverables: [
            { name: 'file', kind: 'file', path: 'src/screen/file.tsx', summary: 'The file' },
          ],
          acceptanceCriteria: ['writes the file'],
          allowedTools: ['project.read', 'project.write'],
          permissions: { readProject: true, writeProject: true, runTools: false, network: false },
          limits: { maxDurationMs: 20_000, maxToolCalls: 4, maxDeliverables: 2 },
          dependencies: [],
          checkpoints: ['file written'],
          cancellationConditions: ['owner cancels'],
          reporting: ['files written'],
        },
      },
    });
    expect(delegated.statusCode).toBe(201);
    const workerId = (delegated.json() as { worker: { id: string } }).worker.id;

    const run = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/start`,
      headers: owner,
    });
    expect(run.statusCode).toBe(200);
    expect((run.json() as { worker: { status: string } }).worker.status).toBe('awaiting_review');

    const calls = built.provider.calls();
    expect(calls).toBeGreaterThan(1);

    // Awaiting review still holds: the work is not accepted yet, but the spend is
    // written down against one operation.
    const held = await charges(app);
    const workerCharges = held.filter((charge) => charge.kind === 'agent.execution');
    expect(workerCharges).toHaveLength(1);
    expect(workerCharges[0].state).toBe('reserved');
    expect(workerCharges[0].taskId).toBe(taskId);

    const review = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/review`,
      headers: owner,
      payload: { decision: 'accept', summary: 'Looks right.', criteriaResults: [true] },
    });
    expect(review.statusCode).toBe(200);
    expect((review.json() as { worker: { status: string } }).worker.status).toBe('completed');

    const settled = (await charges(app)).filter((charge) => charge.kind === 'agent.execution');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      kind: 'agent.execution',
      state: 'committed',
      measurementSource: 'provider',
      inputTokens: INPUT_PER_CALL * calls,
      outputTokens: OUTPUT_PER_CALL * calls,
      cachedTokens: CACHED_PER_CALL * calls,
    });

    // Closing the same operation again changes nothing.
    const again = await app.inject({
      method: 'GET',
      url: `/api/workers/${workerId}`,
      headers: owner,
    });
    expect(again.statusCode).toBe(200);
    expect((await charges(app)).filter((charge) => charge.kind === 'agent.execution')).toHaveLength(
      1,
    );
  }, 40_000);

  it('refuses to start a worker the wallet cannot pay for', async () => {
    const built = await harness([workerWriteReply, workerFinalReply]);
    app = built.app;
    await connectProvider(app);
    // Paid plan, no credits: the hold is refused before the executor runs.
    await app.inject({
      method: 'PUT',
      url: '/api/usage/entitlement',
      headers: { ...operator, ...owner },
      payload: { planId: 'paid' },
    });

    const { taskId } = await seedWorker(app);
    const delegated = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/workers`,
      headers: owner,
      payload: {
        workerType: 'frontend',
        assignment: {
          objective: 'Write one file.',
          scope: ['src'],
          exclusions: ['src/secret.ts'],
          deliverables: [{ name: 'file', kind: 'file', path: 'src/a.ts', summary: 'The file' }],
          acceptanceCriteria: ['writes the file'],
          allowedTools: ['project.write'],
          permissions: { readProject: true, writeProject: true, runTools: false, network: false },
          limits: { maxDurationMs: 20_000, maxToolCalls: 2, maxDeliverables: 1 },
          dependencies: [],
          checkpoints: ['file written'],
          cancellationConditions: ['owner cancels'],
          reporting: ['files written'],
        },
      },
    });
    const workerId = (delegated.json() as { worker: { id: string } }).worker.id;

    const run = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/start`,
      headers: owner,
    });
    expect(run.statusCode).toBe(402);
    expect((run.json() as { error: { code: string } }).error.code).toMatch(/INSUFFICIENT_CREDITS/);
    // Nothing was called and the worker is still queued: a refusal costs nothing.
    expect(built.provider.calls()).toBe(0);
    const after = await app.inject({
      method: 'GET',
      url: `/api/workers/${workerId}`,
      headers: owner,
    });
    expect((after.json() as { worker: { status: string } }).worker.status).toBe('queued');
  }, 30_000);
});
