import { beforeEach, describe, expect, it } from 'vitest';
import {
  CodingAgentManager,
  CODING_TOOL_IDS,
  type CodingRunView,
} from '@veltravia/coding-agent-core';
import {
  createCodingFixtureEnvironment,
  type CodingFixtureEnvironment,
} from '@veltravia/coding-agent-mock';

import type { CodingModelClient, CodingModelReply } from './client.js';
import { createModelCodingDecisionSource } from './source.js';

/**
 * Integration: a model-shaped reply stream driving the REAL coding agent -
 * real state machine, real plan approval, real Tool System, real Project
 * Engine, real revision protection, real mock sandbox. Only the provider is
 * replaced, and it answers with the same JSON contract a real model does.
 */

const NOW = () => new Date('2026-11-01T10:00:00.000Z');

function reply(text: string): CodingModelReply {
  return { text, providerId: 'openai', modelId: 'gpt-4.1-mini', live: true };
}

function fakeClient(replies: (string | (() => string))[]): CodingModelClient & { calls: number } {
  const state = { calls: 0 };
  return {
    providerName: 'Fake Provider',
    get calls() {
      return state.calls;
    },
    async complete() {
      const index = Math.min(state.calls, replies.length - 1);
      state.calls += 1;
      const next = replies[index]!;
      return reply(typeof next === 'function' ? next() : next);
    },
  };
}

function plan(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'plan',
    plan: {
      goal: 'Add a greet module',
      steps: [{ summary: 'Create src/greet.ts' }],
      filesToInspect: [],
      filesToModify: [],
      filesToCreate: ['src/greet.ts'],
      validations: [],
      acceptanceCriteria: ['src/greet.ts exports greet'],
      requestSummary: 'Add a greet module',
      projectUnderstanding: 'The workspace is empty',
      approach: 'One small module',
      risks: [],
      ...fields,
    },
  });
}

function action(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: 'action', action: payload });
}

const COMPLETE = JSON.stringify({ type: 'complete', summary: 'Added src/greet.ts.' });

describe('model-powered coding agent (fixture environment)', () => {
  let env: CodingFixtureEnvironment;

  beforeEach(async () => {
    env = await createCodingFixtureEnvironment({ now: NOW });
    // The engine never conjures intermediate directories; a test that seeds a
    // nested file has to create its parent first, exactly like the API does.
    await env.projectEngine.files.createDirectory(env.workspaceId, 'src');
  });

  function build(
    replies: (string | (() => string))[],
    options: {
      maxConsecutiveFailures?: number;
      signalFor?: (runId: string) => AbortSignal | undefined;
    } = {},
  ): {
    manager: CodingAgentManager;
    client: ReturnType<typeof fakeClient>;
    source: ReturnType<typeof createModelCodingDecisionSource>;
  } {
    const client = fakeClient(replies);
    const source = createModelCodingDecisionSource({
      client,
      ...(options.signalFor !== undefined ? { signalFor: options.signalFor } : {}),
    });
    const manager = new CodingAgentManager({
      tools: env.tools,
      decisionSource: source,
      now: NOW,
      requirePlanApproval: true,
      ...(options.maxConsecutiveFailures !== undefined
        ? { limits: { maxConsecutiveFailures: options.maxConsecutiveFailures } }
        : {}),
    });
    return { manager, client, source };
  }

  function start(
    manager: CodingAgentManager,
    requirement = 'Add a greet module',
  ): Promise<CodingRunView> {
    return manager.startRun({
      projectId: env.projectId,
      workspaceId: env.workspaceId,
      userRequirement: requirement,
    });
  }

  async function read(path: string): Promise<string> {
    const file = await env.projectEngine.files.readFile(env.workspaceId, path);
    return file.content;
  }

  it('runs a model plan through approval into a real file write', async () => {
    const { manager, source } = build([
      plan({ filesToCreate: ['src/greet.ts'] }),
      action({
        type: 'create_file',
        path: 'src/greet.ts',
        content: 'export const greet = () => "hi";\n',
      }),
      COMPLETE,
    ]);

    const paused = await start(manager);
    expect(paused.state).toBe('awaiting_approval');
    expect(paused.phase).toBe('awaiting_approval');
    // The plan the human is asked to approve is the model's, field for field.
    expect(paused.plan?.origin).toBe('model');
    expect(paused.plan?.projectUnderstanding).toBe('The workspace is empty');

    const done = await manager.submitApproval(paused.runId, 'approve');
    expect(done.state).toBe('completed');
    expect(done.phase).toBe('completed');
    expect(done.changedFiles).toEqual(['src/greet.ts']);
    expect(await read('src/greet.ts')).toContain('export const greet');
    expect(source.exchanges().every((exchange) => exchange.live)).toBe(true);
  });

  it('applies a targeted patch and keeps the rest of the file byte-identical', async () => {
    await env.projectEngine.files.createFile(env.workspaceId, {
      path: 'src/app.ts',
      content: [
        'const answer = 1;',
        'const untouched = "keep me";',
        'export { answer, untouched };',
        '',
      ].join('\n'),
    });

    const { manager } = build([
      plan({ filesToInspect: ['src/app.ts'], filesToCreate: [] }),
      action({ type: 'read_file', path: 'src/app.ts' }),
      action({
        type: 'patch_file',
        path: 'src/app.ts',
        find: 'const answer = 1;',
        replace: 'const answer = 2;',
      }),
      COMPLETE,
    ]);

    const paused = await start(manager);
    const done = await manager.submitApproval(paused.runId, 'approve');
    expect(done.state).toBe('completed');
    const content = await read('src/app.ts');
    expect(content).toContain('const answer = 2;');
    expect(content).toContain('const untouched = "keep me";');
    expect(content).not.toContain('const answer = 1;');
  });

  it('refuses an ambiguous patch instead of guessing, and the file stays intact', async () => {
    await env.projectEngine.files.createFile(env.workspaceId, {
      path: 'src/dup.ts',
      content: 'value(1);\nvalue(1);\n',
    });

    const prompts: string[] = [];
    const client: CodingModelClient = {
      providerName: 'Fake Provider',
      async complete(request) {
        prompts.push(request.messages.at(-1)?.content ?? '');
        const index = prompts.length;
        const script: Record<number, string> = {
          1: plan({ filesToInspect: ['src/dup.ts'], filesToCreate: [] }),
          2: action({ type: 'read_file', path: 'src/dup.ts' }),
          3: action({
            type: 'patch_file',
            path: 'src/dup.ts',
            find: 'value(1);',
            replace: 'value(2);',
          }),
          4: COMPLETE,
        };
        return reply(script[index] ?? COMPLETE);
      },
    };
    const manager = new CodingAgentManager({
      tools: env.tools,
      decisionSource: createModelCodingDecisionSource({ client }),
      now: NOW,
      requirePlanApproval: true,
    });

    const paused = await start(manager);
    const done = await manager.submitApproval(paused.runId, 'approve');
    expect(done.state).toBe('completed');
    // The refusal is real: the file is byte-identical and the model was told
    // exactly why on its next turn, instead of the agent guessing which match.
    expect(await read('src/dup.ts')).toBe('value(1);\nvalue(1);\n');
    expect(prompts[3]).toMatch(/occurs 2 times/i);
  });

  it('rejects a stale revision supplied by the model instead of overwriting', async () => {
    await env.projectEngine.files.createFile(env.workspaceId, {
      path: 'src/stale.ts',
      content: 'before\n',
    });

    const { manager } = build(
      [
        plan({ filesToInspect: ['src/stale.ts'], filesToCreate: [] }),
        action({ type: 'read_file', path: 'src/stale.ts' }),
        action({
          type: 'patch_file',
          path: 'src/stale.ts',
          find: 'before',
          replace: 'after',
          expectedRevision: 999,
        }),
      ],
      { maxConsecutiveFailures: 1 },
    );

    const paused = await start(manager);
    const failed = await manager.submitApproval(paused.runId, 'approve');
    expect(failed.state).toBe('failed');
    expect(await read('src/stale.ts')).toBe('before\n');
  });

  it('rejects path traversal before anything is written', async () => {
    const { manager } = build(
      [
        plan({ filesToCreate: ['../escape.ts'] }),
        action({ type: 'create_file', path: '../escape.ts', content: 'nope\n' }),
      ],
      { maxConsecutiveFailures: 1 },
    );

    const paused = await start(manager);
    const failed = await manager.submitApproval(paused.runId, 'approve');
    expect(failed.state).toBe('failed');
    const root = await env.projectEngine.files.listDirectory(env.workspaceId, '');
    expect(root.map((node) => node.path)).not.toContain('../escape.ts');
  });

  it('rejects secret-shaped content in a model action', async () => {
    await env.projectEngine.files.createFile(env.workspaceId, {
      path: 'src/env.ts',
      content: 'export const name = "x";\n',
    });

    const { manager } = build([
      plan({ filesToInspect: ['src/env.ts'], filesToCreate: [] }),
      action({ type: 'read_file', path: 'src/env.ts' }),
      action({
        type: 'patch_file',
        path: 'src/env.ts',
        find: 'export const name = "x";',
        replace: 'export const apiKey = "sk-live-abcdef1234567890";',
      }),
    ]);

    const paused = await start(manager);
    const failed = await manager.submitApproval(paused.runId, 'approve');
    expect(failed.state).toBe('failed');
    expect(failed.failure?.code).toBe('CODING_SECRET_REJECTED');
    expect(await read('src/env.ts')).toBe('export const name = "x";\n');
  });

  it('diagnoses a failing validation, applies the correction and re-validates', async () => {
    await env.projectEngine.files.createFile(env.workspaceId, {
      path: 'src/math.ts',
      content: 'export const total = 1;\n',
    });

    const { manager, client, source } = build([
      plan({ filesToInspect: ['src/math.ts'], filesToCreate: [] }),
      action({ type: 'read_file', path: 'src/math.ts' }),
      action({ type: 'validate', command: 'npm', arguments: ['run', 'fail'] }),
      action({ type: 'patch_file', path: 'src/math.ts', find: 'total = 1', replace: 'total = 2' }),
      action({ type: 'validate', command: 'npm', arguments: ['test'] }),
      COMPLETE,
    ]);

    const paused = await start(manager);
    const validating = await manager.submitApproval(paused.runId, 'approve');
    // sandbox.execute is HIGH risk: the first validation needs its own confirmation
    expect(validating.pendingApproval).toMatchObject({
      kind: 'tool_confirmation',
      toolId: CODING_TOOL_IDS.sandboxExecute,
    });

    const afterFail = await manager.submitApproval(paused.runId, 'approve');
    expect(afterFail.validationResults).toHaveLength(1);
    expect(afterFail.validationResults[0]?.passed).toBe(false);
    // After the failure the model patched the cause, then asked for the second
    // validation - which is itself a risky tool, so it paused again.
    expect(afterFail.pendingApproval).toMatchObject({ kind: 'tool_confirmation' });

    const done = await manager.submitApproval(paused.runId, 'approve');

    expect(done.state).toBe('completed');
    expect(done.validationResults.map((result) => result.passed)).toEqual([false, true]);
    expect(await read('src/math.ts')).toContain('total = 2');
    expect(client.calls).toBe(6);
    expect(source.exchanges()).toHaveLength(6);
  });

  it('honours cancellation while the model is still working', async () => {
    const controller = new AbortController();
    let started = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const client: CodingModelClient = {
      providerName: 'Slow Provider',
      async complete() {
        started = true;
        await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 5))]);
        throw new Error('aborted by caller');
      },
    };
    const manager = new CodingAgentManager({
      tools: env.tools,
      decisionSource: createModelCodingDecisionSource({
        client,
        signalFor: () => controller.signal,
      }),
      now: NOW,
      requirePlanApproval: true,
    });

    const pending = start(manager);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(true);
    const runId = (manager as unknown as { runs: Map<string, unknown> }).runs.keys().next()
      .value as string;
    manager.cancelRun(runId);
    controller.abort();
    release?.();

    const view = await pending;
    expect(view.state).toBe('cancelled');
    expect(view.phase).toBe('cancelled');
  });

  it('reports the tools the model may invoke, without any back door', async () => {
    const { manager, source } = build([plan(), action({ type: 'inspect_project' }), COMPLETE]);
    const paused = await start(manager);
    const done = await manager.submitApproval(paused.runId, 'approve');
    expect(done.state).toBe('completed');
    // The allowlist is empty here, so the model was told nothing is invokable.
    expect(source.exchanges().length).toBe(3);
  });
});

describe('model-powered coding agent: failure reporting', () => {
  /**
   * Regression (live QA, Step 35): a model error used to reach the run manager as
   * a foreign error class, so every real provider failure was reported as the
   * generic `CODING_INVALID_DECISION` with the message "invalid decision". The
   * actual cause - a provider outage, an empty answer, no provider at all - was
   * invisible to the caller.
   */
  let env: CodingFixtureEnvironment;

  beforeEach(async () => {
    env = await createCodingFixtureEnvironment({ now: NOW });
    await env.projectEngine.files.createDirectory(env.workspaceId, 'src');
  });

  function buildWith(
    client: CodingModelClient,
    signalFor?: (runId: string) => AbortSignal | undefined,
  ): CodingAgentManager {
    return new CodingAgentManager({
      tools: env.tools,
      decisionSource: createModelCodingDecisionSource({
        client,
        maxRepairAttempts: 0,
        ...(signalFor !== undefined ? { signalFor } : {}),
      }),
      now: NOW,
      requirePlanApproval: true,
    });
  }

  async function failedRun(client: CodingModelClient): Promise<CodingRunView> {
    const manager = buildWith(client);
    return manager.startRun({
      projectId: env.projectId,
      workspaceId: env.workspaceId,
      userRequirement: 'Add a greet module',
    });
  }

  it('reports a provider outage as CODING_MODEL_PROVIDER_ERROR', async () => {
    const view = await failedRun({
      providerName: 'Fake Provider',
      async complete() {
        throw new Error('the provider returned 503');
      },
    });
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('CODING_MODEL_PROVIDER_ERROR');
  });

  it('reports an unreadable answer as CODING_MODEL_INVALID_OUTPUT', async () => {
    const view = await failedRun({
      providerName: 'Fake Provider',
      async complete() {
        return reply('Sure! I would add a small module for you.');
      },
    });
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('CODING_MODEL_INVALID_OUTPUT');
    // The refusal names the parse problem, not a generic decision error.
    expect(view.failure?.message).toMatch(/json|decision/i);
  });

  it('reports a simulated answer as CODING_MODEL_UNAVAILABLE, never as a plan', async () => {
    const view = await failedRun({
      providerName: 'Fake Provider',
      async complete() {
        return { text: plan(), providerId: 'mock', modelId: 'fixture', live: false };
      },
    });
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('CODING_MODEL_UNAVAILABLE');
    expect(view.plan).toBeNull();
  });

  it('keeps a cancellation typed as CODING_MODEL_CANCELLED', async () => {
    // Cancelling during a model call must not read as a failure the run caused.
    const controller = new AbortController();
    const manager = buildWith(
      {
        providerName: 'Fake Provider',
        async complete(request) {
          controller.abort();
          if (request.signal?.aborted) throw new Error('aborted by the caller');
          return reply(plan());
        },
      },
      () => controller.signal,
    );
    const view = await manager.startRun({
      projectId: env.projectId,
      workspaceId: env.workspaceId,
      userRequirement: 'Add a greet module',
    });
    expect(view.failure?.code).toBe('CODING_MODEL_CANCELLED');
  });
});
