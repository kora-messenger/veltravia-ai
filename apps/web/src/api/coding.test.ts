// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as coding from './coding';

/**
 * The coding client is the only path the builder has to the agent, so its
 * mapping is tested against malformed payloads: a broken response must throw a
 * readable error rather than render `undefined` into a plan card.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const runPayload = {
  runId: 'run-1',
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  state: 'awaiting_approval',
  summary: null,
  changedFiles: ['src/pages/Home.tsx'],
  iterations: 1,
  toolCalls: 2,
  startedAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:10.000Z',
  pendingApproval: { kind: 'plan_approval' },
  plan: {
    goal: 'Add a pricing page',
    steps: [{ summary: 'Read the router' }, { summary: 'Create the page' }],
    filesToInspect: ['src/App.tsx'],
    filesToModify: ['src/pages/Pricing.tsx'],
    validations: ['npm run build'],
    acceptanceCriteria: ['Build passes'],
  },
  failure: null,
};

describe('coding client', () => {
  it('maps a plan approval run, converting step objects to summaries', () => {
    const view = coding.toCodingRunView(runPayload);
    expect(view.state).toBe('awaiting_approval');
    expect(view.plan?.goal).toBe('Add a pricing page');
    expect(view.plan?.steps).toEqual(['Read the router', 'Create the page']);
    expect(view.plan?.filesToModify).toEqual(['src/pages/Pricing.tsx']);
    expect(view.pendingApproval).toEqual({ kind: 'plan_approval' });
  });

  it('rejects a payload without a run id', () => {
    expect(() => coding.toCodingRunView({ state: 'completed' })).toThrow(/Invalid run payload/);
  });

  it('rejects an unknown state instead of guessing', () => {
    expect(() => coding.toCodingRunView({ ...runPayload, state: 'dreaming' })).toThrow(
      /Invalid run payload/,
    );
  });

  it('treats a missing plan as absent, not as an error', () => {
    const view = coding.toCodingRunView({ ...runPayload, plan: null, pendingApproval: null });
    expect(view.plan).toBeNull();
    expect(view.pendingApproval).toBeNull();
  });

  it('keeps a tool confirmation id', () => {
    const view = coding.toCodingRunView({
      ...runPayload,
      pendingApproval: { kind: 'tool_confirmation', toolId: 'sandbox.execute' },
    });
    expect(view.pendingApproval).toEqual({
      kind: 'tool_confirmation',
      toolId: 'sandbox.execute',
    });
  });

  it('starts a run with the requirement and pinned workspace', async () => {
    fetchMock.mockResolvedValue(jsonResponse(runPayload));
    await coding.startCodingRun({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      userRequirement: 'Add a pricing page',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/coding/runs');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      userRequirement: 'Add a pricing page',
    });
  });

  it('sends a decision as a body, not a query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...runPayload, state: 'completed' }));
    const view = await coding.submitCodingDecision('run-1', 'approve');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/coding/runs/run-1/confirmation');
    expect(JSON.parse(String(init?.body))).toEqual({ decision: 'approve' });
    expect(view.state).toBe('completed');
  });

  it('reports capabilities with a safe default when the field is odd', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ capabilities: { decisionSource: 'mystery' } }));
    const capabilities = await coding.fetchCodingCapabilities();
    expect(capabilities.decisionSource).toBe('scripted-demo');
    expect(capabilities.planApprovalRequired).toBe(true);
  });

  it('treats only completed, failed and cancelled as terminal', () => {
    expect(coding.isCodingRunTerminal('completed')).toBe(true);
    expect(coding.isCodingRunTerminal('failed')).toBe(true);
    expect(coding.isCodingRunTerminal('cancelled')).toBe(true);
    expect(coding.isCodingRunTerminal('validating')).toBe(false);
  });
});
