import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge, Button, EmptyState, Select, Spinner } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  FAILURE_CATEGORIES,
  RECOVERY_STATUSES,
  cancelRecoveryCase,
  getRecoveryCase,
  reanalyseRecoveryCase,
  type RecoveryCaseDetailView,
  type RecoveryCaseView,
  type RecoveryFilters,
  type RecoveryOverviewView,
  type RepairAttemptView,
} from '../../api/recovery';
import type { TaskView, WorkerView } from '../../api/operations';
import {
  CONFIDENCE_LABEL,
  CONFIDENCE_TONE,
  RECOVERY_STATUS_LABEL,
  attemptBudget,
  caseHeadline,
  categoryLabel,
  isRecoveredWithEvidence,
  summariseRecoveryVerification,
} from './recovery-status';
import { relativeTime } from './status';

/**
 * The recovery section of the operations dashboard (Step 49).
 *
 * It reads the Step 48 records and nothing else: the diagnosis, the attempt
 * history and the verification evidence are what the server stored, and the
 * only controls are the ones the recovery engine already exposes (re-read the
 * evidence, cancel a case). Nothing here can start a repair, raise an attempt
 * limit or mark a case recovered.
 */
export interface RecoveryPanelProps {
  readonly cases: readonly RecoveryCaseView[];
  readonly overview: RecoveryOverviewView | null;
  readonly filters: RecoveryFilters;
  readonly onFiltersChange: (filters: RecoveryFilters) => void;
  readonly tasks: readonly TaskView[];
  readonly workers: readonly WorkerView[];
  readonly projects: readonly string[];
  readonly onRefresh: () => void;
  readonly onChanged: (message: string) => void;
  readonly onNotifyFailed: (message: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenWorker: (workerId: string) => void;
  readonly onOpenChangeSet: (changeSetId: string) => void;
  /** The dashboard's read clock, so an open case re-reads when records move. */
  readonly readAt: number;
}

const VERIFICATION_FILTERS = ['passed', 'failed', 'not_run'] as const;

const VERIFICATION_LABEL: Record<(typeof VERIFICATION_FILTERS)[number], string> = {
  passed: 'Verification passed',
  failed: 'Verification failed',
  not_run: 'No verification run',
};

const TILE_ORDER = [
  'total',
  'awaitingDiagnosis',
  'repairing',
  'recovered',
  'needsIntervention',
  'insufficientEvidence',
  'exhausted',
] as const;

type TileKey = (typeof TILE_ORDER)[number];

const TILE_LABEL: Record<TileKey, string> = {
  total: 'Recovery cases',
  awaitingDiagnosis: 'Awaiting diagnosis',
  repairing: 'Being repaired',
  recovered: 'Recovered',
  needsIntervention: 'Needs intervention',
  insufficientEvidence: 'Insufficient evidence',
  exhausted: 'Attempts used up',
};

const TILE_TONE: Record<TileKey, 'neutral' | 'success' | 'warning' | 'error' | 'info'> = {
  total: 'neutral',
  awaitingDiagnosis: 'info',
  repairing: 'info',
  recovered: 'success',
  needsIntervention: 'error',
  insufficientEvidence: 'warning',
  exhausted: 'error',
};

/** Tiles that map onto a server filter; `total` clears the filter instead. */
function tileFilters(key: TileKey): RecoveryFilters | null {
  switch (key) {
    case 'awaitingDiagnosis':
      return { status: ['open', 'diagnosing'] };
    case 'repairing':
      return { status: ['repairing', 'awaiting_verification'] };
    case 'recovered':
      return { status: ['recovered'] };
    case 'needsIntervention':
      return { status: ['escalated'] };
    case 'insufficientEvidence':
      return { insufficientEvidence: true };
    case 'exhausted':
      return { exhausted: true };
    default:
      return null;
  }
}

function formatWhen(iso: string | null): string {
  if (iso === null) return '—';
  return relativeTime(iso);
}

export function RecoveryPanel(props: RecoveryPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecoveryCaseDetailView | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [detailError, setDetailError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [openOnMobile, setOpenOnMobile] = useState(false);
  const requestedFor = useRef<string | null>(null);

  const selected = useMemo(
    () => props.cases.find((record) => record.id === selectedId) ?? null,
    [props.cases, selectedId],
  );

  const loadDetail = useCallback(async (caseId: string, options: { silent?: boolean } = {}) => {
    if (options.silent !== true) setDetailState('loading');
    try {
      const next = await getRecoveryCase(caseId);
      setDetail(next);
      setDetailError(null);
      setDetailState('ready');
    } catch (cause) {
      setDetailError(cause);
      setDetailState('error');
    }
  }, []);

  // A selected case is re-read whenever the dashboard's read clock moves, so
  // an attempt or a verification result appears without a second poll loop.
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDetailState('idle');
      return;
    }
    const stamp = `${selectedId}:${props.readAt}:${selected?.updatedAt ?? ''}`;
    if (requestedFor.current === stamp) return;
    requestedFor.current = stamp;
    void loadDetail(selectedId, { silent: detail !== null });
  }, [detail, loadDetail, props.readAt, selected?.updatedAt, selectedId]);

  const onSelect = (caseId: string): void => {
    setSelectedId(caseId);
    setConfirmingCancel(false);
    setOpenOnMobile(true);
  };

  const onCancel = async (record: RecoveryCaseView): Promise<void> => {
    setBusy('cancel');
    try {
      await cancelRecoveryCase(record.id, 'Recovery cancelled from the operations dashboard.');
      props.onChanged('The recovery case was cancelled.');
      setConfirmingCancel(false);
      await loadDetail(record.id, { silent: true });
    } catch (cause) {
      props.onNotifyFailed(
        cause instanceof ApiError
          ? cause.message
          : 'The cancellation did not go through. Nothing was changed.',
      );
    } finally {
      setBusy(null);
    }
  };

  const onReanalyse = async (record: RecoveryCaseView): Promise<void> => {
    setBusy('analyse');
    try {
      await reanalyseRecoveryCase(record.id);
      props.onChanged('The case was diagnosed again from the stored evidence.');
      await loadDetail(record.id, { silent: true });
    } catch (cause) {
      props.onNotifyFailed(
        cause instanceof ApiError
          ? cause.message
          : 'The diagnosis could not be refreshed. Nothing was changed.',
      );
    } finally {
      setBusy(null);
    }
  };

  const activeFilters: string[] = [];
  if (props.filters.status !== undefined && props.filters.status.length > 0) {
    activeFilters.push(
      props.filters.status.map((entry) => RECOVERY_STATUS_LABEL[entry]).join(', '),
    );
  }
  if (props.filters.category !== undefined && props.filters.category.length > 0) {
    activeFilters.push(props.filters.category.map((entry) => categoryLabel(entry)).join(', '));
  }
  if (props.filters.verification !== undefined) {
    activeFilters.push(VERIFICATION_LABEL[props.filters.verification]);
  }
  if (props.filters.insufficientEvidence === true) activeFilters.push('Insufficient evidence');
  if (props.filters.exhausted === true) activeFilters.push('Attempts used up');
  if (props.filters.projectId !== undefined) activeFilters.push(props.filters.projectId);
  if (props.filters.since !== undefined || props.filters.until !== undefined) {
    activeFilters.push('Date range');
  }

  const overview = props.overview;
  const showEmpty = props.cases.length === 0;

  return (
    <section className="v-ops__section v-recovery" aria-label="Recovery">
      <div className="v-ops__section-head">
        <div>
          <h3>Recovery</h3>
          <p className="v-ops__muted">
            Every case below is a failure the Primary Agent diagnosed from a worker&rsquo;s stored
            record. A case is only recovered when a stored verification run passed.
          </p>
        </div>
        <div className="v-ops__row">
          <Button size="sm" variant="secondary" onClick={props.onRefresh}>
            Refresh recovery
          </Button>
        </div>
      </div>

      {overview === null ? (
        <p className="v-ops__panel-loading">
          <Spinner size="sm" /> Reading recovery records…
        </p>
      ) : (
        <>
          <div className="v-ops__tiles v-recovery__tiles">
            {TILE_ORDER.map((key) => {
              const value =
                key === 'total'
                  ? overview.total
                  : key === 'insufficientEvidence'
                    ? overview.insufficientEvidence
                    : (overview[key as Exclude<TileKey, 'insufficientEvidence'>] ?? 0);
              const filters = tileFilters(key);
              const active =
                key === 'total'
                  ? activeFilters.length === 0
                  : filters !== null &&
                    props.filters.status?.[0] === filters.status?.[0] &&
                    filters.status !== undefined;
              return (
                <button
                  key={key}
                  type="button"
                  className={`v-ops__tile ${active ? 'v-ops__tile--active' : ''}`}
                  aria-pressed={active}
                  onClick={() =>
                    props.onFiltersChange(
                      filters === null
                        ? { projectId: props.filters.projectId }
                        : { ...filters, projectId: props.filters.projectId },
                    )
                  }
                >
                  <span className="v-ops__tile-label">{TILE_LABEL[key]}</span>
                  <span className="v-ops__tile-value">{value}</span>
                  <Badge tone={TILE_TONE[key]} dot />
                </button>
              );
            })}
          </div>
          <p className="v-ops__muted">
            {overview.attemptsRemaining} repair{' '}
            {overview.attemptsRemaining === 1 ? 'attempt' : 'attempts'} left across open cases ·{' '}
            {overview.verificationFailed} with a failing verification run
            {overview.truncated ? ' · counting the most recent 500 cases' : ''}
          </p>
        </>
      )}

      <div className="v-ops__filters v-recovery__filters">
        <label className="v-ops__field">
          <span className="v-ops__label">Status</span>
          <Select
            aria-label="Filter recovery by status"
            value={props.filters.status?.[0] ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;
              props.onFiltersChange({
                ...props.filters,
                status: value === 'all' ? undefined : [value as (typeof RECOVERY_STATUSES)[number]],
              });
            }}
            options={[
              { value: 'all', label: 'All statuses' },
              ...RECOVERY_STATUSES.map((status) => ({
                value: status,
                label: RECOVERY_STATUS_LABEL[status],
              })),
            ]}
          />
        </label>

        <label className="v-ops__field">
          <span className="v-ops__label">Failure</span>
          <Select
            aria-label="Filter recovery by failure category"
            value={props.filters.category?.[0] ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;
              props.onFiltersChange({
                ...props.filters,
                category:
                  value === 'all' ? undefined : [value as (typeof FAILURE_CATEGORIES)[number]],
              });
            }}
            options={[
              { value: 'all', label: 'All failure types' },
              ...FAILURE_CATEGORIES.map((category) => ({
                value: category,
                label: categoryLabel(category),
              })),
            ]}
          />
        </label>

        <label className="v-ops__field">
          <span className="v-ops__label">Verification</span>
          <Select
            aria-label="Filter recovery by verification outcome"
            value={props.filters.verification ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;
              props.onFiltersChange({
                ...props.filters,
                verification:
                  value === 'all' ? undefined : (value as 'passed' | 'failed' | 'not_run'),
              });
            }}
            options={[
              { value: 'all', label: 'Any verification' },
              ...VERIFICATION_FILTERS.map((key) => ({
                value: key,
                label: VERIFICATION_LABEL[key],
              })),
            ]}
          />
        </label>

        <label className="v-ops__field">
          <span className="v-ops__label">Worker</span>
          <Select
            aria-label="Filter recovery by worker"
            value={props.filters.workerId ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;
              props.onFiltersChange({
                ...props.filters,
                workerId: value === 'all' ? undefined : value,
              });
            }}
            options={[
              { value: 'all', label: 'Any worker' },
              ...props.workers
                .filter((worker) =>
                  ['failed', 'timed_out', 'blocked', 'cancelled'].includes(worker.status),
                )
                .slice(0, 40)
                .map((worker) => ({
                  value: worker.id,
                  label: `${worker.workerType} · ${worker.id.slice(-6)}`,
                })),
            ]}
          />
        </label>

        <label className="v-ops__field">
          <span className="v-ops__label">Project</span>
          <Select
            aria-label="Filter recovery by project"
            value={props.filters.projectId ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;
              props.onFiltersChange({
                ...props.filters,
                projectId: value === 'all' ? undefined : value,
              });
            }}
            options={[
              { value: 'all', label: 'All projects' },
              ...props.projects.map((project) => ({ value: project, label: project })),
            ]}
          />
        </label>

        <label className="v-ops__field">
          <span className="v-ops__label">Since</span>
          <input
            className="v-ops__input"
            type="date"
            aria-label="Only cases created since"
            value={props.filters.since?.slice(0, 10) ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              props.onFiltersChange({
                ...props.filters,
                since: value === '' ? undefined : new Date(`${value}T00:00:00Z`).toISOString(),
              });
            }}
          />
        </label>

        {activeFilters.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => props.onFiltersChange({ projectId: props.filters.projectId })}
          >
            Clear filters
          </Button>
        )}
      </div>

      {showEmpty ? (
        <EmptyState
          title="No recovery cases match"
          description={
            activeFilters.length === 0
              ? 'No Superagent failure has needed repair yet. Cases appear here as soon as one is diagnosed.'
              : `Nothing matches ${activeFilters.join(' · ')}. Clear the filters to see every case.`
          }
          action={
            activeFilters.length === 0
              ? undefined
              : {
                  label: 'Clear filters',
                  onClick: () => props.onFiltersChange({ projectId: props.filters.projectId }),
                }
          }
        />
      ) : (
        <div className="v-ops__table-wrap">
          <table className="v-ops__table">
            <caption className="v-ops__sr-only">
              Recovery cases, most recently created first
            </caption>
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">State</th>
                <th scope="col">Failure</th>
                <th scope="col">Attempts</th>
                <th scope="col">Verification</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {props.cases.map((record) => {
                const headline = caseHeadline(record);
                const budget = attemptBudget(record);
                const verification = summariseRecoveryVerification(record.verification);
                return (
                  <tr
                    key={record.id}
                    className={record.id === selectedId ? 'v-ops__row--active' : undefined}
                  >
                    <td>
                      <button
                        type="button"
                        className="v-ops__link-button"
                        onClick={() => onSelect(record.id)}
                        aria-label={`Open recovery case ${record.id}`}
                      >
                        <span className="v-ops__mono">{record.id}</span>
                      </button>
                      <span className="v-ops__timeline-meta">
                        task <span className="v-ops__mono">{record.taskId}</span>
                      </span>
                    </td>
                    <td>
                      <Badge tone={headline.tone}>{headline.label}</Badge>
                    </td>
                    <td>{categoryLabel(record.diagnosis?.primary ?? null)}</td>
                    <td>
                      {budget.used} of {budget.max}
                      {budget.exhausted && (
                        <>
                          {' '}
                          <Badge tone="error">Used up</Badge>
                        </>
                      )}
                    </td>
                    <td>{verification.label}</td>
                    <td>{formatWhen(record.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedId !== null && (
        <div
          className={`v-recovery__detail ${openOnMobile ? 'v-recovery__detail--open' : ''}`}
          role="region"
          aria-label={`Recovery case ${selectedId}`}
        >
          <div className="v-recovery__detail-head">
            <h4>Case {selectedId}</h4>
            <div className="v-ops__row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void loadDetail(selectedId)}
                disabled={detailState === 'loading'}
              >
                {detailState === 'loading' ? 'Reading…' : 'Re-read case'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelectedId(null);
                  setOpenOnMobile(false);
                }}
              >
                Close
              </Button>
            </div>
          </div>

          {detailState === 'loading' && detail === null && (
            <p className="v-ops__panel-loading">
              <Spinner size="sm" /> Reading the case, its attempts and its evidence…
            </p>
          )}

          {detailState === 'error' && (
            <EmptyState
              title="This case could not be read"
              description={
                detailError instanceof ApiError
                  ? detailError.message
                  : 'The service did not answer. Nothing was changed.'
              }
              action={{ label: 'Try again', onClick: () => void loadDetail(selectedId) }}
            />
          )}

          {detail !== null && detail.case.id === selectedId && (
            <CaseDetail
              detail={detail}
              tasks={props.tasks}
              workers={props.workers}
              busy={busy}
              confirmingCancel={confirmingCancel}
              onAskCancel={() => setConfirmingCancel(true)}
              onDismissCancel={() => setConfirmingCancel(false)}
              onCancel={() => void onCancel(detail.case)}
              onReanalyse={() => void onReanalyse(detail.case)}
              onOpenTask={props.onOpenTask}
              onOpenWorker={props.onOpenWorker}
              onOpenChangeSet={props.onOpenChangeSet}
            />
          )}
        </div>
      )}
    </section>
  );
}

interface CaseDetailProps {
  readonly detail: RecoveryCaseDetailView;
  readonly tasks: readonly TaskView[];
  readonly workers: readonly WorkerView[];
  readonly busy: string | null;
  readonly confirmingCancel: boolean;
  readonly onAskCancel: () => void;
  readonly onDismissCancel: () => void;
  readonly onCancel: () => void;
  readonly onReanalyse: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenWorker: (workerId: string) => void;
  readonly onOpenChangeSet: (changeSetId: string) => void;
}

function CaseDetail(props: CaseDetailProps) {
  const { case: record, attempts } = props.detail;
  const headline = caseHeadline(record);
  const budget = attemptBudget(record);
  const verification = summariseRecoveryVerification(record.verification);
  const diagnosis = record.diagnosis;
  const insufficient =
    diagnosis === null || diagnosis.insufficient === true || diagnosis.primary === null;
  const closeable = ['open', 'diagnosing', 'repairing', 'awaiting_verification'].includes(
    record.status,
  );

  const workerOf = (workerId: string | null): WorkerView | null =>
    workerId === null ? null : (props.workers.find((worker) => worker.id === workerId) ?? null);

  /** A repair runs on its own child task; the worker record names it. */
  const childTaskOf = (attempt: RepairAttemptView): string | null =>
    workerOf(attempt.workerId)?.taskId ?? null;

  const childTasks = new Set(
    attempts
      .map((attempt) => childTaskOf(attempt))
      .filter((taskId): taskId is string => taskId !== null),
  );

  return (
    <div className="v-recovery__case">
      <div className="v-recovery__headline">
        <Badge tone={headline.tone}>{headline.label}</Badge>
        <span className="v-ops__muted">
          created {formatWhen(record.createdAt)} · updated {formatWhen(record.updatedAt)}
        </span>
      </div>

      {headline.warning !== null && (
        <p className="v-ops__warn" role="alert">
          {headline.warning}
        </p>
      )}

      <dl className="v-recovery__facts">
        <div>
          <dt>Original task</dt>
          <dd>
            <button
              type="button"
              className="v-ops__link-button v-ops__mono"
              onClick={() => props.onOpenTask(record.taskId)}
            >
              {record.taskId}
            </button>
          </dd>
        </div>
        <div>
          <dt>Failed Superagent</dt>
          <dd>
            {record.workerId === null ? (
              '—'
            ) : (
              <button
                type="button"
                className="v-ops__link-button v-ops__mono"
                onClick={() => props.onOpenWorker(record.workerId as string)}
              >
                {record.workerId}
              </button>
            )}
            {record.workerType !== null && (
              <span className="v-ops__timeline-meta"> · {record.workerType}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Failure category</dt>
          <dd>{categoryLabel(diagnosis?.primary ?? null)}</dd>
        </div>
        <div>
          <dt>Repair attempts</dt>
          <dd>
            {budget.used} of {budget.max} used · {budget.remaining} left
          </dd>
        </div>
        <div>
          <dt>Reassignments</dt>
          <dd>
            {record.reassignments} of {record.limits.maxReassignments}
          </dd>
        </div>
        <div>
          <dt>Change sets preserved</dt>
          <dd>{record.observation.changeSet?.id ?? '—'}</dd>
        </div>
      </dl>

      <div className="v-recovery__columns">
        <section aria-label="Observed facts">
          <h5>What was observed</h5>
          <ul className="v-recovery__list">
            <li>
              The worker ended <strong>{record.observation.workerStatus.replace(/_/g, ' ')}</strong>
              {record.observation.failure === null
                ? ' without reporting an error of its own.'
                : ` and reported ${record.observation.failure.code}: ${record.observation.failure.message}`}
            </li>
            <li>
              Declared deliverables:{' '}
              {record.observation.deliverables.declared.length === 0
                ? 'none'
                : record.observation.deliverables.declared.join(', ')}
            </li>
            <li>
              Produced:{' '}
              {record.observation.deliverables.produced.length === 0
                ? 'nothing'
                : record.observation.deliverables.produced.join(', ')}
            </li>
            {record.observation.deliverables.missing.length > 0 && (
              <li>Missing: {record.observation.deliverables.missing.join(', ')}</li>
            )}
            <li>
              Verification at failure:{' '}
              {record.observation.verification === null
                ? 'no run was executed'
                : `${record.observation.verification.status} (${record.observation.verification.runId})`}
            </li>
          </ul>
          <p className="v-ops__muted">
            These are read from the worker&rsquo;s stored record. They are not a theory about the
            failure.
          </p>
        </section>

        <section aria-label="Diagnosis">
          <h5>What the Primary Agent concluded</h5>
          {insufficient ? (
            <>
              <Badge tone="warning">insufficient_evidence</Badge>
              <p className="v-recovery__insufficient">
                {diagnosis === null
                  ? 'No diagnosis has been recorded for this case yet.'
                  : diagnosis.reason}
              </p>
              <p className="v-ops__muted">
                The case needs a person to decide what to do next. No explanation was invented to
                fill the gap.
              </p>
            </>
          ) : (
            <>
              <div className="v-ops__chips">
                <Badge tone="primary">{categoryLabel(diagnosis.primary)}</Badge>
                <Badge tone={CONFIDENCE_TONE[diagnosis.confidence]}>
                  {CONFIDENCE_LABEL[diagnosis.confidence]}
                </Badge>
              </div>
              <p>{diagnosis.likelyCause ?? diagnosis.reason}</p>
              <p className="v-ops__muted">{diagnosis.reason}</p>
              {diagnosis.affectedDeliverables.length > 0 && (
                <p>
                  Affected deliverables:{' '}
                  <span className="v-ops__mono">{diagnosis.affectedDeliverables.join(', ')}</span>
                </p>
              )}
              {diagnosis.recommendedAction !== null && (
                <p>
                  Recommended action:{' '}
                  <strong>{diagnosis.recommendedAction.replace(/_/g, ' ')}</strong>
                </p>
              )}
              {diagnosis.evidence.length > 0 && (
                <ul className="v-recovery__list v-recovery__evidence">
                  {diagnosis.evidence.map((item, index) => (
                    <li key={`${item.kind}:${item.ref}:${index}`}>
                      <span className="v-recovery__evidence-kind">
                        {item.kind.replace(/_/g, ' ')}
                      </span>{' '}
                      <span className="v-ops__mono">{item.ref}</span> — {item.detail}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>

      <section aria-label="Repair attempts" className="v-recovery__attempts">
        <h5>
          Repair attempts{' '}
          <span className="v-ops__muted">
            ({budget.used} of {budget.max} · {budget.remaining} left)
          </span>
        </h5>
        <p className="v-ops__muted">
          Each repair runs on its own child task under the original one. The failed task is never
          rewritten, and the limit of {budget.max} attempts is enforced by the recovery engine.
        </p>
        {attempts.length === 0 ? (
          <p className="v-ops__muted">No repair has been attempted yet.</p>
        ) : (
          <ol className="v-recovery__timeline">
            {attempts.map((attempt) => {
              const childTask = childTaskOf(attempt);
              return (
                <li key={attempt.id} className="v-recovery__attempt">
                  <div className="v-recovery__attempt-head">
                    <span className="v-ops__strong">Attempt {attempt.attempt}</span>
                    <Badge
                      tone={
                        attempt.outcome === 'succeeded'
                          ? 'success'
                          : attempt.outcome === 'running'
                            ? 'info'
                            : 'error'
                      }
                    >
                      {attempt.outcome.replace(/_/g, ' ')}
                    </Badge>
                    {attempt.waitedMs > 0 && (
                      <span className="v-ops__timeline-meta">
                        waited {Math.round(attempt.waitedMs / 1000)}s before starting
                      </span>
                    )}
                  </div>
                  <dl className="v-recovery__attempt-meta">
                    <div>
                      <dt>Child task</dt>
                      <dd>
                        {childTask === null ? (
                          '—'
                        ) : (
                          <button
                            type="button"
                            className="v-ops__link-button v-ops__mono"
                            onClick={() => props.onOpenTask(childTask)}
                          >
                            {childTask}
                          </button>
                        )}
                        {childTask !== null && childTask === record.taskId && (
                          <span className="v-ops__timeline-meta"> · same as the original task</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Repair Superagent</dt>
                      <dd>
                        {attempt.workerId === null ? (
                          '—'
                        ) : (
                          <button
                            type="button"
                            className="v-ops__link-button v-ops__mono"
                            onClick={() => props.onOpenWorker(attempt.workerId as string)}
                          >
                            {attempt.workerId}
                          </button>
                        )}
                        {attempt.workerType !== null && ` · ${attempt.workerType}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Started</dt>
                      <dd>{formatWhen(attempt.startedAt)}</dd>
                    </div>
                    <div>
                      <dt>Ended</dt>
                      <dd>{formatWhen(attempt.endedAt)}</dd>
                    </div>
                    <div>
                      <dt>Verification run</dt>
                      <dd className="v-ops__mono">{attempt.verificationRunId ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Change set</dt>
                      <dd>
                        {attempt.changeSetId === null ? (
                          '—'
                        ) : (
                          <button
                            type="button"
                            className="v-ops__link-button v-ops__mono"
                            onClick={() => props.onOpenChangeSet(attempt.changeSetId as string)}
                          >
                            {attempt.changeSetId}
                          </button>
                        )}
                      </dd>
                    </div>
                  </dl>
                  {attempt.summary !== null && <p className="v-ops__muted">{attempt.summary}</p>}
                </li>
              );
            })}
          </ol>
        )}
        {childTasks.size > 0 && (
          <p className="v-ops__timeline-meta">
            {childTasks.size} child {childTasks.size === 1 ? 'task' : 'tasks'} under this case.
          </p>
        )}
      </section>

      <section aria-label="Verification evidence" className="v-recovery__verification">
        <h5>Verification evidence</h5>
        <div className="v-ops__chips">
          <Badge
            tone={
              verification.tone === 'success'
                ? 'success'
                : verification.tone === 'error'
                  ? 'error'
                  : 'neutral'
            }
          >
            {verification.label}
          </Badge>
          {record.verification !== null && (
            <>
              <span className="v-ops__mono">{record.verification.runId}</span>
              <span className="v-ops__timeline-meta">
                {record.verification.executedCount} command
                {record.verification.executedCount === 1 ? '' : 's'} executed
              </span>
            </>
          )}
        </div>
        <p className="v-ops__muted">{verification.detail}</p>
        {record.verification !== null && record.verification.failedOperations.length > 0 && (
          <p>
            Failing operations:{' '}
            <span className="v-ops__mono">{record.verification.failedOperations.join(', ')}</span>
          </p>
        )}
        {record.verification !== null && record.verification.evidence.length > 0 && (
          <ul className="v-recovery__list v-recovery__evidence">
            {record.verification.evidence.map((item, index) => (
              <li key={`${item.ref}:${index}`}>
                <span className="v-recovery__evidence-kind">{item.kind.replace(/_/g, ' ')}</span>{' '}
                <span className="v-ops__mono">{item.ref}</span> — {item.detail}
              </li>
            ))}
          </ul>
        )}
        <p className="v-ops__muted">
          {isRecoveredWithEvidence(record)
            ? 'This evidence is the stored run that allows the case to be called recovered.'
            : 'A case is only called recovered when a stored run like this one passed.'}
        </p>
      </section>

      {record.escalation !== null && (
        <section aria-label="Escalation" className="v-recovery__escalation">
          <h5>Why this needs a person</h5>
          <p>
            <Badge tone="error">{record.escalation.reason.replace(/_/g, ' ')}</Badge>{' '}
            {record.escalation.message}
          </p>
          {record.escalation.attempted.length > 0 && (
            <>
              <p className="v-ops__label">Already attempted</p>
              <ul className="v-recovery__list">
                {record.escalation.attempted.map((entry, index) => (
                  <li key={`attempted:${index}`}>{entry}</li>
                ))}
              </ul>
            </>
          )}
          {record.escalation.remaining.length > 0 && (
            <>
              <p className="v-ops__label">Still not done</p>
              <ul className="v-recovery__list">
                {record.escalation.remaining.map((entry, index) => (
                  <li key={`remaining:${index}`}>{entry}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {record.stoppedReason !== null && record.escalation === null && (
        <p className="v-ops__muted">{record.stoppedReason}</p>
      )}

      <div className="v-recovery__actions">
        <Button
          size="sm"
          variant="secondary"
          onClick={props.onReanalyse}
          disabled={props.busy !== null}
        >
          {props.busy === 'analyse' ? 'Re-reading evidence…' : 'Diagnose again'}
        </Button>
        {closeable && !props.confirmingCancel && (
          <Button size="sm" variant="ghost" onClick={props.onAskCancel}>
            Cancel recovery
          </Button>
        )}
        {props.confirmingCancel && (
          <div className="v-recovery__confirm" role="group" aria-label="Confirm cancellation">
            <p>
              Cancelling stops this recovery. The failed task keeps its record and the case stays
              visible as cancelled.
            </p>
            <div className="v-ops__row">
              <Button
                size="sm"
                variant="danger"
                onClick={props.onCancel}
                disabled={props.busy !== null}
              >
                {props.busy === 'cancel' ? 'Cancelling…' : 'Yes, cancel it'}
              </Button>
              <Button size="sm" variant="ghost" onClick={props.onDismissCancel}>
                Keep it running
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
