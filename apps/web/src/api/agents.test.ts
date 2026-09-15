import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './client';
import {
  cancelAgentRun,
  createAgentRun,
  getAgentRun,
  isTerminalRunStatus,
  listAgents,
} from './agents';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const RUN = {
  runId: 'run-1',
  agentId: 'agent.demo.answer',
  status: 'completed',
  iteration: 3,
  toolCallCount: 0,
  toolResults: [],
  finalOutput: 'Veltravia AI is a platform for building software with AI.',
  createdAt: '2026-09-15T07:00:00.000Z',
  updatedAt: '2026-09-15T07:00:01.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('agents api', () => {
  describe('listAgents', () => {
    it('requests GET /api/agents and returns summaries', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(200, {
          agents: [{ id: 'agent.demo.answer', displayName: 'Demo Answer Agent', description: 'd' }],
        }),
      );
      vi.stubGlobal('fetch', fetchImpl);
      const agents = await listAgents();
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/agents',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(agents).toEqual([
        { id: 'agent.demo.answer', displayName: 'Demo Answer Agent', description: 'd' },
      ]);
    });

    it('rejects malformed lists', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(200, { agents: 'nope' })),
      );
      await expect(listAgents()).rejects.toThrow(/invalid agent list payload/i);
    });
  });

  describe('createAgentRun', () => {
    it('sends agentId, task, and projectId to POST /api/agents/run', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, RUN));
      vi.stubGlobal('fetch', fetchImpl);
      const run = await createAgentRun({
        agentId: 'agent.demo.answer',
        task: 'Explain the project',
        projectId: 'prj-1',
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/agents/run',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            agentId: 'agent.demo.answer',
            task: 'Explain the project',
            projectId: 'prj-1',
          }),
        }),
      );
      expect(run.runId).toBe('run-1');
      expect(run.status).toBe('completed');
      expect(run.finalOutput).toBe(RUN.finalOutput);
      // Internal counters are dropped from the view model.
      expect(run).not.toHaveProperty('iteration');
      expect(run).not.toHaveProperty('toolResults');
    });

    it('omits projectId when not provided', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, RUN));
      vi.stubGlobal('fetch', fetchImpl);
      await createAgentRun({ agentId: 'a', task: 't' });
      const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body).toEqual({ agentId: 'a', task: 't' });
    });

    it('normalizes API errors to ApiError', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(404, {
            error: { code: 'AGENT_NOT_FOUND', message: 'No agent "x".' },
          }),
        ),
      );
      const error = await createAgentRun({ agentId: 'x', task: 't' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('AGENT_NOT_FOUND');
    });

    it('rejects malformed run payloads', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(200, { runId: 'run-1' })),
      );
      await expect(createAgentRun({ agentId: 'a', task: 't' })).rejects.toThrow(
        /invalid agent run payload/i,
      );
    });

    it('rejects unknown statuses instead of guessing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(200, { ...RUN, status: 'hacking' })),
      );
      await expect(createAgentRun({ agentId: 'a', task: 't' })).rejects.toThrow(
        /invalid agent run payload/i,
      );
    });
  });

  describe('getAgentRun / cancelAgentRun', () => {
    it('gets a run by encoded id', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, RUN));
      vi.stubGlobal('fetch', fetchImpl);
      const run = await getAgentRun('run 1');
      expect(fetchImpl).toHaveBeenCalledWith('/api/agents/runs/run%201', expect.anything());
      expect(run.runId).toBe('run-1');
    });

    it('posts cancellation without a body', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(200, { ...RUN, status: 'cancelled', finalOutput: undefined }),
      );
      vi.stubGlobal('fetch', fetchImpl);
      const run = await cancelAgentRun('run-1');
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/agents/runs/run-1/cancel',
        expect.objectContaining({ method: 'POST', body: undefined }),
      );
      expect(run.status).toBe('cancelled');
      expect(run.finalOutput).toBeNull();
    });

    it('maps network failures to a NETWORK ApiError', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      );
      const error = await getAgentRun('run-1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('NETWORK');
    });
  });

  describe('isTerminalRunStatus', () => {
    it('treats completed, failed, cancelled, and limit_reached as terminal', () => {
      expect(isTerminalRunStatus('completed')).toBe(true);
      expect(isTerminalRunStatus('failed')).toBe(true);
      expect(isTerminalRunStatus('cancelled')).toBe(true);
      expect(isTerminalRunStatus('limit_reached')).toBe(true);
      expect(isTerminalRunStatus('awaiting_tool')).toBe(false);
      expect(isTerminalRunStatus('awaiting_confirmation')).toBe(false);
    });
  });
});
