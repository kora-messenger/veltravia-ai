import { describe, expect, it } from 'vitest';
import { AgentManager } from '@veltravia/agent-core';
import { createMockAgent } from '@veltravia/agent-mock';
import { ToolManager } from '@veltravia/tool-core';
import { createMockPurgeTool, createMockSummarizeTool } from '@veltravia/tool-mock';
import { buildApp } from '../server.js';
import { createAgentManager } from '../agents.js';

const NOW = () => new Date('2026-09-13T16:30:00.000Z');

/** The API's real agent manager (scripted demo agents, fully gated tools). */
function buildApiApp() {
  return buildApp({ agents: createAgentManager(NOW) });
}

describe('GET /api/agents', () => {
  it('lists the registered agents with safe metadata', async () => {
    const app = buildApiApp();
    const response = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.agents).toHaveLength(2);
    expect(body.agents[0]).toMatchObject({ id: 'agent.demo' });
    expect(response.body).not.toMatch(/ghp_|sk-|AIza|password/i);
    app.close();
  });
});

describe('POST /api/agents/run', () => {
  it('runs the demo tool agent end to end (offline, deterministic)', async () => {
    const app = buildApiApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'agent.demo', task: 'Summarize the Veltravia AI product.' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('completed');
    expect(body.toolCallCount).toBe(1);
    expect(body.toolResults[0]).toMatchObject({
      toolId: 'mock.summarize',
      status: 'success',
      output: { text: 'Veltravia AI', count: 2 },
    });
    // Safe response surface: no chain-of-thought, no secrets.
    expect(JSON.stringify(body)).not.toMatch(/reasoning|chainOfThought|thinking/i);
    app.close();
  });

  it('404s for unknown agents and 400s for invalid bodies', async () => {
    const app = buildApiApp();
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'ghost.agent', task: 't' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      error: {
        code: 'AGENT_NOT_FOUND',
        message: 'No agent registered with id "ghost.agent".',
        details: { agentId: 'ghost.agent' },
      },
    });
    const empty = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'agent.demo', task: '' },
    });
    expect(empty.statusCode).toBe(400);
    app.close();
  });

  it('rejects unlimited limits and caps oversized ones', async () => {
    const app = buildApiApp();
    const zero = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'agent.demo.answer', task: 't', limits: { maxIterations: 0 } },
    });
    expect(zero.statusCode).toBe(400);
    const huge = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'agent.demo.answer', task: 't', limits: { maxIterations: 10_000_000 } },
    });
    expect(huge.statusCode).toBe(200); // silently capped, never honored above the ceiling
    app.close();
  });

  it('rejects secret-shaped metadata', async () => {
    const app = buildApiApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: {
        agentId: 'agent.demo.answer',
        task: 't',
        metadata: { key: 'ghp_AbCdEf1234567890AbCdEf1234567890AbCd' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('ghp_');
    app.close();
  });
});

describe('GET /api/agents/runs/:runId', () => {
  it('returns the safe run snapshot', async () => {
    const app = buildApiApp();
    const run = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'agent.demo.answer', task: 'Explain Veltravia AI.' },
    });
    const runId = run.json().runId;
    const response = await app.inject({ method: 'GET', url: `/api/agents/runs/${runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runId, status: 'completed' });
    app.close();
  });

  it('404s for unknown runs', async () => {
    const app = buildApiApp();
    const response = await app.inject({ method: 'GET', url: '/api/agents/runs/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('AGENT_RUN_NOT_FOUND');
    app.close();
  });
});

describe('POST /api/agents/runs/:runId/cancel', () => {
  it('cancels a paused run and marks it terminal', async () => {
    // A run paused on a confirmation (built with the confirmation-gated purge tool).
    const tools = new ToolManager({ now: NOW });
    const summarize = createMockSummarizeTool();
    tools.register(summarize.definition);
    tools.registerImplementation(summarize.implementation);
    const purge = createMockPurgeTool();
    tools.register(purge.definition);
    tools.registerImplementation(purge.implementation);
    tools.grantPermission('mock.purge', 'mock.admin');
    const manager = new AgentManager({ tools, now: NOW });
    manager.register(
      createMockAgent({
        id: 'agent.purge-demo',
        displayName: 'Purge Demo',
        description: 'requests the critical-risk mock tool',
        script: [
          { type: 'request_tool', toolId: 'mock.purge', input: { confirmLabel: 'ok' } },
          { type: 'answer', output: 'done' },
        ],
        tools,
      }),
    );
    const app = buildApp({ agents: manager });

    const paused = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'agent.purge-demo', task: 'Purge.' },
    });
    expect(paused.json().status).toBe('awaiting_confirmation');
    const runId = paused.json().runId;

    const cancelled = await app.inject({ method: 'POST', url: `/api/agents/runs/${runId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');

    // Terminal: no resume, no confirmation, no second cancel.
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/agents/runs/${runId}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(confirm.statusCode).toBe(409);
    app.close();
  });
});

describe('POST /api/agents/runs/:runId/confirmation', () => {
  it('submits the human decision through the Step 5 mechanism', async () => {
    const tools = new ToolManager({ now: NOW });
    const purge = createMockPurgeTool();
    tools.register(purge.definition);
    tools.registerImplementation(purge.implementation);
    tools.grantPermission('mock.purge', 'mock.admin');
    const manager = new AgentManager({ tools, now: NOW });
    manager.register(
      createMockAgent({
        id: 'agent.purge-demo',
        displayName: 'Purge Demo',
        description: 'requests the critical-risk mock tool',
        script: [
          { type: 'request_tool', toolId: 'mock.purge', input: { confirmLabel: 'ok' } },
          { type: 'answer', output: 'purge complete' },
        ],
        tools,
      }),
    );
    const app = buildApp({ agents: manager });

    const paused = await app.inject({
      method: 'POST',
      url: '/api/agents/run',
      payload: { agentId: 'agent.purge-demo', task: 'Purge.' },
    });
    const runId = paused.json().runId;
    const approved = await app.inject({
      method: 'POST',
      url: `/api/agents/runs/${runId}/confirmation`,
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: 'completed',
      finalOutput: 'purge complete',
      toolCallCount: 1,
    });
    expect(approved.json().toolResults[0]).toMatchObject({ status: 'success' });
    app.close();
  });

  it('400s for an invalid decision value', async () => {
    const app = buildApiApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/runs/anything/confirmation',
      payload: { decision: 'self-approve' },
    });
    expect(response.statusCode).toBe(400);
    app.close();
  });
});
