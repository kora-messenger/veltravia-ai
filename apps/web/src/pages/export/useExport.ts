import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../api/client';
import * as exportsApi from '../../api/exports';
import * as sourceApi from '../../api/source';

/**
 * State for the export page.
 *
 * Every operation ends in a visible state: `busy` while it runs, then either a
 * result or `error`. Nothing is swallowed, and a second click while one export
 * is running does nothing instead of starting a duplicate.
 */

export type DownloadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly verified: boolean }
  | { readonly kind: 'failed'; readonly message: string };

export interface ExportState {
  readonly loading: boolean;
  readonly loadError: string;
  readonly tree: sourceApi.SourceTreeView | null;
  readonly history: readonly exportsApi.ExportView[];
  readonly current: exportsApi.ExportView | null;
  readonly busy: boolean;
  readonly error: string;
  readonly download: DownloadState;
  readonly validation: exportsApi.ExportValidation | null;
  readonly validating: boolean;
  readonly start: (request: {
    readonly scope: exportsApi.ExportScope;
    readonly paths?: readonly string[];
  }) => Promise<void>;
  readonly downloadCurrent: () => Promise<void>;
  readonly validateCurrent: () => Promise<void>;
  readonly discardCurrent: () => Promise<void>;
  readonly open: (view: exportsApi.ExportView) => void;
  readonly reload: () => void;
}

export interface UseExportDeps {
  readonly save?: (archive: exportsApi.DownloadedArchive) => void;
}

export function useExport(projectId: string | null, deps: UseExportDeps = {}): ExportState {
  const save = deps.save ?? exportsApi.saveArchive;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tree, setTree] = useState<sourceApi.SourceTreeView | null>(null);
  const [history, setHistory] = useState<readonly exportsApi.ExportView[]>([]);
  const [current, setCurrent] = useState<exportsApi.ExportView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' });
  const [validation, setValidation] = useState<exportsApi.ExportValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [nonce, setNonce] = useState(0);
  const running = useRef(false);

  useEffect(() => {
    if (projectId === null) {
      setLoadError('No project was selected.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    void (async () => {
      try {
        const [nextTree, nextHistory] = await Promise.all([
          sourceApi.fetchTree(projectId),
          exportsApi.listExports(projectId),
        ]);
        if (cancelled) return;
        setTree(nextTree);
        setHistory(nextHistory);
      } catch (failure) {
        if (!cancelled) setLoadError(errorMessage(failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  const refreshHistory = useCallback(async () => {
    if (projectId === null) return;
    try {
      setHistory(await exportsApi.listExports(projectId));
    } catch {
      /* the list is a convenience; the export itself already succeeded or failed visibly */
    }
  }, [projectId]);

  const reset = () => {
    setError('');
    setDownload({ kind: 'idle' });
    setValidation(null);
  };

  const start: ExportState['start'] = useCallback(
    async (request) => {
      if (projectId === null || running.current) return;
      running.current = true;
      setBusy(true);
      reset();
      setCurrent(null);
      try {
        const view = await exportsApi.createExport(projectId, request);
        setCurrent(view);
        await refreshHistory();
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [projectId, refreshHistory],
  );

  const downloadCurrent = useCallback(async () => {
    if (current === null || current.status !== 'ready') return;
    setDownload({ kind: 'working' });
    try {
      const archive = await exportsApi.downloadExport(current);
      save(archive);
      setDownload({ kind: 'done', verified: archive.verified });
    } catch (failure) {
      setDownload({ kind: 'failed', message: errorMessage(failure) });
    }
  }, [current, save]);

  const validateCurrent = useCallback(async () => {
    if (current === null || current.status !== 'ready') return;
    setValidating(true);
    setValidation(null);
    try {
      setValidation(await exportsApi.validateExport(current.exportId));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setValidating(false);
    }
  }, [current]);

  const discardCurrent = useCallback(async () => {
    if (current === null) return;
    try {
      await exportsApi.discardExport(current.exportId);
      setCurrent(null);
      reset();
      await refreshHistory();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [current, refreshHistory]);

  const open = useCallback((view: exportsApi.ExportView) => {
    setCurrent(view);
    reset();
  }, []);

  return {
    loading,
    loadError,
    tree,
    history,
    current,
    busy,
    error,
    download,
    validation,
    validating,
    start,
    downloadCurrent,
    validateCurrent,
    discardCurrent,
    open,
    reload: () => setNonce((n) => n + 1),
  };
}
