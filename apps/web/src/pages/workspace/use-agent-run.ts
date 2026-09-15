/**
 * Agent-run lifecycle for the AI workspace (Step 11C-2).
 *
 * Owns exactly one active run: submitting creates a real agent run through
 * the Agent API, non-terminal states are followed with BOUNDED polling,
 * and cancellation/terminal/failure states map to explicit UI phases.
 *
 * Safety properties:
 * - one active run per workspace conversation; `start` is a no-op while a
 *   run is active (double-submit protection)
 * - every in-flight operation carries a generation token; responses from a
 *   superseded run are discarded (stale poll/cancel can never overwrite a
 *   newer run's state)
 * - cancellation is sent at most once per run and only ever claims what the
 *   SERVER confirmed in its response
 * - polling is bounded by attempts and consecutive failures, never overlaps
 *   itself, and its timer is cleared on unmount
 * - no assistant output is invented: `finalOutput` comes only from a
 *   backend-reported completed run
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../api/client';
import {
  cancelAgentRun,
  createAgentRun,
  getAgentRun,
  isTerminalRunStatus,
  submitAgentConfirmation,
  type AgentRunView,
  type PendingConfirmationView,
  type ToolResultView,
} from '../../api/agents';

/** The UI phases a workspace run moves through. */
export type AgentRunPhase =
  | 'idle'
  | 'creating'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'limit-reached'
  | 'error';

export interface AgentRunUiState {
  readonly phase: AgentRunPhase;
  /** The prompt of the current/last run. Drives retry; kept verbatim. */
  readonly prompt: string | null;
  /** Run id once the backend has confirmed the run exists. */
  readonly runId: string | null;
  /** The backend-confirmed final answer. Only set on `completed`. */
  readonly finalOutput: string | null;
  /** Friendly, safe failure text for `failed`, `limit-reached`, and `error`. */
  readonly failureMessage: string | null;
  /** True while the run can still be cancelled through the API. */
  readonly cancellable: boolean;
  /** True while the last run stopped before completing (retry is offered). */
  readonly retryable: boolean;
  /** True when bounded polling gave up while the run was still active. */
  readonly pollingPaused: boolean;
  /** Friendly text when a cancellation request failed (run state preserved). */
  readonly cancelError: string | null;
  /** Recorded tool activity of the current/last run, in backend order. */
  readonly toolResults: readonly ToolResultView[];
  /** The run's pending human confirmation, when the backend reports one. */
  readonly pendingConfirmation: PendingConfirmationView | null;
  /** True while an approve/reject decision is being sent to the server. */
  readonly confirmationSubmitting: boolean;
  /** Friendly text when a confirmation decision failed (run state preserved). */
  readonly confirmationError: string | null;
}

interface ActiveRun {
  readonly generation: number;
  prompt: string;
  runId: string | null;
}

const POLL_INTERVAL_MS = 900;
const MAX_POLL_ATTEMPTS = 40;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
/**
 * A run paused on a confirmation cannot progress on its own, but its
 * confirmation EXPIRES server-side after its TTL - so the workspace keeps
 * following it on a slower cadence to report the authoritative state.
 */
const PAUSED_POLL_INTERVAL_MS = 5000;
const PAUSED_MAX_POLL_ATTEMPTS = 70;

function friendlyRunFailure(run: AgentRunView): string {
  if (run.status === 'limit_reached') {
    return run.limitReason !== null
      ? `This run reached a safety limit: ${run.limitReason}`
      : 'This run reached a safety limit before finishing.';
  }
  if (run.error !== null) {
    return `This run failed: ${run.error.message}`;
  }
  return 'This run failed.';
}

/**
 * Maps a backend run snapshot to the UI phases, preserving the backend's
 * meaning (never inventing completion or success).
 */
function phaseFor(run: AgentRunView): Exclude<AgentRunPhase, 'idle' | 'creating'> {
  switch (run.status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'limit_reached':
      return 'limit-reached';
    case 'awaiting_confirmation':
      return 'paused';
    case 'awaiting_tool':
      return 'running';
  }
}

const IDLE_STATE: AgentRunUiState = {
  phase: 'idle',
  prompt: null,
  runId: null,
  finalOutput: null,
  failureMessage: null,
  cancellable: false,
  retryable: false,
  pollingPaused: false,
  cancelError: null,
  toolResults: [],
  pendingConfirmation: null,
  confirmationSubmitting: false,
  confirmationError: null,
};

export interface UseAgentRunOptions {
  /** The agent the workspace talks to; `null` disables starting runs. */
  readonly agentId: string | null;
  /** The routed project id, passed through to the run request. */
  readonly projectId: string | null;
}

export interface UseAgentRunResult {
  readonly state: AgentRunUiState;
  /** Starts a new run with the user's prompt. No-op while a run is active. */
  start(prompt: string): void;
  /** Requests cancellation at most once per run. */
  cancel(): void;
  /** Re-submits the last prompt as a NEW run (never replays the old one). */
  retry(): void;
  /** One-shot status refresh; resumes bounded polling if still active. */
  refresh(): void;
  /**
   * Submits the human approve/reject decision for the run's pending
   * confirmation. The server is the sole authority: it validates expiry,
   * input binding, and permissions, executes (or skips) the tool, and the
   * workspace then shows the run state the server confirmed. No-op unless
   * the backend is currently reporting a decidable confirmation.
   */
  submitConfirmation(decision: 'approve' | 'reject'): void;
}

export function useAgentRun({ agentId, projectId }: UseAgentRunOptions): UseAgentRunResult {
  const [state, setState] = useState<AgentRunUiState>(IDLE_STATE);
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveRun | null>(null);
  const cancelRequestedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const applyRun = useCallback(
    (run: AgentRunView, prompt: string, generation: number) => {
      if (generationRef.current !== generation) return;
      const phase = phaseFor(run);
      const terminal = isTerminalRunStatus(run.status);
      activeRef.current = { generation, prompt, runId: run.runId };
      if (terminal) {
        clearTimer();
        cancelRequestedRef.current = false;
      }
      setState((previous) => ({
        phase,
        prompt,
        runId: run.runId,
        finalOutput: phase === 'completed' ? run.finalOutput : null,
        failureMessage:
          phase === 'failed' || phase === 'limit-reached' ? friendlyRunFailure(run) : null,
        cancellable: !terminal,
        retryable: phase === 'failed' || phase === 'limit-reached' || phase === 'cancelled',
        pollingPaused: false,
        toolResults: run.toolResults,
        pendingConfirmation: run.pendingConfirmation,
        // An in-flight decision flag is owned by submitConfirmation and
        // survives run-state updates (they do not imply a decision result).
        confirmationSubmitting: previous.confirmationSubmitting,
        // A confirmation note clears once the server confirms the decision
        // landed (the run left the pause or the confirmation resolved);
        // otherwise it stays visible on the still-pending request.
        cancelError: terminal ? null : previous.cancelError,
        confirmationError:
          phase !== 'paused' || run.pendingConfirmation === null
            ? null
            : previous.confirmationError,
      }));
    },
    [clearTimer],
  );

  /**
   * Bounded, self-serializing poll loop. Only one timer is ever pending.
   * Active runs are followed at the fast cadence; runs paused on a
   * confirmation are followed on the slow cadence so the UI keeps
   * reporting the SERVER's authoritative confirmation state (including
   * expiry) while the user decides.
   */
  const schedulePoll = useCallback(
    (generation: number, runId: string, attempt: number, failures: number, paused: boolean) => {
      clearTimer();
      if (generationRef.current !== generation) return;
      timerRef.current = setTimeout(
        async () => {
          if (generationRef.current !== generation) return;
          try {
            const run = await getAgentRun(runId);
            if (generationRef.current !== generation) return;
            if (run.runId !== runId) {
              // The response does not belong to the polled run. Discard it;
              // keep following the run we know about, bounded as usual.
              schedulePoll(generation, runId, attempt + 1, failures + 1, paused);
              return;
            }
            const prompt = activeRef.current?.prompt ?? '';
            applyRun(run, prompt, generation);
            if (isTerminalRunStatus(run.status)) {
              return; // applyRun cleared the timer for terminal runs.
            }
            if (run.status === 'awaiting_confirmation') {
              // An expired confirmation is the server's final word for the
              // pause: keep it on screen, stop following (nothing more can
              // happen on its own).
              if (run.pendingConfirmation?.state === 'expired') return;
              const limit = paused ? PAUSED_MAX_POLL_ATTEMPTS : MAX_POLL_ATTEMPTS;
              if (attempt + 1 >= limit) {
                setState((previous) => ({ ...previous, pollingPaused: true }));
                return;
              }
              schedulePoll(generation, run.runId, attempt + 1, 0, true);
              return;
            }
            if (attempt + 1 >= MAX_POLL_ATTEMPTS) {
              // Bounded: stop following, keep the run live and cancellable.
              setState((previous) => ({ ...previous, pollingPaused: true }));
              return;
            }
            schedulePoll(generation, run.runId, attempt + 1, 0, false);
          } catch {
            if (generationRef.current !== generation) return;
            if (failures + 1 >= MAX_CONSECUTIVE_POLL_FAILURES) {
              clearTimer();
              setState((previous) => ({
                ...previous,
                phase: 'error',
                cancellable: false,
                pollingPaused: false,
                failureMessage:
                  'Lost contact with this run. Its latest known state is shown; nothing further was claimed.',
              }));
              return;
            }
            schedulePoll(generation, runId, attempt + 1, failures + 1, paused);
          }
        },
        paused ? PAUSED_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
      );
    },
    [applyRun, clearTimer],
  );

  /**
   * Resumes following one authoritative run snapshot: fast polling for
   * active runs, slow polling for confirmations pauses, nothing for
   * terminal runs.
   */
  const followRun = useCallback(
    (run: AgentRunView, generation: number) => {
      if (isTerminalRunStatus(run.status)) return;
      schedulePoll(generation, run.runId, 0, 0, run.status === 'awaiting_confirmation');
    },
    [schedulePoll],
  );

  const launch = useCallback(
    (prompt: string) => {
      if (agentId === null) return;
      clearTimer();
      cancelRequestedRef.current = false;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      activeRef.current = { generation, prompt, runId: null };
      setState({
        ...IDLE_STATE,
        phase: 'creating',
        prompt,
      });
      void (async () => {
        try {
          const run = await createAgentRun({
            agentId,
            task: prompt,
            ...(projectId !== null ? { projectId } : {}),
          });
          if (generationRef.current !== generation) return;
          const prompt_ = activeRef.current?.prompt ?? prompt;
          applyRun(run, prompt_, generation);
          followRun(run, generation);
        } catch (error: unknown) {
          if (generationRef.current !== generation) return;
          clearTimer();
          setState({
            ...IDLE_STATE,
            phase: 'error',
            prompt,
            failureMessage: `${errorMessage(error)} Your message was not answered.`,
            retryable: true,
          });
        }
      })();
    },
    [agentId, applyRun, clearTimer, projectId, schedulePoll],
  );

  const start = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim();
      if (trimmed.length === 0) return;
      // One active run per workspace conversation: creating, running, and
      // paused runs reject a second submission outright.
      if (state.phase === 'creating' || state.phase === 'running' || state.phase === 'paused') {
        return;
      }
      launch(trimmed);
    },
    [launch, state.phase],
  );

  const cancel = useCallback(() => {
    const current = activeRef.current;
    if (current === null || current.runId === null) return;
    if (cancelRequestedRef.current) return;
    // Cancellation exists only for a live, cancellable run (the backend
    // rejects terminal runs with AGENT_RUN_TERMINAL). While `creating`, the
    // run id is not known yet, so there is nothing to cancel.
    if (state.phase !== 'running' && state.phase !== 'paused') return;
    cancelRequestedRef.current = true;
    const generation = current.generation;
    const runId = current.runId;
    void (async () => {
      try {
        const run = await cancelAgentRun(runId);
        if (generationRef.current !== generation) return;
        if (run.runId !== runId) {
          throw new Error('cancellation response did not match the run');
        }
        const prompt = activeRef.current?.prompt ?? '';
        applyRun(run, prompt, generation);
        followRun(run, generation);
      } catch {
        if (generationRef.current !== generation) return;
        // Cancellation failed. Preserve the actual run state; surface a
        // recoverable note and resync once from the server.
        cancelRequestedRef.current = false;
        setState((previous) => ({
          ...previous,
          cancelError: 'Cancellation did not go through. The run keeps its latest known state.',
        }));
        void (async () => {
          try {
            const run = await getAgentRun(runId);
            if (generationRef.current !== generation) return;
            const prompt = activeRef.current?.prompt ?? '';
            applyRun(run, prompt, generation);
            followRun(run, generation);
          } catch {
            // Resync also failed: the state stays as-is. Honest, no claims.
          }
        })();
      }
    })();
  }, [applyRun, schedulePoll, state.phase]);

  const retry = useCallback(() => {
    if (state.prompt === null || !state.retryable) return;
    launch(state.prompt);
  }, [launch, state.prompt, state.retryable]);

  const refresh = useCallback(() => {
    const current = activeRef.current;
    if (current === null || current.runId === null) return;
    const generation = current.generation;
    const runId = current.runId;
    if (state.phase !== 'running' && state.phase !== 'paused') return;
    clearTimer();
    void (async () => {
      try {
        const run = await getAgentRun(runId);
        if (generationRef.current !== generation) return;
        const prompt = activeRef.current?.prompt ?? '';
        applyRun(run, prompt, generation);
        followRun(run, generation);
      } catch {
        // One-shot refresh failed; state stays as-is. Honest, no claims.
      }
    })();
  }, [applyRun, clearTimer, schedulePoll, state.phase]);

  const submitConfirmation = useCallback(
    (decision: 'approve' | 'reject') => {
      const current = activeRef.current;
      if (current === null || current.runId === null) return;
      const { phase, pendingConfirmation, confirmationSubmitting } = state;
      // Only a live, server-reported, still-decidable confirmation can be
      // decided - and only one decision may be in flight at a time.
      if (phase !== 'paused' || pendingConfirmation === null) return;
      if (pendingConfirmation.state !== 'required') return;
      if (confirmationSubmitting) return;
      const generation = current.generation;
      const runId = current.runId;
      setState((previous) => ({
        ...previous,
        confirmationSubmitting: true,
        confirmationError: null,
      }));
      void (async () => {
        try {
          const run = await submitAgentConfirmation(runId, decision);
          if (generationRef.current !== generation) return;
          if (run.runId !== runId) {
            throw new Error('confirmation response did not match the run');
          }
          const prompt = activeRef.current?.prompt ?? '';
          setState((previous) => ({ ...previous, confirmationSubmitting: false }));
          applyRun(run, prompt, generation);
          followRun(run, generation);
        } catch {
          if (generationRef.current !== generation) return;
          setState((previous) => ({
            ...previous,
            confirmationSubmitting: false,
            confirmationError:
              'The decision did not go through. The request keeps its latest server-confirmed state.',
          }));
          // Resync once from the server: the authoritative state may have
          // changed (e.g. the confirmation expired) and must be shown.
          void (async () => {
            try {
              const run = await getAgentRun(runId);
              if (generationRef.current !== generation) return;
              const prompt = activeRef.current?.prompt ?? '';
              applyRun(run, prompt, generation);
              followRun(run, generation);
            } catch {
              // Resync also failed: the state stays as-is. Honest, no claims.
            }
          })();
        }
      })();
    },
    [applyRun, followRun, state],
  );

  return { state, start, cancel, retry, refresh, submitConfirmation };
}
