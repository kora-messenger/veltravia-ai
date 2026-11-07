/**
 * The model loop, with a scripted model.
 *
 * These tests prove the boundary rather than the intelligence: the server
 * authorises every tool, the budget cuts a runaway model off, a refusal is
 * recorded rather than obeyed, and a deliverable outside the assignment never
 * reaches the Primary Agent.
 */

import { describe, expect, it } from 'vitest';

import { validAssignment } from '@veltravia/worker-core';

import { ModelWorkerExecutor, parseModelTurn } from './executor.js';
import type { ModelTurnRequest, ModelTurnResult } from './executor.js';
import { scrubForModel, buildWorkerPrompt } from './prompt.js';
import { WorkerToolbox } from './tools.js';
import { resolveLimits } from './governance.js';

const assignment = (overrides: Record<string, unknown> = {}) => validAssignment(overrides) as never;

const turn = (content: string): ModelTurnResult => ({
  content,
  providerId: 'groq',
  modelId: 'openai/gpt-oss-120b',
  inputTokens: 120,
  outputTokens: 40,
  latencyMs: 12,
  live: true,
});

function scripted(turns: readonly string[]): {
  generate: (request: ModelTurnRequest) => Promise<ModelTurnResult>;
  requests: ModelTurnRequest[];
} {
  const requests: ModelTurnRequest[] = [];
  let index = 0;
  return {
    requests,
    async generate(request) {
      requests.push(request);
      const content = turns[Math.min(index, turns.length - 1)] ?? '{}';
      index += 1;
      return turn(content);
    },
  };
}

const readHandler = async () => ({ ok: true as const, output: 'export const a = 1;', bytes: 19 });
const writeHandler = async (invocation: { arguments: Record<string, unknown> }) => ({
  ok: true as const,
  output: 'written',
  bytes: 7,
  changedPaths: [String(invocation.arguments['path'])],
});

describe('parsing a model answer', () => {
  it('accepts a tool action', () => {
    const parsed = parseModelTurn(
      '{"action":{"tool":"project.read","arguments":{"path":"src/a.ts"}}}',
    );
    expect(parsed.kind).toBe('action');
  });

  it('accepts a final report, including inside a code fence', () => {
    const parsed = parseModelTurn(
      '```json\n{"final":{"status":"completed","summary":"done","deliverables":[],"evidence":[]}}\n```',
    );
    expect(parsed.kind).toBe('final');
  });

  it('rejects an answer that is neither', () => {
    expect(parseModelTurn('I think I am done.').kind).toBe('invalid');
    expect(parseModelTurn('{"final":{"status":"maybe","summary":"x"}}').kind).toBe('invalid');
  });

  it('drops deliverables and evidence of an unknown kind', () => {
    const parsed = parseModelTurn(
      '{"final":{"status":"completed","summary":"x","deliverables":[{"name":"a","kind":"binary"}],"evidence":[{"kind":"vibes","ref":"x"}]}}',
    );
    expect(parsed.kind).toBe('final');
    if (parsed.kind !== 'final') return;
    expect(parsed.deliverables).toHaveLength(0);
    expect(parsed.evidence).toHaveLength(0);
  });
});

describe('tool authorization', () => {
  const toolbox = () =>
    new WorkerToolbox({
      ownerRef: 'owner-1',
      workerId: 'wkr_1',
      workerType: 'frontend',
      taskId: 'task_1',
      projectId: 'prj_1',
      assignment: {
        allowedTools: ['project.read', 'project.write'],
        scope: ['src/settings'],
        exclusions: ['src/settings/secrets.ts'],
        permissions: { readProject: true, writeProject: true, runTools: false, network: false },
      },
      handlers: {
        'project.read': readHandler,
        'project.write': writeHandler,
        'tests.run': readHandler,
      },
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
    });

  it('allows an assigned tool inside the scope', async () => {
    const outcome = await toolbox().invoke({
      tool: 'project.read',
      arguments: { path: 'src/settings/a.ts' },
    });
    expect(outcome.ok).toBe(true);
  });

  it('refuses a tool the assignment never named', async () => {
    const gate = toolbox();
    const outcome = await gate.invoke({ tool: 'tests.run', arguments: {} });
    expect(outcome).toMatchObject({ ok: false, code: 'WORKER_TOOL_NOT_ASSIGNED' });
    expect(gate.refusals).toHaveLength(1);
  });

  it('refuses a tool that does not exist', async () => {
    const outcome = await toolbox().invoke({ tool: 'shell.exec', arguments: {} });
    expect(outcome).toMatchObject({ ok: false, code: 'WORKER_TOOL_UNKNOWN' });
  });

  it('refuses a path outside the scope and inside an exclusion', async () => {
    const gate = toolbox();
    expect(
      await gate.invoke({ tool: 'project.read', arguments: { path: 'src/other/a.ts' } }),
    ).toMatchObject({
      code: 'WORKER_TOOL_OUT_OF_SCOPE',
    });
    expect(
      await gate.invoke({ tool: 'project.read', arguments: { path: 'src/settings/secrets.ts' } }),
    ).toMatchObject({ code: 'WORKER_TOOL_OUT_OF_SCOPE' });
  });

  it('refuses writing when the assignment grants no write permission', async () => {
    const gate = new WorkerToolbox({
      ownerRef: 'owner-1',
      workerId: 'wkr_1',
      workerType: 'analysis',
      taskId: 'task_1',
      projectId: 'prj_1',
      assignment: {
        allowedTools: ['project.write'],
        scope: ['src'],
        exclusions: [],
        permissions: { readProject: true, writeProject: false, runTools: false, network: false },
      },
      handlers: { 'project.write': writeHandler },
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
    });
    expect(
      await gate.invoke({ tool: 'project.write', arguments: { path: 'src/a.ts' } }),
    ).toMatchObject({
      code: 'WORKER_TOOL_FORBIDDEN',
    });
  });
});

describe('the model loop', () => {
  it('runs a tool, then takes the final report, and records real usage', async () => {
    const model = scripted([
      '{"action":{"tool":"project.write","arguments":{"path":"src/settings/panel.tsx","content":"x"}}}',
      '{"final":{"status":"completed","summary":"Built the panel","deliverables":[{"name":"panel","kind":"file","path":"src/settings/panel.tsx","summary":"panel"}],"evidence":[{"kind":"test_run","ref":"tests","summary":"2 passed","passed":true}]}}',
    ]);
    const executor = new ModelWorkerExecutor({
      generate: model.generate,
      handlers: { 'project.write': writeHandler },
    });
    const result = await executor.run({
      workerId: 'wkr_1',
      workerType: 'frontend',
      assignment: assignment(),
      signal: new AbortController().signal,
      report: () => undefined,
      ownerRef: 'owner-1',
      taskId: 'task_1',
    });
    expect(result.outcome).toBe('completed');
    expect(result.deliverables.some((entry) => entry.path === 'src/settings/panel.tsx')).toBe(true);
    expect(result.usage).toMatchObject({ modelCalls: 2, live: true, providerId: 'groq' });
    expect(executor.simulated).toBe(false);
  });

  it('corrects an unusable answer instead of acting on it', async () => {
    const model = scripted([
      'Sure! I will now write the file.',
      '{"final":{"status":"completed","summary":"done","deliverables":[],"evidence":[]}}',
    ]);
    const result = await new ModelWorkerExecutor({ generate: model.generate, handlers: {} }).run({
      workerId: 'wkr_1',
      workerType: 'frontend',
      assignment: assignment(),
      signal: new AbortController().signal,
      report: () => undefined,
      ownerRef: 'owner-1',
      taskId: 'task_1',
    });
    expect(result.outcome).toBe('completed');
    // A completion with nothing produced is also sent back once, so three turns.
    expect(model.requests).toHaveLength(3);
    expect(model.requests[1]?.messages.at(-1)?.content).toContain('rejected');
  });

  it('records a refusal and keeps going', async () => {
    const model = scripted([
      '{"action":{"tool":"tests.run","arguments":{}}}',
      '{"final":{"status":"partial","summary":"Could not test","deliverables":[],"evidence":[]}}',
    ]);
    const result = await new ModelWorkerExecutor({ generate: model.generate, handlers: {} }).run({
      workerId: 'wkr_1',
      workerType: 'frontend',
      assignment: assignment(),
      signal: new AbortController().signal,
      report: () => undefined,
      ownerRef: 'owner-1',
      taskId: 'task_1',
    });
    expect(result.outcome).toBe('partial');
    expect(result.evidence.some((entry) => entry.ref === 'refusals')).toBe(true);
  });

  it('drops a deliverable the model claimed outside its scope', async () => {
    const model = scripted([
      '{"final":{"status":"completed","summary":"x","deliverables":[{"name":"hack","kind":"file","path":"src/elsewhere/x.ts","summary":"x"}],"evidence":[]}}',
    ]);
    const result = await new ModelWorkerExecutor({ generate: model.generate, handlers: {} }).run({
      workerId: 'wkr_1',
      workerType: 'frontend',
      assignment: assignment(),
      signal: new AbortController().signal,
      report: () => undefined,
      ownerRef: 'owner-1',
      taskId: 'task_1',
    });
    expect(result.deliverables).toHaveLength(0);
  });

  it('stops at the model-call budget instead of looping', async () => {
    const model = scripted([
      '{"action":{"tool":"project.read","arguments":{"path":"src/settings/a.ts"}}}',
    ]);
    const result = await new ModelWorkerExecutor({
      generate: model.generate,
      handlers: { 'project.read': readHandler },
    }).run({
      workerId: 'wkr_1',
      workerType: 'frontend',
      assignment: assignment({
        limits: { maxDurationMs: 5_000, maxToolCalls: 40, maxDeliverables: 5 },
      }),
      signal: new AbortController().signal,
      report: () => undefined,
      ownerRef: 'owner-1',
      taskId: 'task_1',
    });
    expect(result.outcome).toBe('failed');
    expect(model.requests.length).toBeLessThanOrEqual(12);
  });

  it('surfaces a provider failure as a worker failure, not a silent success', async () => {
    const executor = new ModelWorkerExecutor({
      generate: async () => {
        throw new Error('provider answered 429');
      },
      handlers: {},
    });
    await expect(
      executor.run({
        workerId: 'wkr_1',
        workerType: 'frontend',
        assignment: assignment(),
        signal: new AbortController().signal,
        report: () => undefined,
        ownerRef: 'owner-1',
        taskId: 'task_1',
      }),
    ).rejects.toThrow('429');
  });
});

describe('prompt hygiene and budgets', () => {
  it('scrubs credential-shaped text before a model sees it', () => {
    const cleaned = scrubForModel('key sk-abcdefghijklmnopqrstuvwx and postgres://u:p@host/db');
    expect(cleaned).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(cleaned).not.toContain('u:p@host');
  });

  it('reports redactions and carries no credential in the prompt', () => {
    const prompt = buildWorkerPrompt({
      assignment: assignment(),
      workerType: 'frontend',
      taskTitle: 'Panel',
      taskObjective: 'Build it',
      context: [{ path: 'src/settings/env.ts', content: 'API_KEY=sk-abcdefghijklmnopqrstuvwx' }],
    });
    expect(prompt.redactions).toBeGreaterThan(0);
    expect(prompt.user).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(prompt.user).toContain('src/settings/env.ts');
  });

  it('clamps a budget larger than the ceiling and says so', () => {
    const { limits, reduced } = resolveLimits({ maxModelCalls: 999 });
    expect(limits.maxModelCalls).toBeLessThanOrEqual(12);
    expect(reduced).toContain('maxModelCalls');
  });
});
