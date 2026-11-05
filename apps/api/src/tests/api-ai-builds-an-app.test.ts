import { describe, expect, it } from 'vitest';
import {
  ReasoningEngine,
  type ProviderRequest,
  type ProviderResult,
  type ReasoningProvider,
} from '@veltravia/reasoning-core';
import { createProjectEngine, createSequentialIdGenerator } from '@veltravia/project-mock';
import { createAppBuilderManager } from '../app-builder-service.js';
import { createToolManager } from '../tools.js';

/**
 * The whole path a person cares about: they ask the assistant to make an app,
 * the assistant plans it and asks to create the project, nothing is written
 * until the person approves, and the files are real afterwards.
 *
 * The model is scripted (its choices are fixed so the test is repeatable), but
 * the reasoning engine, the Tool System, the App Builder and the project engine
 * are the real ones.
 */
const NOW = () => new Date('2026-11-05T09:00:00.000Z');
const OWNER = 'owner-a';
const FINAL = 'I planned the app and created the project.';

class ScriptedProvider implements ReasoningProvider {
  readonly id = 'scripted';
  readonly live = true;
  readonly streams = false;
  private readonly queue: string[];
  constructor(replies: readonly unknown[]) {
    this.queue = replies.map((reply) => JSON.stringify(reply));
  }
  async complete(_request: ProviderRequest): Promise<ProviderResult> {
    const next = this.queue.shift();
    // Nothing scripted left: the engine is asking for the final wording.
    return { content: next ?? FINAL, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const SPEC = { name: 'Notes App', projectKind: 'web', frontend: 'react' };

function harness() {
  const projects = createProjectEngine({
    now: NOW,
    generateProjectId: createSequentialIdGenerator('prj'),
    generateWorkspaceId: createSequentialIdGenerator('ws'),
    generateNodeId: createSequentialIdGenerator('node'),
  });
  const manager = createAppBuilderManager({ projectEngine: projects, codingAgent: {} as never });
  const tools = createToolManager(
    NOW,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    OWNER,
    undefined,
    { manager, projects },
  );
  return { projects, manager, tools };
}

/**
 * The model asks to plan, then (with the plan's id, which a real model would
 * read from the first result) asks to create the project. The plan id is
 * filled in by the provider once the first tool has run.
 */
function scriptFor(planIdRef: { id: string }) {
  const classification = { taskType: 'action', needsTools: true, rationale: 'make an app' };
  const plan = {
    goal: 'Plan and create the app',
    steps: [{ intent: 'plan', toolId: 'appbuilder.create_plan', input: { specification: SPEC } }],
  };
  const askPlan = {
    type: 'tool',
    intent: 'plan',
    toolId: 'appbuilder.create_plan',
    input: { specification: SPEC },
  };
  const done = { type: 'answer', answer: 'Planned.', complete: true, summary: 'Planned.' };
  return { classification, plan, askPlan, done, planIdRef };
}

describe('the assistant makes an app', () => {
  it('plans, stops for approval before writing, and writes real files once approved', async () => {
    const { projects, manager, tools } = harness();
    const ref = { id: '' };
    const s = scriptFor(ref);

    // Turn 1 plans. Its result carries the plan id, so turn 2 can use it.
    const first = new ScriptedProvider([s.classification, s.plan, s.askPlan, s.done]);
    const engine = new ReasoningEngine({
      provider: first,
      tools,
      now: NOW,
    });
    const availableTools = tools
      .list()
      .map((definition) => definition.id)
      .filter((id) => id.startsWith('appbuilder.'));

    const planned = await engine.run({
      profile: 'agent',
      task: 'Make me a notes app.',
      availableTools,
      limits: { maxToolCalls: 1 },
    });
    expect(planned.steps[0]?.toolId).toBe('appbuilder.create_plan');
    expect(planned.steps[0]?.status).toBe('success');
    const planId = (planned.steps[0]?.output as { plan: { id: string } }).plan.id;
    expect(planId).toBeTruthy();
    // Planning is not building: no project exists yet.
    expect((await projects.projects.listProjects()).length).toBe(0);

    // Turn 2: the model asks to create the project from that plan.
    const second = new ScriptedProvider([
      s.classification,
      {
        goal: 'Create the project',
        steps: [
          {
            intent: 'create',
            toolId: 'appbuilder.create_project_from_plan',
            input: { planId },
          },
        ],
      },
      {
        type: 'tool',
        intent: 'create',
        toolId: 'appbuilder.create_project_from_plan',
        input: { planId },
      },
    ]);
    const engine2 = new ReasoningEngine({ provider: second, tools, now: NOW });
    const paused = await engine2.run({
      profile: 'agent',
      task: 'Create the project from the plan.',
      availableTools,
    });

    // It stopped and is asking a person. Nothing has been written.
    expect(paused.status).toBe('awaiting_confirmation');
    expect(paused.pendingConfirmation?.toolId).toBe('appbuilder.create_project_from_plan');
    expect((await projects.projects.listProjects()).length).toBe(0);

    // A person approves; only now does the project appear.
    // What the API's confirmation route does: the Tool System records the
    // person's decision first, then the engine carries on.
    const confirmationId = paused.pendingConfirmation!.confirmationId;
    tools.confirm(confirmationId, 'approved');
    const resumed = await engine2.resume(paused.id, confirmationId, 'approved');
    expect(resumed.steps.find((step) => step.status === 'success')?.toolId).toBe(
      'appbuilder.create_project_from_plan',
    );
    const all = await projects.projects.listProjects();
    expect(all.length).toBe(1);
    expect(all[0]?.name).toBe('Notes App');
    const workspaces = await projects.workspaces.listWorkspaces(all[0]!.id);
    const files = await projects.files.listAll(workspaces[0]!.id);
    const paths = files.filter((node) => node.type === 'file').map((node) => node.path);
    expect(paths).toContain('package.json');
    expect(paths.length).toBeGreaterThan(3);
    // The plan is spent: it cannot be written twice.
    await expect(manager.materializePlan({ ownerRef: OWNER, planId })).rejects.toThrow();
  });

  it('is denied when the engine resumes without the person having decided', async () => {
    // The engine passing "approved" is not an approval. Only the Tool System
    // can release a paused call, and only after a person's decision reaches it.
    const { projects, tools } = harness();
    const s = scriptFor({ id: '' });
    const availableTools = tools
      .list()
      .map((definition) => definition.id)
      .filter((id) => id.startsWith('appbuilder.'));
    const engine = new ReasoningEngine({
      provider: new ScriptedProvider([s.classification, s.plan, s.askPlan, s.done]),
      tools,
      now: NOW,
    });
    const planned = await engine.run({
      profile: 'agent',
      task: 'Make me a notes app.',
      availableTools,
      limits: { maxToolCalls: 1 },
    });
    const planId = (planned.steps[0]?.output as { plan: { id: string } }).plan.id;
    const engine2 = new ReasoningEngine({
      provider: new ScriptedProvider([
        s.classification,
        {
          goal: 'Create',
          steps: [
            { intent: 'create', toolId: 'appbuilder.create_project_from_plan', input: { planId } },
          ],
        },
        {
          type: 'tool',
          intent: 'create',
          toolId: 'appbuilder.create_project_from_plan',
          input: { planId },
        },
      ]),
      tools,
      now: NOW,
    });
    const paused = await engine2.run({
      profile: 'agent',
      task: 'Create the project from the plan.',
      availableTools,
    });
    // No tools.confirm(): nobody decided.
    const resumed = await engine2.resume(
      paused.id,
      paused.pendingConfirmation!.confirmationId,
      'approved',
    );
    expect(resumed.steps.some((step) => step.status === 'success')).toBe(false);
    expect((await projects.projects.listProjects()).length).toBe(0);
  });

  it('writes nothing when the person refuses', async () => {
    const { projects, tools } = harness();
    const s = scriptFor({ id: '' });
    const availableTools = tools
      .list()
      .map((definition) => definition.id)
      .filter((id) => id.startsWith('appbuilder.'));

    const engine = new ReasoningEngine({
      provider: new ScriptedProvider([s.classification, s.plan, s.askPlan, s.done]),
      tools,
      now: NOW,
    });
    const planned = await engine.run({
      profile: 'agent',
      task: 'Make me a notes app.',
      availableTools,
      limits: { maxToolCalls: 1 },
    });
    const planId = (planned.steps[0]?.output as { plan: { id: string } }).plan.id;

    const engine2 = new ReasoningEngine({
      provider: new ScriptedProvider([
        s.classification,
        {
          goal: 'Create the project',
          steps: [
            {
              intent: 'create',
              toolId: 'appbuilder.create_project_from_plan',
              input: { planId },
            },
          ],
        },
        {
          type: 'tool',
          intent: 'create',
          toolId: 'appbuilder.create_project_from_plan',
          input: { planId },
        },
        {
          type: 'answer',
          answer: 'Understood, nothing was created.',
          complete: true,
          summary: 'Declined.',
        },
      ]),
      tools,
      now: NOW,
    });
    const paused = await engine2.run({
      profile: 'agent',
      task: 'Create the project from the plan.',
      availableTools,
    });
    expect(paused.status).toBe('awaiting_confirmation');
    await engine2.resume(paused.id, paused.pendingConfirmation!.confirmationId, 'rejected');
    expect((await projects.projects.listProjects()).length).toBe(0);
  });

  it('cannot approve its own request: resuming needs the confirmation it was given', async () => {
    const { tools } = harness();
    const s = scriptFor({ id: '' });
    const availableTools = tools
      .list()
      .map((definition) => definition.id)
      .filter((id) => id.startsWith('appbuilder.'));
    const engine = new ReasoningEngine({
      provider: new ScriptedProvider([s.classification, s.plan, s.askPlan, s.done]),
      tools,
      now: NOW,
    });
    const planned = await engine.run({
      profile: 'agent',
      task: 'Make me a notes app.',
      availableTools,
      limits: { maxToolCalls: 1 },
    });
    const planId = (planned.steps[0]?.output as { plan: { id: string } }).plan.id;
    const engine2 = new ReasoningEngine({
      provider: new ScriptedProvider([
        s.classification,
        {
          goal: 'Create',
          steps: [
            {
              intent: 'create',
              toolId: 'appbuilder.create_project_from_plan',
              input: { planId },
            },
          ],
        },
        {
          type: 'tool',
          intent: 'create',
          toolId: 'appbuilder.create_project_from_plan',
          input: { planId },
        },
      ]),
      tools,
      now: NOW,
    });
    const paused = await engine2.run({
      profile: 'agent',
      task: 'Create the project from the plan.',
      availableTools,
    });
    await expect(
      engine2.resume(paused.id, 'a-confirmation-id-it-invented', 'approved'),
    ).rejects.toThrow();
  });
});
