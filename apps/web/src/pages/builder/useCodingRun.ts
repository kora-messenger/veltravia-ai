import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../api/client';
import * as coding from '../../api/coding';

/**
 * One active coding run per builder workspace (Step 32).
 *
 * Rules that matter:
 * - a run is followed by polling until it is terminal; polling stops on unmount
 *   and never stacks, so the UI cannot hammer the API;
 * - a decision (approve/reject) is sent once and the server's answer is
 *   authoritative - the page never assumes the plan was accepted;
 * - cancellation is a one-way request: the button disables immediately and the
 *   terminal state comes from the server, not from optimism;
 * - a run belongs to a project, so switching project abandons the old run
 *   instead of showing one project's activity under another.
 */

const POLL_INTERVAL_MS = 900;

export interface CodingRunController {
  readonly run: coding.CodingRunView | null;
  readonly busy: boolean;
  readonly error: string;
  readonly decisionsPending: boolean;
  start: (input: {
    projectId: string;
    workspaceId: string;
    userRequirement: string;
  }) => Promise<boolean>;
  decide: (decision: 'approve' | 'reject') => Promise<void>;
  cancel: () => Promise<void>;
}

export function useCodingRun(): CodingRunController {
  const [run, setRun] = useState<coding.CodingRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decisionsPending, setDecisionsPending] = useState(false);

  const mounted = useRef(true);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const follow = useCallback(
    (runId: string, forGeneration: number) => {
      stopPolling();
      const tick = async () => {
        if (!mounted.current || generation.current !== forGeneration) return;
        try {
          const next = await coding.fetchCodingRun(runId);
          if (!mounted.current || generation.current !== forGeneration) return;
          setRun(next);
          if (coding.isCodingRunTerminal(next.state)) {
            setBusy(false);
            return;
          }
        } catch (pollError) {
          if (!mounted.current || generation.current !== forGeneration) return;
          setError(errorMessage(pollError));
          setBusy(false);
          return;
        }
        if (!mounted.current || generation.current !== forGeneration) return;
        timer.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      };
      void tick();
    },
    [stopPolling],
  );

  const start = useCallback(
    async (input: { projectId: string; workspaceId: string; userRequirement: string }) => {
      generation.current += 1;
      const forGeneration = generation.current;
      stopPolling();
      setBusy(true);
      setError('');
      try {
        const started = await coding.startCodingRun(input);
        if (!mounted.current || generation.current !== forGeneration) return false;
        setRun(started);
        if (coding.isCodingRunTerminal(started.state)) setBusy(false);
        else follow(started.runId, forGeneration);
        return true;
      } catch (startError) {
        if (!mounted.current || generation.current !== forGeneration) return false;
        setError(errorMessage(startError));
        setBusy(false);
        return false;
      }
    },
    [follow, stopPolling],
  );

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (run === null || decisionsPending) return;
      setDecisionsPending(true);
      setError('');
      const forGeneration = generation.current;
      try {
        const next = await coding.submitCodingDecision(run.runId, decision);
        if (!mounted.current || generation.current !== forGeneration) return;
        setRun(next);
        if (coding.isCodingRunTerminal(next.state)) setBusy(false);
        else {
          setBusy(true);
          follow(next.runId, forGeneration);
        }
      } catch (decisionError) {
        if (!mounted.current || generation.current !== forGeneration) return;
        setError(errorMessage(decisionError));
        // Re-sync: the server's state is the truth, not the rejected request.
        try {
          const current = await coding.fetchCodingRun(run.runId);
          if (mounted.current && generation.current === forGeneration) setRun(current);
        } catch {
          // Leaving the last known state visible is honest enough here.
        }
      } finally {
        if (mounted.current) setDecisionsPending(false);
      }
    },
    [decisionsPending, follow, run],
  );

  const cancel = useCallback(async () => {
    if (run === null) return;
    const forGeneration = generation.current;
    setBusy(true);
    setError('');
    try {
      const next = await coding.cancelCodingRun(run.runId);
      if (!mounted.current || generation.current !== forGeneration) return;
      setRun(next);
      stopPolling();
      setBusy(false);
    } catch (cancelError) {
      if (!mounted.current || generation.current !== forGeneration) return;
      setError(errorMessage(cancelError));
      setBusy(false);
    }
  }, [run, stopPolling]);

  return { run, busy, error, decisionsPending, start, decide, cancel };
}
