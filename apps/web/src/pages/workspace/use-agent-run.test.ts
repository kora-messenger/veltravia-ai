import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AgentRunView, PendingConfirmationView } from '../../api/agents';
import { useAgentRun } from './use-agent-run';

const TERMINAL = ['completed', 'failed', 'cancelled', 'limit_reached'] as const;

vi.mock('../../api/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/agents')>();
  return {
    ...actual,
    createAgentRun: vi.fn(),
    getAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    submitAgentConfirmation: vi.fn(),
  };
});

import {
  cancelAgentRun,
  createAgentRun,
  getAgentRun,
  submitAgentConfirmation,
} from '../../api/agents';

const mockedCreate = vi.mocked(createAgentRun);
const mockedGet = vi.mocked(getAgentRun);
const mockedCancel = vi.mocked(cancelAgentRun);
const mockedSubmitConfirmation = vi.mocked(submitAgentConfirmation);

function run(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: 'run-1',
    agentId: 'agent.demo.answer',
    status: 'completed',
    finalOutput: 'Here is the answer.',
    toolResults: [],
    pendingConfirmation: null,
    error: null,
    limitReason: null,
    createdAt: '2026-09-15T07:00:00.000Z',
    updatedAt: '2026-09-15T07:00:01.000Z',
    ...overrides,
  };
}

function pending(overrides: Partial<PendingConfirmationView> = {}): PendingConfirmationView {
  return {
    confirmationId: 'conf-1',
    toolId: 'mock.purge',
    invocationId: 'inv-1',
    riskLevel: 'critical',
    state: 'required',
    requestedAt: '2026-09-15T07:00:00.000Z',
    expiresAt: '2026-09-15T07:05:00.000Z',
    ...overrides,
  };
}

function useHook(agentId: string | null = 'agent.demo.answer') {
  return renderHook(() => useAgentRun({ agentId, projectId: 'prj-1' }));
}

const FLUSH = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  mockedSubmitConfirmation.mockReset();
  mockedCreate.mockReset();
  mockedGet.mockReset();
  mockedCancel.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useAgentRun', () => {
  it('starts idle and rejects empty prompts', async () => {
    const { result } = useHook();
    expect(result.current.state.phase).toBe('idle');
    await act(async () => {
      result.current.start('   ');
    });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('is a no-op without an agent', async () => {
    const { result } = useHook(null);
    await act(async () => {
      result.current.start('Do something');
    });
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
  });

  it('creates a real run and maps a completed response', async () => {
    mockedCreate.mockResolvedValue(run({ finalOutput: 'The answer.' }));
    const { result } = useHook();
    await act(async () => {
      result.current.start('Explain the project');
    });
    expect(mockedCreate).toHaveBeenCalledWith({
      agentId: 'agent.demo.answer',
      task: 'Explain the project',
      projectId: 'prj-1',
    });
    expect(result.current.state.phase).toBe('completed');
    expect(result.current.state.finalOutput).toBe('The answer.');
    expect(result.current.state.retryable).toBe(false);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('maps failed runs to an honest failure with the server message', async () => {
    mockedCreate.mockResolvedValue(
      run({
        status: 'failed',
        finalOutput: null,
        error: { code: 'AGENT_MODEL_ERROR', message: 'The model could not be reached.' },
      }),
    );
    const { result } = useHook();
    await act(async () => {
      result.current.start('Anything');
    });
    expect(result.current.state.phase).toBe('failed');
    expect(result.current.state.failureMessage).toContain('The model could not be reached.');
    expect(result.current.state.finalOutput).toBeNull();
    expect(result.current.state.retryable).toBe(true);
  });

  it('maps cancelled runs and offers retry', async () => {
    mockedCreate.mockResolvedValue(run({ status: 'cancelled', finalOutput: null }));
    const { result } = useHook();
    await act(async () => {
      result.current.start('Anything');
    });
    expect(result.current.state.phase).toBe('cancelled');
    expect(result.current.state.retryable).toBe(true);
  });

  it('maps limit_reached runs with the limit reason', async () => {
    mockedCreate.mockResolvedValue(
      run({ status: 'limit_reached', finalOutput: null, limitReason: 'iteration budget' }),
    );
    const { result } = useHook();
    await act(async () => {
      result.current.start('Anything');
    });
    expect(result.current.state.phase).toBe('limit-reached');
    expect(result.current.state.failureMessage).toContain('iteration budget');
  });

  it('rejects a second submission while a run is active (no duplicate create)', async () => {
    let resolveFirst: (value: AgentRunView) => void = () => {};
    mockedCreate.mockImplementation(
      () =>
        new Promise<AgentRunView>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { result } = useHook();
    await act(async () => {
      result.current.start('First');
    });
    expect(result.current.state.phase).toBe('creating');
    await act(async () => {
      result.current.start('Second');
      result.current.start('Second again');
    });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst(run({ runId: 'run-1' }));
    });
    expect(result.current.state.phase).toBe('completed');
  });

  it('shows a creation error without inventing an answer', async () => {
    mockedCreate.mockRejectedValue(new Error('network down'));
    const { result } = useHook();
    await act(async () => {
      result.current.start('Explain the project');
    });
    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.failureMessage).toContain('not answered');
    expect(result.current.state.finalOutput).toBeNull();
    expect(result.current.state.retryable).toBe(true);
  });

  describe('polling', () => {
    it('polls a non-terminal run and stops on completion', async () => {
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      expect(result.current.state.phase).toBe('running');
      expect(mockedGet).not.toHaveBeenCalled();

      mockedGet.mockResolvedValueOnce(run({ status: 'awaiting_tool', finalOutput: null }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(mockedGet).toHaveBeenCalledTimes(1);
      expect(result.current.state.phase).toBe('running');

      mockedGet.mockResolvedValueOnce(run({ status: 'completed' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(result.current.state.phase).toBe('completed');
      // Terminal: no further polls.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(mockedGet).toHaveBeenCalledTimes(2);
    });

    it('stops polling on a failed or cancelled run', async () => {
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      mockedGet.mockResolvedValueOnce(run({ status: 'failed', finalOutput: null }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(result.current.state.phase).toBe('failed');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(mockedGet).toHaveBeenCalledTimes(1);
    });

    it('follows a paused run on the SLOW cadence so the server stays authoritative', async () => {
      mockedCreate.mockResolvedValue(
        run({ status: 'awaiting_confirmation', finalOutput: null, pendingConfirmation: pending() }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      expect(result.current.state.phase).toBe('paused');
      // Fast cadence never fires while paused.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(mockedGet).not.toHaveBeenCalled();
      // The slow cadence does (expiry is decided server-side).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });
      expect(mockedGet).toHaveBeenCalledWith('run-1');
    });

    it('stops following a paused run once the server reports the confirmation expired', async () => {
      mockedCreate.mockResolvedValue(
        run({ status: 'awaiting_confirmation', finalOutput: null, pendingConfirmation: pending() }),
      );
      mockedGet.mockResolvedValue(
        run({
          status: 'awaiting_confirmation',
          finalOutput: null,
          pendingConfirmation: pending({ state: 'expired' }),
        }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(result.current.state.pendingConfirmation?.state).toBe('expired');
      expect(mockedGet).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
      });
      expect(mockedGet).toHaveBeenCalledTimes(1);
    });

    it('never overlaps polling requests (one timer at a time)', async () => {
      let resolvePoll: (value: AgentRunView) => void = () => {};
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      mockedGet.mockImplementation(
        () =>
          new Promise<AgentRunView>((resolve) => {
            resolvePoll = resolve;
          }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
        await vi.advanceTimersByTimeAsync(900);
        await vi.advanceTimersByTimeAsync(900);
      });
      // The in-flight poll blocks the next one.
      expect(mockedGet).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolvePoll(run({ status: 'awaiting_tool', finalOutput: null }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(mockedGet).toHaveBeenCalledTimes(2);
      expect(result.current.state.phase).toBe('running');
    });

    it('stops polling after the bounded attempt budget and flags it', async () => {
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      mockedGet.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      for (let i = 0; i < 40; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(900);
        });
      }
      expect(mockedGet).toHaveBeenCalledTimes(40);
      expect(result.current.state.pollingPaused).toBe(true);
      expect(result.current.state.phase).toBe('running');
      expect(result.current.state.cancellable).toBe(true);
      // Bounded: nothing further.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mockedGet).toHaveBeenCalledTimes(40);
    });

    it('stops after consecutive poll failures and reports the honest error', async () => {
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      mockedGet.mockRejectedValue(new Error('offline'));
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(900);
        });
      }
      expect(result.current.state.phase).toBe('error');
      expect(result.current.state.failureMessage).toContain('Lost contact');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mockedGet).toHaveBeenCalledTimes(3);
    });

    it('cleans up its timer on unmount (no polling after unmount)', async () => {
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      mockedGet.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      const hook = useHook();
      await act(async () => {
        hook.result.current.start('Work');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(mockedGet).toHaveBeenCalledTimes(1);
      hook.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mockedGet).toHaveBeenCalledTimes(1);
    });

    it('discards stale responses from a superseded run', async () => {
      // First run hangs on create.
      let resolveFirst: (value: AgentRunView) => void = () => {};
      mockedCreate.mockImplementationOnce(
        () =>
          new Promise<AgentRunView>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Old prompt');
      });
      expect(result.current.state.phase).toBe('creating');
      // Force a second submission by finishing the first run as failed.
      await act(async () => {
        resolveFirst(run({ runId: 'run-old', status: 'failed', finalOutput: null }));
      });
      expect(result.current.state.phase).toBe('failed');
      // Second (retry) run.
      mockedCreate.mockResolvedValueOnce(
        run({ runId: 'run-new', status: 'awaiting_tool', finalOutput: null }),
      );
      await act(async () => {
        result.current.retry();
      });
      expect(result.current.state.phase).toBe('running');
      // A very late poll response for the OLD run must not overwrite.
      mockedGet.mockResolvedValueOnce(
        run({ runId: 'run-old', status: 'completed', finalOutput: 'STALE' }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(result.current.state.runId).toBe('run-new');
      expect(result.current.state.finalOutput).toBeNull();
    });
  });

  describe('cancellation', () => {
    it('cancels once, and only shows cancelled after the server confirms', async () => {
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      let resolveCancel: (value: AgentRunView) => void = () => {};
      mockedCancel.mockImplementationOnce(
        () =>
          new Promise<AgentRunView>((resolve) => {
            resolveCancel = resolve;
          }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      expect(result.current.state.phase).toBe('running');
      await act(async () => {
        result.current.cancel();
        result.current.cancel();
        result.current.cancel();
      });
      expect(mockedCancel).toHaveBeenCalledTimes(1);
      // Not yet claimed: still running while the server decides.
      expect(result.current.state.phase).toBe('running');
      await act(async () => {
        resolveCancel(run({ status: 'cancelled', finalOutput: null }));
      });
      expect(result.current.state.phase).toBe('cancelled');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('keeps polling after a cancel-in-flight until the server reports terminal', async () => {
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      mockedCancel.mockResolvedValueOnce(run({ status: 'awaiting_tool', finalOutput: null }));
      mockedGet.mockResolvedValueOnce(run({ status: 'cancelled', finalOutput: null }));
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      await act(async () => {
        result.current.cancel();
      });
      expect(result.current.state.phase).toBe('running');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(result.current.state.phase).toBe('cancelled');
    });

    it('does nothing while the run is still being created (no run id yet)', async () => {
      let resolveFirst: (value: AgentRunView) => void = () => {};
      mockedCreate.mockImplementation(
        () =>
          new Promise<AgentRunView>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      await act(async () => {
        result.current.cancel();
      });
      expect(mockedCancel).not.toHaveBeenCalled();
      await act(async () => {
        resolveFirst(run({ status: 'completed' }));
      });
      expect(result.current.state.phase).toBe('completed');
    });

    it('surfaces a recoverable cancel error and resyncs state from the server', async () => {
      mockedCreate.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      mockedCancel.mockRejectedValueOnce(new Error('cancel failed'));
      mockedGet.mockResolvedValue(run({ status: 'awaiting_tool', finalOutput: null }));
      const { result } = useHook();
      await act(async () => {
        result.current.start('Work');
      });
      await act(async () => {
        result.current.cancel();
      });
      expect(result.current.state.cancelError).toContain('did not go through');
      // The run state was preserved, not destroyed.
      expect(result.current.state.phase).toBe('running');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      // Bounded polling legitimately continues while the run is live; the
      // note stays visible because the user must still see their cancel
      // failed.
      expect(result.current.state.cancelError).toContain('did not go through');
      expect(result.current.state.phase).toBe('running');
      // A later confirmed terminal state clears it.
      mockedGet.mockReset();
      mockedGet.mockResolvedValueOnce(run({ status: 'completed' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(result.current.state.phase).toBe('completed');
      expect(result.current.state.cancelError).toBeNull();
    });
  });

  describe('retry', () => {
    it('retries a failed run as a NEW run with the same prompt', async () => {
      mockedCreate.mockResolvedValueOnce(
        run({ runId: 'run-1', status: 'failed', finalOutput: null }),
      );
      mockedCreate.mockResolvedValueOnce(run({ runId: 'run-2', status: 'completed' }));
      const { result } = useHook();
      await act(async () => {
        result.current.start('Same prompt');
      });
      expect(result.current.state.phase).toBe('failed');
      await act(async () => {
        result.current.retry();
      });
      expect(mockedCreate).toHaveBeenCalledTimes(2);
      expect(mockedCreate).toHaveBeenLastCalledWith({
        agentId: 'agent.demo.answer',
        task: 'Same prompt',
        projectId: 'prj-1',
      });
      expect(result.current.state.runId).toBe('run-2');
      expect(result.current.state.phase).toBe('completed');
      expect(result.current.state.finalOutput).toBe('Here is the answer.');
    });

    it('does not retry a completed run', async () => {
      mockedCreate.mockResolvedValueOnce(run({ runId: 'run-1', status: 'completed' }));
      const { result } = useHook();
      await act(async () => {
        result.current.start('Prompt');
      });
      await act(async () => {
        result.current.retry();
      });
      expect(mockedCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('terminal mapping sanity', () => {
    it('keeps every terminal backend status honest', async () => {
      for (const status of TERMINAL) {
        mockedCreate.mockReset();
        mockedCreate.mockResolvedValueOnce(
          run({ status, finalOutput: status === 'completed' ? 'ok' : null }),
        );
        const { result } = useHook();
        await act(async () => {
          result.current.start('p');
        });
        if (status === 'completed') {
          expect(result.current.state.phase).toBe('completed');
          expect(result.current.state.finalOutput).toBe('ok');
        } else if (status === 'failed') {
          expect(result.current.state.phase).toBe('failed');
        } else if (status === 'cancelled') {
          expect(result.current.state.phase).toBe('cancelled');
        } else {
          expect(result.current.state.phase).toBe('limit-reached');
        }
        await act(async () => {});
        cleanup();
      }
    });
  });

  describe('confirmation decisions', () => {
    it('sends the decision to the server and applies the authoritative response', async () => {
      mockedCreate.mockResolvedValue(
        run({ status: 'awaiting_confirmation', finalOutput: null, pendingConfirmation: pending() }),
      );
      mockedSubmitConfirmation.mockResolvedValue(
        run({
          status: 'completed',
          finalOutput: 'Done after approval.',
          toolResults: [
            {
              invocationId: 'inv-1',
              toolId: 'mock.purge',
              status: 'success',
              output: { purged: true },
              error: null,
              requestedAt: '2026-09-15T07:00:02.000Z',
              completedAt: '2026-09-15T07:00:03.000Z',
            },
          ],
        }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Purge the demo data.');
      });
      expect(result.current.state.phase).toBe('paused');
      await act(async () => {
        result.current.submitConfirmation('approve');
      });
      expect(mockedSubmitConfirmation).toHaveBeenCalledWith('run-1', 'approve');
      expect(result.current.state.phase).toBe('completed');
      expect(result.current.state.finalOutput).toBe('Done after approval.');
      expect(result.current.state.toolResults[0]?.toolId).toBe('mock.purge');
      expect(result.current.state.pendingConfirmation).toBeNull();
    });

    it('rejects through the server and shows the run the server reports', async () => {
      mockedCreate.mockResolvedValue(
        run({ status: 'awaiting_confirmation', finalOutput: null, pendingConfirmation: pending() }),
      );
      mockedSubmitConfirmation.mockResolvedValue(
        run({
          status: 'completed',
          finalOutput: 'The request was denied; nothing was executed.',
          toolResults: [
            {
              invocationId: 'inv-1',
              toolId: 'mock.purge',
              status: 'denied',
              output: null,
              error: { code: 'TOOL_CONFIRMATION_REJECTED', message: 'rejected by the human' },
              requestedAt: '2026-09-15T07:00:02.000Z',
              completedAt: '2026-09-15T07:00:03.000Z',
            },
          ],
        }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Purge the demo data.');
      });
      await act(async () => {
        result.current.submitConfirmation('reject');
      });
      expect(mockedSubmitConfirmation).toHaveBeenCalledWith('run-1', 'reject');
      expect(result.current.state.toolResults[0]?.status).toBe('denied');
      expect(result.current.state.phase).toBe('completed');
    });

    it('prevents a second decision while one is in flight', async () => {
      let resolveDecision: (value: AgentRunView) => void = () => {};
      mockedCreate.mockResolvedValue(
        run({ status: 'awaiting_confirmation', finalOutput: null, pendingConfirmation: pending() }),
      );
      mockedSubmitConfirmation.mockImplementation(
        () =>
          new Promise<AgentRunView>((resolve) => {
            resolveDecision = resolve;
          }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Purge the demo data.');
      });
      await act(async () => {
        result.current.submitConfirmation('approve');
      });
      expect(result.current.state.confirmationSubmitting).toBe(true);
      await act(async () => {
        result.current.submitConfirmation('approve');
        result.current.submitConfirmation('reject');
      });
      expect(mockedSubmitConfirmation).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveDecision(run({ status: 'completed', finalOutput: 'Done.' }));
      });
      expect(result.current.state.confirmationSubmitting).toBe(false);
    });

    it('is a no-op for an expired confirmation - the server cannot resurrect it', async () => {
      mockedCreate.mockResolvedValue(
        run({
          status: 'awaiting_confirmation',
          finalOutput: null,
          pendingConfirmation: pending({ state: 'expired' }),
        }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Purge the demo data.');
      });
      await act(async () => {
        result.current.submitConfirmation('approve');
      });
      expect(mockedSubmitConfirmation).not.toHaveBeenCalled();
    });

    it('keeps the run state and shows an honest note when the decision fails', async () => {
      mockedCreate.mockResolvedValue(
        run({ status: 'awaiting_confirmation', finalOutput: null, pendingConfirmation: pending() }),
      );
      mockedSubmitConfirmation.mockRejectedValueOnce(new Error('network down'));
      mockedGet.mockResolvedValue(
        run({
          status: 'awaiting_confirmation',
          finalOutput: null,
          pendingConfirmation: pending(),
        }),
      );
      const { result } = useHook();
      await act(async () => {
        result.current.start('Purge the demo data.');
      });
      await act(async () => {
        result.current.submitConfirmation('approve');
      });
      expect(result.current.state.confirmationSubmitting).toBe(false);
      expect(result.current.state.confirmationError).not.toBeNull();
      expect(result.current.state.phase).toBe('paused');
      // One honest resync attempt from the server.
      expect(mockedGet).toHaveBeenCalledWith('run-1');
    });
  });

  it('a failed run never becomes completed through refresh alone', async () => {
    mockedCreate.mockResolvedValue(run({ runId: 'run-1', status: 'failed', finalOutput: null }));
    const { result } = useHook();
    await act(async () => {
      result.current.start('Prompt');
    });
    expect(result.current.state.phase).toBe('failed');
    // refresh() is not offered on terminal states; calling it is a no-op.
    await FLUSH();
    await act(async () => {
      result.current.refresh();
    });
    expect(mockedGet).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('failed');
  });
});
