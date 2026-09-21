import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  Input,
  Select,
  Spinner,
  Tabs,
  useToast,
} from '../../components/ui';
import {
  captureRevision,
  createCheckpoint,
  decideRollback,
  deleteCheckpoint,
  fetchRevisionDiff,
  listCheckpoints,
  listRevisions,
  openRollback,
  type CheckpointView,
  type DiffView,
  type OpenedRollback,
  type RevisionView,
} from '../../api/versions';
import { errorMessage } from '../../api/client';
import type { WorkspaceView } from '../../api/workspaces';

/**
 * Project detail panel: version control (Step 18).
 *
 * The user reads an immutable revision timeline, brackets their own work
 * with captures and named checkpoints, inspects bounded diffs, and can
 * RESTORE an earlier revision. A restore is a request, never an immediate
 * action: the server validates the target, pauses for an explicit human
 * confirmation, restores the tree, and appends a NEW revision - history is
 * never rewritten or truncated in the UI.
 */

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Captured by you',
  generation_before: 'Before generation',
  generation_after: 'After generation',
  testing_before_repair: 'Before repairs',
  testing_after: 'After testing',
  coding_before: 'Before coding run',
  coding_after: 'After coding run',
  rollback: 'Restore',
};

const SOURCE_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  manual: 'success',
  generation_before: 'warning',
  generation_after: 'warning',
  testing_before_repair: 'warning',
  testing_after: 'warning',
  coding_before: 'warning',
  coding_after: 'warning',
  rollback: 'neutral',
};

const MAX_DIFF_LINES = 200;

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.replace(/_/g, ' ');
}

function formatTimestamp(value: string): string {
  if (value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export interface VersionPanelProps {
  readonly projectId: string;
  readonly workspaces: readonly WorkspaceView[];
  readonly onWorkspaceRevisionChanged?: () => void;
}

export function VersionPanel({
  projectId,
  workspaces,
  onWorkspaceRevisionChanged,
}: VersionPanelProps) {
  const { toast } = useToast();
  const activeWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.status === 'active'),
    [workspaces],
  );
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    activeWorkspaces[0]?.id ?? '',
  );
  const selectedWorkspace = activeWorkspaces.find((w) => w.id === selectedWorkspaceId) ?? null;

  const [revisions, setRevisions] = useState<readonly RevisionView[] | null>(null);
  const [checkpoints, setCheckpoints] = useState<readonly CheckpointView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [captureMessage, setCaptureMessage] = useState('');
  const [checkpointName, setCheckpointName] = useState('');

  const [diff, setDiff] = useState<DiffView | null>(null);
  const [diffBusy, setDiffBusy] = useState<string | null>(null);
  const [pendingRollback, setPendingRollback] = useState<OpenedRollback | null>(null);
  const [deciding, setDeciding] = useState(false);

  const reload = useCallback(async () => {
    if (selectedWorkspace === null) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    setActionError(null);
    try {
      const [revisionViews, checkpointViews] = await Promise.all([
        listRevisions(projectId, selectedWorkspace.id),
        listCheckpoints(projectId, selectedWorkspace.id),
      ]);
      setRevisions(revisionViews);
      setCheckpoints(checkpointViews);
    } catch (failure) {
      setLoadError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedWorkspace]);

  useEffect(() => {
    setLoading(true);
    setRevisions(null);
    setCheckpoints(null);
    void reload();
  }, [reload]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleCapture = (): void => {
    if (selectedWorkspace === null) return;
    void run(async () => {
      await captureRevision(projectId, selectedWorkspace.id, {
        ...(captureMessage.trim() !== '' ? { message: captureMessage.trim() } : {}),
      });
      setCaptureMessage('');
      toast('Revision captured', { tone: 'success' });
      await reload();
      onWorkspaceRevisionChanged?.();
    });
  };

  const handleCreateCheckpoint = (): void => {
    if (selectedWorkspace === null || checkpointName.trim() === '') return;
    void run(async () => {
      await createCheckpoint(projectId, selectedWorkspace.id, {
        name: checkpointName.trim(),
      });
      setCheckpointName('');
      toast('Checkpoint created', { tone: 'success' });
      await reload();
    });
  };

  const handleDeleteCheckpoint = (checkpoint: CheckpointView): void => {
    if (selectedWorkspace === null) return;
    void run(async () => {
      await deleteCheckpoint(projectId, selectedWorkspace.id, checkpoint.id);
      toast('Checkpoint removed', { tone: 'info' });
      await reload();
    });
  };

  const handleViewDiff = (revision: RevisionView): void => {
    if (selectedWorkspace === null) return;
    setDiffBusy(revision.id);
    setActionError(null);
    void (async () => {
      try {
        const view = await fetchRevisionDiff(projectId, selectedWorkspace.id, revision.id);
        setDiff(view);
      } catch (failure) {
        setActionError(errorMessage(failure));
      } finally {
        setDiffBusy(null);
      }
    })();
  };

  const handleRestoreRequest = (revision: RevisionView): void => {
    if (selectedWorkspace === null) return;
    setActionError(null);
    void (async () => {
      setBusy(true);
      try {
        const opened = await openRollback(projectId, {
          workspaceId: selectedWorkspace.id,
          targetRevisionId: revision.id,
          expectedCurrentRevision: selectedWorkspace.revision,
        });
        setPendingRollback(opened);
      } catch (failure) {
        setActionError(errorMessage(failure));
      } finally {
        setBusy(false);
      }
    })();
  };

  const handleDecide = (decision: 'approve' | 'reject'): void => {
    if (pendingRollback === null) return;
    setDeciding(true);
    void (async () => {
      try {
        const outcome = await decideRollback(projectId, pendingRollback.operation.id, decision);
        if (outcome.state === 'completed') {
          toast('Workspace restored — a new revision records the restore', { tone: 'success' });
        } else if (outcome.state === 'rejected') {
          toast('Restore cancelled — nothing changed', { tone: 'info' });
        } else if (outcome.state === 'failed') {
          setActionError(outcome.failureMessage ?? 'The restore failed.');
        }
        setPendingRollback(null);
        await reload();
        onWorkspaceRevisionChanged?.();
      } catch (failure) {
        setActionError(errorMessage(failure));
        setPendingRollback(null);
      } finally {
        setDeciding(false);
      }
    })();
  };

  if (activeWorkspaces.length === 0) {
    return (
      <section aria-label="Version history" className="v-page-section">
        <div className="v-page-section__header">
          <h3 className="v-heading-3">Version history</h3>
        </div>
        <p className="v-muted">Create an active workspace to capture and restore versions.</p>
      </section>
    );
  }

  const latestRevisionId = revisions?.[0]?.id ?? null;

  return (
    <section aria-label="Version history" className="v-page-section">
      <div className="v-page-section__header">
        <h3 className="v-heading-3">Version history</h3>
      </div>
      {actionError !== null ? (
        <p className="v-preview__failure" role="alert">
          {actionError}
        </p>
      ) : null}

      {loadError !== null ? (
        <ErrorState
          title="Could not load version history"
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
          <Spinner aria-label="Loading version history" /> Loading version history…
        </p>
      ) : (
        <>
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
                setDiff(null);
                setPendingRollback(null);
              }}
            />
          </div>
          <Tabs
            aria-label="Version views"
            tabs={[
              {
                id: 'timeline',
                label: `Timeline${revisions !== null ? ` (${revisions.length})` : ''}`,
                content: (
                  <div className="v-version-timeline">
                    <div className="v-version-capture">
                      <Input
                        label="Capture note (optional)"
                        value={captureMessage}
                        placeholder="e.g. before refactor"
                        onChange={(event) => setCaptureMessage(event.target.value)}
                      />
                      <Button onClick={handleCapture} disabled={busy}>
                        Capture revision
                      </Button>
                    </div>

                    {revisions !== null && revisions.length === 0 ? (
                      <p className="v-muted">
                        No revisions yet. Capture the current files, or run a coding or generation
                        task — every run is bracketed by automatic captures.
                      </p>
                    ) : (
                      <ul className="v-version-list">
                        {(revisions ?? []).map((revision) => (
                          <li key={revision.id} className="v-version-row">
                            <span className="v-version-row__number">
                              #{revision.revisionNumber}
                            </span>
                            <Badge tone={SOURCE_TONE[revision.source] ?? 'neutral'}>
                              {sourceLabel(revision.source)}
                            </Badge>
                            <span className="v-version-row__meta">
                              {revision.change.added} added · {revision.change.modified} changed ·{' '}
                              {revision.change.deleted} removed · {revision.fileCount} files
                            </span>
                            {revision.message !== null ? (
                              <span className="v-version-row__message">{revision.message}</span>
                            ) : null}
                            <span className="v-version-row__created">
                              {formatTimestamp(revision.createdAt)}
                            </span>
                            <span className="v-version-row__actions">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => handleViewDiff(revision)}
                                disabled={diffBusy === revision.id}
                              >
                                {diffBusy === revision.id ? 'Loading…' : 'Diff'}
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => handleRestoreRequest(revision)}
                                disabled={busy || revision.id === latestRevisionId}
                                title={
                                  revision.id === latestRevisionId
                                    ? 'This is the latest revision.'
                                    : undefined
                                }
                              >
                                Restore…
                              </Button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ),
              },
              {
                id: 'checkpoints',
                label: `Checkpoints${checkpoints !== null ? ` (${checkpoints.length})` : ''}`,
                content: (
                  <div className="v-version-timeline">
                    <div className="v-version-capture">
                      <Input
                        label="Checkpoint name"
                        value={checkpointName}
                        placeholder="e.g. Stable release"
                        onChange={(event) => setCheckpointName(event.target.value)}
                      />
                      <Button
                        onClick={handleCreateCheckpoint}
                        disabled={busy || checkpointName.trim() === ''}
                      >
                        Pin checkpoint
                      </Button>
                    </div>
                    {checkpoints !== null && checkpoints.length === 0 ? (
                      <p className="v-muted">
                        No checkpoints yet. Pin the current files under a name you will recognize
                        later.
                      </p>
                    ) : (
                      <ul className="v-version-list">
                        {(checkpoints ?? []).map((checkpoint) => (
                          <li key={checkpoint.id} className="v-version-row">
                            <span className="v-version-row__name">{checkpoint.name}</span>
                            <Badge tone="neutral">Revision #{checkpoint.revisionNumber}</Badge>
                            <span className="v-version-row__created">
                              {formatTimestamp(checkpoint.createdAt)}
                            </span>
                            <span className="v-version-row__actions">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => handleDeleteCheckpoint(checkpoint)}
                                disabled={busy}
                              >
                                Remove
                              </Button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </>
      )}

      {diff !== null ? (
        <Dialog
          open
          title={`Diff to revision #${revisions?.find((r) => r.id === diff.toRevisionId)?.revisionNumber ?? ''}`}
          onClose={() => setDiff(null)}
        >
          <p className="v-muted">
            {diff.added} added · {diff.modified} changed · {diff.deleted} removed · {diff.renamed}{' '}
            renamed · {diff.unchanged} unchanged
          </p>
          <div className="v-version-diff" role="document" aria-label="Revision diff">
            {diff.files.map((file) => (
              <div key={file.path} className="v-version-diff__file">
                <p className="v-version-diff__path">
                  {file.path} <Badge tone="neutral">{file.kind}</Badge>
                </p>
                {file.lines.length > 0 ? (
                  <pre className="v-version-diff__lines">
                    {file.lines.slice(0, MAX_DIFF_LINES).map((line, index) => (
                      <span key={index} data-kind={line.kind}>
                        {line.text}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p className="v-muted">No inline lines (binary or unchanged content).</p>
                )}
              </div>
            ))}
          </div>
        </Dialog>
      ) : null}

      {pendingRollback !== null ? (
        <Dialog
          open
          title="Restore this revision?"
          onClose={() => {
            if (!deciding) setPendingRollback(null);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  if (!deciding) setPendingRollback(null);
                }}
                disabled={deciding}
              >
                Keep current files
              </Button>
              <Button variant="primary" onClick={() => handleDecide('approve')} disabled={deciding}>
                {deciding ? 'Restoring…' : 'Restore now'}
              </Button>
            </>
          }
        >
          <p>
            The workspace will be restored to revision #
            {pendingRollback.validation.targetRevisionNumber} (
            {pendingRollback.validation.filesChanged} file
            {pendingRollback.validation.filesChanged === 1 ? '' : 's'} will change). The current
            files are kept in history: the restore itself is recorded as a NEW revision, so nothing
            is lost.
          </p>
          <p className="v-muted">
            Closing this dialog without confirming leaves the workspace untouched.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}
