import { useCallback, useEffect, useRef, useState } from 'react';

import * as testingApi from '../../api/app-testing';
import { errorMessage } from '../../api/client';
import { isActive, isFinished } from './view-model';

/**
 * One application-testing run, followed from the browser.
 *
 * The server owns the run; this hook only starts it, watches it and relays a
 * person's decisions. Rules it keeps:
 *
 *  - While the run is working it is checked on a timer. While it waits for a
 *    person, or after it has finished, it is not: nothing will change by itself.
 *  - A reply that arrives after the run was replaced or the page left is
 *    discarded, so a slow answer can never overwrite a newer one.
 *  - Every decision goes to the existing approval route and is the person's.
 *    Nothing here approves anything.
 */

export interface TestingRunState {
  readonly started: testingApi.StartedRun | null;
  readonly status: testingApi.RunStatus | null;
  readonly report: testingApi.AppTestReport | null;
  readonly repairPlan: testingApi.RepairPlanView | null;
  readonly busy: boolean;
  readonly error: string;
}

const EMPTY: TestingRunState = {
  started: null,
  status: null,
  report: null,
  repairPlan: null,
  busy: false,
  error: '',
};

export interface UseTestingRunOptions {
  /** How often a working run is checked. */
  readonly pollMs?: number;
  readonly api?: typeof testingApi;
}

export function useTestingRun(options: UseTestingRunOptions = {}) {
  const pollMs = options.pollMs ?? 1500;
  const api = options.api ?? testingApi;
  const [state, setState] = useState<TestingRunState>(EMPTY);
  // Advances after every check, successful or not, so a failed check re-arms the
  // timer instead of leaving a working run frozen on screen.
  const [checks, setChecks] = useState(0);
  // Identifies the run the page is following. A reply for any other id is stale.
  const currentRun = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      currentRun.current = null;
    };
  }, []);

  /** Applies a patch only if the page is still following that run. */
  const patch = useCallback((runId: string | null, next: Partial<TestingRunState>) => {
    if (!mounted.current) return;
    if (runId !== null && currentRun.current !== runId) return;
    setState((previous) => ({ ...previous, ...next }));
  }, []);

  /** Reads status, and the report and repair plan when they have something to say. */
  const refresh = useCallback(
    async (runId: string, options: { keepError?: boolean } = {}) => {
      try {
        const status = await api.fetchStatus(runId);
        const finished = isFinished(status.state);
        const repairing = status.state === 'awaiting_repair_approval';
        const [report, repairPlan] = await Promise.all([
          api.fetchReport(runId).catch(() => null),
          repairing || finished ? api.fetchRepairPlan(runId).catch(() => null) : null,
        ]);
        patch(runId, {
          status,
          report,
          repairPlan,
          // A refresh must not wipe the reason a decision just failed.
          ...(options.keepError === true ? {} : { error: '' }),
        });
      } catch (failure) {
        patch(runId, { error: errorMessage(failure) });
      } finally {
        if (mounted.current && currentRun.current === runId) setChecks((value) => value + 1);
      }
    },
    [api, patch],
  );

  const start = useCallback(
    async (input: { projectId: string; workspaceId: string }) => {
      currentRun.current = null;
      setState({ ...EMPTY, busy: true });
      try {
        const started = await api.startRun(input);
        if (!mounted.current) return;
        currentRun.current = started.runId;
        setState({ ...EMPTY, started, busy: false });
        await refresh(started.runId);
      } catch (failure) {
        if (mounted.current) setState({ ...EMPTY, error: errorMessage(failure) });
      }
    },
    [api, refresh],
  );

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      const runId = currentRun.current;
      if (runId === null) return;
      patch(runId, { busy: true, error: '' });
      try {
        await api.decide(runId, decision);
        patch(runId, { busy: false });
        await refresh(runId);
      } catch (failure) {
        patch(runId, { busy: false, error: errorMessage(failure) });
        // Show the real state, but keep the reason the decision failed.
        await refresh(runId, { keepError: true });
      }
    },
    [api, patch, refresh],
  );

  const cancel = useCallback(async () => {
    const runId = currentRun.current;
    if (runId === null) return;
    patch(runId, { busy: true, error: '' });
    try {
      await api.cancelRun(runId);
      patch(runId, { busy: false });
      await refresh(runId);
    } catch (failure) {
      patch(runId, { busy: false, error: errorMessage(failure) });
    }
  }, [api, patch, refresh]);

  // Keep a working run fresh. Waiting for a person, or finished, needs no timer.
  const runState = state.status?.state ?? null;
  useEffect(() => {
    const runId = currentRun.current;
    if (runId === null || runState === null || !isActive(runState)) return;
    const timer = setTimeout(() => {
      void refresh(runId);
    }, pollMs);
    return () => clearTimeout(timer);
  }, [runState, checks, pollMs, refresh]);

  const reset = useCallback(() => {
    currentRun.current = null;
    setState(EMPTY);
  }, []);

  return { ...state, start, decide, cancel, reset, runId: currentRun.current };
}
