import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ErrorState, Select, Spinner } from '../../components/ui';
import {
  createRuntime,
  fetchRuntimeLogs,
  listRuntimes,
  restartRuntime,
  runtimeStatusLabel,
  startRuntime,
  stopRuntime,
  type RuntimeLogEntryView,
  type RuntimeStatus,
  type RuntimeView,
} from '../../api/runtimes';
import { errorMessage } from '../../api/client';
import type { WorkspaceView } from '../../api/workspaces';

/**
 * Project detail panel: preview runtimes (Step 17).
 *
 * The user picks a workspace and drives the preview lifecycle: create,
 * start, stop, restart. The plan is detected server-side from workspace
 * evidence; the browser never supplies commands, ports, limits, or
 * environment values. The simulated executor is always labeled honestly,
 * failure reports are structured (kind + phase + message), and runtime
 * logs are display-only untrusted data.
 */

const STATUS_TONE: Record<RuntimeStatus, 'success' | 'warning' | 'neutral' | 'error'> = {
  created: 'neutral',
  preparing: 'warning',
  building: 'warning',
  starting: 'warning',
  running: 'success',
  stopping: 'warning',
  stopped: 'neutral',
  failed: 'error',
  expired: 'neutral',
  cancelled: 'neutral',
};

const MAX_LOG_LINES = 120;

export interface PreviewPanelProps {
  readonly projectId: string;
  readonly workspaces: readonly WorkspaceView[];
  readonly onRuntimeChanged?: () => void;
}

export function PreviewPanel({ projectId, workspaces, onRuntimeChanged }: PreviewPanelProps) {
  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === 'active');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    activeWorkspaces[0]?.id ?? '',
  );
  const [runtimes, setRuntimes] = useState<readonly RuntimeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logs, setLogs] = useState<readonly RuntimeLogEntryView[] | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const reloadTimer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const views = await listRuntimes(projectId);
      setRuntimes(views);
    } catch (failure) {
      setLoadError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  // Keep the workspace selection honest when the workspace list changes.
  useEffect(() => {
    if (selectedWorkspaceId === '' && activeWorkspaces.length > 0) {
      setSelectedWorkspaceId(activeWorkspaces[0]?.id ?? '');
    }
    if (
      selectedWorkspaceId !== '' &&
      !activeWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(activeWorkspaces[0]?.id ?? '');
    }
  }, [activeWorkspaces, selectedWorkspaceId]);

  // Bounded slow-follow while a runtime is live: one refresh per 5s, max 60.
  useEffect(() => {
    const anyLive = runtimes.some(
      (runtime) =>
        runtime.status === 'running' ||
        runtime.status === 'preparing' ||
        runtime.status === 'building' ||
        runtime.status === 'starting',
    );
    if (!anyLive) {
      return undefined;
    }
    let ticks = 0;
    reloadTimer.current = window.setInterval(() => {
      ticks += 1;
      if (ticks > 60) {
        window.clearInterval(reloadTimer.current ?? 0);
        return;
      }
      void reload();
    }, 5000);
    return () => {
      if (reloadTimer.current !== null) {
        window.clearInterval(reloadTimer.current);
      }
    };
  }, [runtimes, reload]);

  const current = runtimes.find((runtime) => runtime.workspaceId === selectedWorkspaceId) ?? null;

  const run = async (intent: () => Promise<RuntimeView | { next: RuntimeView }>) => {
    setBusy(true);
    setActionError(null);
    try {
      await intent();
      setPreviewKey((key) => key + 1);
      await reload();
      onRuntimeChanged?.();
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const toggleLogs = async () => {
    if (logsOpen) {
      setLogsOpen(false);
      return;
    }
    if (current === null) {
      return;
    }
    try {
      const snapshot = await fetchRuntimeLogs(projectId, current.runtimeId);
      setLogs(snapshot.entries.slice(-MAX_LOG_LINES));
      setLogsOpen(true);
    } catch (failure) {
      setActionError(errorMessage(failure));
    }
  };

  if (activeWorkspaces.length === 0) {
    return (
      <section aria-label="Preview" className="v-page-section">
        <div className="v-page-section__header">
          <h3 className="v-heading-3">Preview</h3>
        </div>
        <p className="v-muted">Create an active workspace to preview this project.</p>
      </section>
    );
  }

  return (
    <section aria-label="Preview" className="v-page-section">
      <div className="v-page-section__header">
        <h3 className="v-heading-3">Preview</h3>
      </div>
      {loadError !== null ? (
        <ErrorState
          title="Could not load previews"
          description={loadError}
          retry={{
            label: 'Retry',
            onClick: () => {
              setLoading(true);
              void reload();
            },
          }}
        />
      ) : loading ? (
        <p className="v-muted">
          <Spinner aria-label="Loading previews" /> Loading previews…
        </p>
      ) : (
        <div className="v-preview">
          <div className="v-preview__controls">
            <Select
              label="Workspace"
              value={selectedWorkspaceId}
              options={activeWorkspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
              onChange={(event) => {
                setSelectedWorkspaceId(event.target.value);
                setLogs(null);
                setLogsOpen(false);
              }}
            />
            {current === null ? (
              <Button
                onClick={() =>
                  void run(() => createRuntime(projectId, { workspaceId: selectedWorkspaceId }))
                }
                disabled={busy}
              >
                Create preview
              </Button>
            ) : (
              <>
                <Badge tone={STATUS_TONE[current.status]}>
                  {runtimeStatusLabel(current.status)}
                </Badge>
                {current.stale ? (
                  <Badge tone="warning">Stale — restart to pick up the latest files</Badge>
                ) : null}
                {current.status === 'running' ? (
                  <Button
                    variant="secondary"
                    onClick={() => void run(() => stopRuntime(projectId, current.runtimeId))}
                    disabled={busy}
                  >
                    Stop
                  </Button>
                ) : current.status === 'created' ? (
                  <Button
                    onClick={() => void run(() => startRuntime(projectId, current.runtimeId))}
                    disabled={busy}
                  >
                    Start
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => void run(() => restartRuntime(projectId, current.runtimeId))}
                    disabled={busy}
                  >
                    Restart at latest files
                  </Button>
                )}
                <Button variant="secondary" onClick={() => void toggleLogs()} disabled={busy}>
                  {logsOpen ? 'Hide logs' : 'View logs'}
                </Button>
              </>
            )}
          </div>

          {current !== null && (
            <p className="v-preview__meta v-muted">
              {current.plan.runtimeType} preview · {current.plan.startLabel}
              {current.plan.buildLabel !== null ? ` · ${current.plan.buildLabel}` : ''} · simulated
              executor (no real process runs)
            </p>
          )}

          {actionError !== null && (
            <p className="v-form-error" role="alert">
              {actionError}
            </p>
          )}

          {current !== null && current.failure !== null && (
            <div className="v-preview__failure" role="alert">
              <p className="v-form-error">
                Preview failed at {current.failure.phase}: {current.failure.message}
              </p>
              <p className="v-muted">Failure kind: {current.failure.kind}</p>
            </div>
          )}

          {logsOpen && logs !== null && (
            <div className="v-preview__logs" role="log" aria-label="Preview runtime logs">
              {logs.length === 0 ? (
                <p className="v-muted">No log lines yet.</p>
              ) : (
                logs.map((entry, index) => (
                  <p
                    key={`${entry.timestamp}-${index}`}
                    className={`v-preview__log v-preview__log--${entry.level}`}
                  >
                    <span className="v-preview__log-phase">{entry.phase}</span> {entry.message}
                  </p>
                ))
              )}
            </div>
          )}

          {current !== null && current.status === 'running' && current.previewUrl !== null && (
            <div className="v-preview__frame">
              <iframe
                key={`${current.runtimeId}-${previewKey}`}
                title={`Preview of ${current.workspaceId}`}
                src={current.previewUrl}
                sandbox="allow-scripts"
              />
            </div>
          )}
        </div>
      )}
      <p className="v-preview__footnote v-muted">
        Previews are simulated in this release: the platform builds and serves nothing.
      </p>
    </section>
  );
}
