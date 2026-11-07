import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, EmptyState, Spinner } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  analyzeChangeSets,
  changeSetDiff,
  getChangeSet,
  recordApproval,
  runIntegration,
  type ChangeSetAnalysis,
  type ChangeSetDetail,
  type ChangeSetDiff,
  type ChangeSetView,
  type IntegrationRecordView,
} from '../../api/operations';
import {
  CHANGE_OP_LABEL,
  changeSetStatusLabel,
  changeSetStatusTone,
  countByOp,
  relativeTime,
} from './status';

export interface ChangeSetReviewProps {
  readonly changeSet: ChangeSetView;
  readonly records: readonly IntegrationRecordView[];
  /** Called after an approval or an integration, so the dashboard refreshes. */
  readonly onChanged: (message: string) => void;
  readonly onNotifyFailed: (message: string) => void;
}

/**
 * One worker's proposal, as a reviewer reads it.
 *
 * The page never decides whether a set is integrable: it asks the server to
 * validate and to analyse conflicts, and it renders the answers. Approving
 * records an approval; integrating needs that approval's id, so a browser
 * cannot skip the gate. A conflicted set is shown as blocked with the server's
 * explanation, and the integrate control is not offered at all.
 */
export function ChangeSetReview({
  changeSet,
  records,
  onChanged,
  onNotifyFailed,
}: ChangeSetReviewProps) {
  const [detail, setDetail] = useState<ChangeSetDetail | null>(null);
  const [diff, setDiff] = useState<ChangeSetDiff | null>(null);
  const [analysis, setAnalysis] = useState<ChangeSetAnalysis | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [full, sides] = await Promise.all([
        getChangeSet(changeSet.id),
        changeSetDiff(changeSet.id),
      ]);
      setDetail(full);
      setDiff(sides);
      setError(null);
      setState('ready');
    } catch (cause) {
      setError(cause);
      setState('error');
    }
  }, [changeSet.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const openConflicts = useCallback(async () => {
    setBusy('conflicts');
    setActionError(null);
    try {
      const result = await analyzeChangeSets(changeSet.projectId, [changeSet.id]);
      setAnalysis(result);
      if (result.conflicts.length > 0) onNotifyFailed('Conflicts detected in this change set');
    } catch (cause) {
      setActionError(
        cause instanceof ApiError ? cause.message : 'Conflicts could not be analysed right now.',
      );
    } finally {
      setBusy(null);
    }
  }, [changeSet.id, changeSet.projectId, onNotifyFailed]);

  const approve = useCallback(
    async (decision: 'approve' | 'reject') => {
      setBusy(decision);
      setActionError(null);
      try {
        const approval = await recordApproval({
          projectId: changeSet.projectId,
          changeSetIds: [changeSet.id],
          decision,
          rationale:
            decision === 'approve'
              ? 'Reviewed the files and the validation result.'
              : 'Declined to integrate this change set.',
        });
        setApprovalId(decision === 'approve' ? approval.id : null);
        onChanged(
          decision === 'approve'
            ? 'Approval recorded for this change set.'
            : 'Change set rejected.',
        );
        await load();
      } catch (cause) {
        setActionError(
          cause instanceof ApiError ? cause.message : 'The approval could not be recorded.',
        );
      } finally {
        setBusy(null);
      }
    },
    [changeSet.id, changeSet.projectId, load, onChanged],
  );

  const integrate = useCallback(async () => {
    if (approvalId === null) return;
    setBusy('integrate');
    setActionError(null);
    try {
      await runIntegration({
        projectId: changeSet.projectId,
        changeSetIds: [changeSet.id],
        approvalId,
      });
      onChanged('Changes integrated.');
      await load();
    } catch (cause) {
      setActionError(
        cause instanceof ApiError ? cause.message : 'The changes could not be integrated.',
      );
      onNotifyFailed('Integration failed');
    } finally {
      setBusy(null);
    }
  }, [approvalId, changeSet.id, changeSet.projectId, load, onChanged, onNotifyFailed]);

  const counts = countByOp(changeSet.files);
  const integrationRecord =
    changeSet.integrationId === null
      ? null
      : (records.find((record) => record.id === changeSet.integrationId) ?? null);
  const conflicts = analysis?.conflicts ?? [];
  const blocked = analysis?.blocked === true || conflicts.length > 0;
  const validation = detail?.validation ?? null;
  const eligible =
    changeSet.status === 'open' && (validation === null || validation.ok) && !blocked;

  return (
    <section className="v-ops__review-pane" aria-label="Change set review">
      <header className="v-ops__panel-head">
        <div>
          <p className="v-ops__eyebrow">Change set</p>
          <h4 className="v-ops__panel-title">{changeSet.title}</h4>
          <p className="v-ops__muted">
            Base revision {changeSet.baseRevision} · {changeSet.files.length}{' '}
            {changeSet.files.length === 1 ? 'file' : 'files'} ·{' '}
            {changeSet.workerId === null ? 'no worker' : `worker ${changeSet.workerId}`}
          </p>
        </div>
        <Badge tone={changeSetStatusTone(changeSet.status)}>
          {changeSetStatusLabel(changeSet.status)}
        </Badge>
      </header>

      <div className="v-ops__chips">
        <span className="v-ops__chip">Added {counts.create}</span>
        <span className="v-ops__chip">Modified {counts.update}</span>
        <span className="v-ops__chip">Deleted {counts.delete}</span>
      </div>

      {state === 'loading' && diff === null && (
        <p className="v-ops__panel-loading" aria-busy="true">
          <Spinner size="sm" /> Loading the proposed changes…
        </p>
      )}

      {state === 'error' && (
        <EmptyState
          title="The change set could not be loaded"
          description={
            error instanceof ApiError ? error.message : 'The proposal is unavailable right now.'
          }
          action={{ label: 'Try again', onClick: () => void load() }}
        />
      )}

      {validation !== null && (
        <section className="v-ops__subsection" aria-label="Validation">
          <h5>Validation</h5>
          {validation.ok ? (
            <p className="v-ops__ok">
              Every file is inside scope and still applies to this project.
            </p>
          ) : (
            <ul className="v-ops__list">
              {validation.problems.map((problem) => (
                <li key={`${problem.code}-${problem.path ?? 'none'}`} className="v-ops__error">
                  {problem.path === null ? '' : `${problem.path}: `}
                  {problem.message} <span className="v-ops__muted">({problem.code})</span>
                </li>
              ))}
            </ul>
          )}
          {validation.stale.length > 0 && (
            <p className="v-ops__warn">
              {validation.stale.length}{' '}
              {validation.stale.length === 1 ? 'file no longer' : 'files no longer'} match the
              revision this set was built on.
            </p>
          )}
        </section>
      )}

      {diff !== null && (
        <section className="v-ops__subsection" aria-label="Proposed changes">
          <h5>Proposed changes</h5>
          {diff.files.map((file) => (
            <details key={`${file.path}-${file.op}`} className="v-ops__diff">
              <summary>
                <Badge
                  tone={file.op === 'delete' ? 'error' : file.op === 'create' ? 'success' : 'info'}
                >
                  {CHANGE_OP_LABEL[file.op]}
                </Badge>{' '}
                <code className="v-ops__mono">{file.path}</code>{' '}
                <span className="v-ops__muted">{file.size.toLocaleString()} bytes</span>
                {file.baseStale && <Badge tone="warning">project moved on</Badge>}
              </summary>
              {!file.contentAvailable && (
                <p className="v-ops__warn">
                  The proposed content is no longer stored, so it cannot be shown. The set can still
                  be validated or discarded.
                </p>
              )}
              {file.base !== null && (
                <div className="v-ops__diff-side">
                  <p className="v-ops__label">In the project now</p>
                  <pre className="v-ops__code">{file.base}</pre>
                </div>
              )}
              {file.proposed !== null && (
                <div className="v-ops__diff-side">
                  <p className="v-ops__label">
                    {file.op === 'create' ? 'Proposed file' : 'Proposed'}
                  </p>
                  <pre className="v-ops__code">{file.proposed}</pre>
                </div>
              )}
              {file.op === 'delete' && (
                <p className="v-ops__warn">This file would be removed from the project.</p>
              )}
            </details>
          ))}
          {diff.omittedFiles > 0 && (
            <p className="v-ops__muted">
              {diff.omittedFiles} more {diff.omittedFiles === 1 ? 'file is' : 'files are'} not shown
              here.
            </p>
          )}
          <p className="v-ops__muted">
            Each side is capped at {diff.maxChars.toLocaleString()} characters by the server.
          </p>
        </section>
      )}

      <section className="v-ops__subsection" aria-label="Conflicts">
        <h5>Conflicts</h5>
        {analysis === null ? (
          <p className="v-ops__muted">
            Not analysed yet. Conflicts are checked against every other open change set in this
            project.
          </p>
        ) : conflicts.length === 0 ? (
          <p className="v-ops__ok">No conflicts with other open change sets.</p>
        ) : (
          <>
            <p className="v-ops__error">
              {conflicts.length} {conflicts.length === 1 ? 'conflict' : 'conflicts'} detected.
              Nothing will be integrated until they are resolved.
            </p>
            <ul className="v-ops__list">
              {conflicts.map((conflict) => (
                <li key={`${conflict.kind}-${conflict.paths.join('|')}`}>
                  <Badge tone="error">{conflict.kind.replace(/_/g, ' ')}</Badge>{' '}
                  <code className="v-ops__mono">{conflict.paths.join(', ')}</code>
                  <p>{conflict.message}</p>
                  <p className="v-ops__muted">{conflict.suggestion}</p>
                </li>
              ))}
            </ul>
          </>
        )}
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'conflicts'}
          disabled={busy !== null && busy !== 'conflicts'}
          onClick={() => void openConflicts()}
        >
          Analyse conflicts
        </Button>
      </section>

      <section className="v-ops__subsection" aria-label="Integration">
        <h5>Integration</h5>
        {integrationRecord === null ? (
          <p className="v-ops__muted">
            {changeSet.status === 'integrated'
              ? 'Integrated, but the record is not in the recent history.'
              : 'Not integrated. The project is untouched until an approval is recorded and the ' +
                'integration runs.'}
          </p>
        ) : (
          <dl className="v-ops__facts">
            <div>
              <dt>Status</dt>
              <dd>
                <Badge
                  tone={
                    integrationRecord.status === 'completed'
                      ? 'success'
                      : integrationRecord.status === 'failed'
                        ? 'error'
                        : 'info'
                  }
                >
                  {integrationRecord.status.replace(/_/g, ' ')}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>
                {integrationRecord.revisionBefore}
                {integrationRecord.revisionAfter === null
                  ? ''
                  : ` → ${integrationRecord.revisionAfter}`}
              </dd>
            </div>
            <div>
              <dt>Files applied</dt>
              <dd>{integrationRecord.applied.length}</dd>
            </div>
            <div>
              <dt>When</dt>
              <dd>{relativeTime(integrationRecord.createdAt)}</dd>
            </div>
          </dl>
        )}

        {changeSet.status === 'open' && (
          <div className="v-ops__row">
            <Button
              size="sm"
              loading={busy === 'approve'}
              disabled={!eligible || (busy !== null && busy !== 'approve')}
              onClick={() => void approve('approve')}
            >
              Approve changes
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={busy === 'reject'}
              disabled={busy !== null && busy !== 'reject'}
              onClick={() => void approve('reject')}
            >
              Reject
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'integrate'}
              disabled={approvalId === null || busy !== null}
              onClick={() => void integrate()}
            >
              Integrate
            </Button>
          </div>
        )}
        {approvalId === null && changeSet.status === 'open' && (
          <p className="v-ops__muted">
            Integration needs a recorded approval. Approve first; the request is refused otherwise.
          </p>
        )}
        {!eligible && changeSet.status === 'open' && (
          <p className="v-ops__warn">
            This set cannot be approved while validation fails or its conflicts are unresolved.
          </p>
        )}
      </section>

      {actionError !== null && (
        <p className="v-ops__error" role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}
