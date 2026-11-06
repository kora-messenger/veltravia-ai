import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../api/client';
import * as syncApi from '../../api/sync';

/**
 * State for the GitHub sync page.
 *
 * Every operation ends in a visible state: `busy` while it runs, then either a
 * result or `error`. Two rules matter more than the rest:
 *
 * - the page never assumes the outcome of a write. After approving, resolving,
 *   applying or cancelling it takes the plan the server returned, so what is
 *   shown is what the server holds.
 * - a second click while an operation runs does nothing, so a slow apply cannot
 *   publish twice.
 */

export interface SyncState {
  readonly loading: boolean;
  readonly offline: boolean;
  readonly loadError: string;
  readonly status: syncApi.SyncStatusView | null;
  readonly plan: syncApi.SyncPlan | null;
  readonly history: syncApi.SyncHistoryView | null;
  readonly repositories: readonly syncApi.SyncRepositoryView[];
  readonly busy: boolean;
  readonly planning: boolean;
  readonly error: string;
  readonly notice: string;
  readonly connect: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
  }) => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly compare: () => Promise<void>;
  readonly approve: () => Promise<void>;
  readonly resolve: (
    conflictId: string,
    resolution: syncApi.ConflictResolution,
    manualContent?: string,
  ) => Promise<void>;
  readonly apply: () => Promise<void>;
  readonly cancelPlan: () => Promise<void>;
  readonly reload: () => Promise<void>;
}

export interface UseSyncDeps {
  readonly api?: typeof syncApi;
  readonly isOffline?: () => boolean;
}

export function useSync(projectId: string | null, deps: UseSyncDeps = {}): SyncState {
  const api = deps.api ?? syncApi;
  const offlineCheck = deps.isOffline ?? syncApi.isOffline;

  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<syncApi.SyncStatusView | null>(null);
  const [plan, setPlan] = useState<syncApi.SyncPlan | null>(null);
  const [history, setHistory] = useState<syncApi.SyncHistoryView | null>(null);
  const [repositories, setRepositories] = useState<readonly syncApi.SyncRepositoryView[]>([]);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const running = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (projectId === null) {
      setLoading(false);
      setLoadError('There is no project to synchronise.');
      return;
    }
    if (offlineCheck()) {
      setLoading(false);
      setOffline(true);
      return;
    }
    try {
      const [next, entries] = await Promise.all([
        api.fetchSyncStatus(projectId),
        api.fetchHistory(projectId),
      ]);
      if (!alive.current) return;
      setStatus(next);
      setHistory(entries);
      // The newest open plan is what the page works on; a plan is never rebuilt
      // from memory, only taken from the server.
      setPlan(next.plans.length > 0 ? (next.plans[next.plans.length - 1] ?? null) : null);
      setLoadError('');
    } catch (caught) {
      if (!alive.current) return;
      setLoadError(errorMessage(caught));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [api, offlineCheck, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const guard = useCallback(async (work: () => Promise<void>): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (caught) {
      if (alive.current) setError(errorMessage(caught));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  const refreshHistory = useCallback(async (): Promise<void> => {
    if (projectId === null) return;
    try {
      const entries = await api.fetchHistory(projectId);
      if (alive.current) setHistory(entries);
    } catch {
      // History is a record, not the work: a failed read leaves the old one.
    }
  }, [api, projectId]);

  const connect = useCallback(
    async (input: { owner: string; repository: string; branch: string }): Promise<void> => {
      if (projectId === null) return;
      await guard(async () => {
        await api.connectRepository(projectId, input);
        await load();
        if (alive.current)
          setNotice(`Connected to ${input.owner}/${input.repository} on ${input.branch}.`);
      });
    },
    [api, guard, load, projectId],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    if (projectId === null) return;
    await guard(async () => {
      await api.disconnectRepository(projectId);
      if (alive.current) {
        setPlan(null);
        setNotice('Disconnected. Nothing on GitHub was changed.');
      }
      await load();
    });
  }, [api, guard, load, projectId]);

  const compare = useCallback(async (): Promise<void> => {
    if (projectId === null) return;
    setPlanning(true);
    try {
      await guard(async () => {
        const next = await api.createPlan(projectId);
        if (alive.current) setPlan(next);
      });
    } finally {
      if (alive.current) setPlanning(false);
    }
  }, [api, guard, projectId]);

  const approve = useCallback(async (): Promise<void> => {
    if (plan === null) return;
    await guard(async () => {
      const next = await api.approvePlan(plan.planId);
      if (alive.current) {
        setPlan(next);
        setNotice('Approved. The sync can be applied now.');
      }
    });
  }, [api, guard, plan]);

  const resolve = useCallback(
    async (
      conflictId: string,
      resolution: syncApi.ConflictResolution,
      manualContent?: string,
    ): Promise<void> => {
      if (plan === null) return;
      await guard(async () => {
        const next = await api.resolveConflict(
          plan.planId,
          conflictId,
          manualContent === undefined ? { resolution } : { resolution, manualContent },
        );
        if (alive.current) setPlan(next);
      });
    },
    [api, guard, plan],
  );

  const apply = useCallback(async (): Promise<void> => {
    if (plan === null) return;
    await guard(async () => {
      const result = await api.applyPlan(plan.planId);
      if (!alive.current) return;
      setPlan(null);
      setNotice(
        result.commitSha === null
          ? 'Sync finished. Nothing needed publishing.'
          : `Sync finished. Published ${result.commitSha.slice(0, 7)}.`,
      );
      await load();
      await refreshHistory();
    });
  }, [api, guard, load, plan, refreshHistory]);

  const cancelPlan = useCallback(async (): Promise<void> => {
    if (plan === null) return;
    await guard(async () => {
      await api.cancelPlan(plan.planId);
      if (alive.current) {
        setPlan(null);
        setNotice('Comparison discarded. Nothing on either side was changed.');
      }
    });
  }, [api, guard, plan]);

  const reloadRepositories = useCallback(async (): Promise<void> => {
    try {
      const list = await api.fetchRepositories();
      if (alive.current) setRepositories(list);
    } catch {
      // The form still works by typing an owner and repository by hand.
    }
  }, [api]);

  useEffect(() => {
    if (status !== null && !status.connected) void reloadRepositories();
  }, [reloadRepositories, status]);

  return {
    loading,
    offline,
    loadError,
    status,
    plan,
    history,
    repositories,
    busy,
    planning,
    error,
    notice,
    connect,
    disconnect,
    compare,
    approve,
    resolve,
    apply,
    cancelPlan,
    reload: load,
  };
}
