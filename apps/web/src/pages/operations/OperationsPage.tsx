import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge, Button, EmptyState, Select, Spinner, useToast } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  listChangeSets,
  listIntegrations,
  listSchedulingDecisions,
  listTasks,
  listVerificationRuns,
  listWorkers,
  type ChangeSetView,
  type IntegrationRecordView,
  type SchedulingDecisionView,
  type TaskView,
  type VerificationRunView,
  type WorkerView,
} from '../../api/operations';
import {
  getRecoveryOverview,
  listRecoveryCases,
  type RecoveryCaseView,
  type RecoveryFilters,
  type RecoveryOverviewView,
} from '../../api/recovery';
import { ChangeSetReview } from './ChangeSetReview';
import { ExecutionPanel } from './ExecutionPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { ReliabilityPanel } from './ReliabilityPanel';
import { UsagePanel } from './UsagePanel';
import { MessageCreditsPanel } from './MessageCreditsPanel';
import { IntegrationCreditsPanel } from './IntegrationCreditsPanel';
import { WalletPanel } from './WalletPanel';
import {
  RECOVERY_NOTIFICATION_LABEL as RECOVERY_NOTIFICATION_COPY,
  recoveryNotificationsFor,
} from './recovery-status';
import { WorkerDetailPanel } from './WorkerDetailPanel';
import {
  WORKER_GROUP_LABEL,
  WORKER_GROUP_ORDER,
  changeSetStatusTone,
  changeSetStatusLabel,
  formatDuration,
  notificationsFor,
  relativeTime,
  summariseVerification,
  taskStatusLabel,
  taskStatusTone,
  workerDuration,
  workerGroup,
  workerGroupTone,
  workerStatusLabel,
  NOTIFICATION_LABEL,
  type WorkerGroup,
} from './status';
import './operations.css';

/** How often the dashboard re-reads the server's own records. */
const POLL_MS = 5000;

interface Snapshot {
  readonly workers: readonly WorkerView[];
  readonly tasks: readonly TaskView[];
  readonly changeSets: readonly ChangeSetView[];
  readonly records: readonly IntegrationRecordView[];
  readonly verifications: readonly VerificationRunView[];
  readonly decisions: readonly SchedulingDecisionView[];
  readonly recovery: readonly RecoveryCaseView[];
  readonly recoveryOverview: RecoveryOverviewView;
  readonly at: number;
}

async function loadSnapshot(recoveryFilters: RecoveryFilters): Promise<Snapshot> {
  const [
    workers,
    tasks,
    changeSets,
    records,
    verifications,
    decisions,
    recovery,
    recoveryOverview,
  ] = await Promise.all([
    listWorkers({ limit: 200 }),
    listTasks(200),
    listChangeSets({ limit: 100 }),
    listIntegrations(),
    listVerificationRuns({ limit: 50 }),
    listSchedulingDecisions(),
    listRecoveryCases({ ...recoveryFilters, limit: 200 }),
    getRecoveryOverview(recoveryFilters),
  ]);
  return {
    workers: workers.workers,
    tasks,
    changeSets,
    records,
    verifications,
    decisions,
    recovery,
    recoveryOverview,
    at: Date.now(),
  };
}

type GroupFilter = WorkerGroup | 'all';

/**
 * The Superagent operations dashboard (Step 47).
 *
 * One page over the records Steps 42-46 already keep: workers and their events,
 * tasks, change sets and integrations, verification runs and scheduler
 * decisions. It starts nothing and decides nothing - every control calls an
 * existing route, and every state shown is what the server reported.
 *
 * The page polls. There is no push stream for these records, so it says
 * "refreshes every 5 seconds" rather than pretending to be live.
 */
export function OperationsPage() {
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [group, setGroup] = useState<GroupFilter>('all');
  const [projectId, setProjectId] = useState<string>('all');
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [recoveryFilters, setRecoveryFilters] = useState<RecoveryFilters>({});
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const previous = useRef<Snapshot | null>(null);

  const refresh = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (options.silent !== true)
        setState((current) => (current === 'ready' ? current : 'loading'));
      try {
        const next = await loadSnapshot(recoveryFilters);
        setSnapshot(next);
        setError(null);
        setState('ready');
      } catch (cause) {
        setError(cause);
        setState((current) => (current === 'ready' ? current : 'error'));
      }
    },
    [recoveryFilters],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Polling, paused while the tab is hidden and while the owner pauses it.
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh({ silent: true });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [paused, refresh]);

  // Important transitions are announced once each; routine progress is not.
  useEffect(() => {
    if (snapshot === null) return;
    const before = previous.current;
    previous.current = snapshot;
    if (before === null) {
      // The first read is the baseline: nothing "just happened".
      for (const worker of snapshot.workers) seen.current.add(`${worker.id}:failed`);
      for (const record of snapshot.recovery) {
        seen.current.add(`${record.id}:started`);
        seen.current.add(`${record.id}:cancelled`);
        seen.current.add(`${record.id}:recovered`);
        seen.current.add(`${record.id}:${record.status}:escalated`);
        seen.current.add(`${record.id}:budget:exhausted`);
        for (let attempt = 1; attempt <= record.attempts; attempt += 1) {
          seen.current.add(`${record.id}:${attempt}:repair`);
        }
      }
      return;
    }
    const events = notificationsFor(
      {
        workers: before.workers,
        taskStatuses: Object.fromEntries(before.tasks.map((task) => [task.id, task.status])),
      },
      {
        workers: snapshot.workers,
        taskStatuses: Object.fromEntries(snapshot.tasks.map((task) => [task.id, task.status])),
      },
      seen.current,
    );
    for (const event of recoveryNotificationsFor(
      before.recovery,
      snapshot.recovery,
      seen.current,
    )) {
      seen.current.add(event.key);
      toast(RECOVERY_NOTIFICATION_COPY[event.event], {
        tone:
          event.event === 'recovery_needs_intervention' ||
          event.event === 'recovery_budget_exhausted'
            ? 'error'
            : event.event === 'recovery_recovered'
              ? 'success'
              : 'info',
      });
    }
    for (const event of events) {
      seen.current.add(event.key);
      toast(NOTIFICATION_LABEL[event.event], {
        tone:
          event.event === 'worker_failed' || event.event === 'verification_failed'
            ? 'error'
            : event.event === 'task_completed' || event.event === 'integration_succeeded'
              ? 'success'
              : 'info',
      });
    }
  }, [snapshot, toast]);

  const projects = useMemo(() => {
    const ids = new Set<string>();
    for (const changeSet of snapshot?.changeSets ?? []) ids.add(changeSet.projectId);
    for (const task of snapshot?.tasks ?? []) if (task.projectId !== null) ids.add(task.projectId);
    for (const run of snapshot?.verifications ?? []) ids.add(run.projectId);
    return [...ids];
  }, [snapshot]);

  const workers = useMemo(() => {
    const all = snapshot?.workers ?? [];
    const scoped =
      projectId === 'all'
        ? all
        : all.filter((worker) => {
            const task = snapshot?.tasks.find((entry) => entry.id === worker.taskId);
            return task?.projectId === projectId;
          });
    return group === 'all'
      ? scoped
      : scoped.filter((worker) => workerGroup(worker.status) === group);
  }, [group, projectId, snapshot]);

  const counts = useMemo(() => {
    const tally = new Map<WorkerGroup, number>();
    for (const worker of snapshot?.workers ?? []) {
      const key = workerGroup(worker.status);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return tally;
  }, [snapshot]);

  const selectedWorker =
    selectedWorkerId === null
      ? null
      : ((snapshot?.workers ?? []).find((worker) => worker.id === selectedWorkerId) ?? null);
  const selectedChangeSet =
    selectedChangeSetId === null
      ? null
      : ((snapshot?.changeSets ?? []).find((entry) => entry.id === selectedChangeSetId) ?? null);

  const onWorkerChanged = useCallback(() => {
    void refresh({ silent: true });
  }, [refresh]);

  const onChanged = useCallback(
    (message: string) => {
      toast(message, { tone: 'success' });
      void refresh({ silent: true });
    },
    [refresh, toast],
  );

  const onNotifyFailed = useCallback(
    (message: string) => {
      toast(message, { tone: 'error' });
    },
    [toast],
  );

  if (state === 'loading' && snapshot === null) {
    return (
      <section className="v-ops" aria-busy="true" aria-label="Superagent operations">
        <header className="v-ops__head">
          <h2 className="v-ops__title">Superagent operations</h2>
        </header>
        <p className="v-ops__panel-loading">
          <Spinner size="sm" /> Reading the Primary Agent's records…
        </p>
      </section>
    );
  }

  if (state === 'error' && snapshot === null) {
    return (
      <section className="v-ops" aria-label="Superagent operations">
        <header className="v-ops__head">
          <h2 className="v-ops__title">Superagent operations</h2>
        </header>
        <EmptyState
          title="The operations dashboard could not load"
          description={
            error instanceof ApiError
              ? error.message
              : 'The service did not answer. Nothing was changed.'
          }
          action={{ label: 'Try again', onClick: () => void refresh() }}
        />
      </section>
    );
  }

  const data = snapshot as Snapshot;
  const totals = {
    workers: data.workers.length,
    openChangeSets: data.changeSets.filter((entry) => entry.status === 'open').length,
    verificationRuns: data.verifications.length,
    failedRuns: data.verifications.filter((run) => summariseVerification(run).tone === 'error')
      .length,
  };

  return (
    <section className="v-ops" aria-label="Superagent operations">
      <header className="v-ops__head">
        <div>
          <h2 className="v-ops__title">Superagent operations</h2>
          <p className="v-ops__muted">
            The Primary Agent assigns the work; each Superagent is bounded to its own scope. This
            page reads those records and changes nothing on its own.
          </p>
        </div>
        <div className="v-ops__head-right">
          <p className="v-ops__refresh" role="status">
            {paused ? 'Auto-refresh paused' : `Refreshes every ${POLL_MS / 1000}s`} · read{' '}
            {relativeTime(new Date(data.at).toISOString())}
          </p>
          <div className="v-ops__row">
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Refresh now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPaused((value) => !value)}>
              {paused ? 'Resume refreshing' : 'Pause refreshing'}
            </Button>
          </div>
        </div>
      </header>

      {error !== null && state === 'ready' && (
        <p className="v-ops__warn" role="alert">
          The latest refresh failed, so these figures may be out of date.{' '}
          {error instanceof ApiError ? error.message : ''}
        </p>
      )}

      <section className="v-ops__section" aria-label="Fleet summary">
        <div className="v-ops__tiles">
          {WORKER_GROUP_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className={`v-ops__tile ${group === key ? 'v-ops__tile--active' : ''}`}
              onClick={() => setGroup((current) => (current === key ? 'all' : key))}
              aria-pressed={group === key}
            >
              <span className="v-ops__tile-label">{WORKER_GROUP_LABEL[key]}</span>
              <span className="v-ops__tile-value">{counts.get(key) ?? 0}</span>
              <Badge tone={workerGroupTone(key)} dot />
            </button>
          ))}
        </div>
        <p className="v-ops__muted">
          {totals.workers} Superagent {totals.workers === 1 ? 'record' : 'records'} ·{' '}
          {totals.openChangeSets} open {totals.openChangeSets === 1 ? 'change set' : 'change sets'}{' '}
          · {totals.verificationRuns} verification {totals.verificationRuns === 1 ? 'run' : 'runs'}
          {totals.failedRuns > 0 ? `, ${totals.failedRuns} failed` : ''}
        </p>
      </section>

      <section className="v-ops__section" aria-label="Superagents">
        <div className="v-ops__section-head">
          <h3>Superagents</h3>
          <div className="v-ops__filters">
            <label className="v-ops__field">
              <span className="v-ops__label">Status</span>
              <Select
                value={group}
                onChange={(event) => setGroup(event.target.value as GroupFilter)}
                aria-label="Filter by status"
                options={[
                  { value: 'all', label: 'All statuses' },
                  ...WORKER_GROUP_ORDER.map((key) => ({
                    value: key,
                    label: WORKER_GROUP_LABEL[key],
                  })),
                ]}
              />
            </label>
            <label className="v-ops__field">
              <span className="v-ops__label">Project</span>
              <Select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                aria-label="Filter by project"
                options={[
                  { value: 'all', label: 'All projects' },
                  ...projects.map((id) => ({ value: id, label: id })),
                ]}
              />
            </label>
          </div>
        </div>

        {workers.length === 0 ? (
          <EmptyState
            title={
              data.workers.length === 0 ? 'No Superagents yet' : 'No Superagents match this filter'
            }
            description={
              data.workers.length === 0
                ? 'When the Primary Agent delegates work, each Superagent appears here with its scope, progress and review state.'
                : 'Clear the filters to see the rest of the fleet.'
            }
            {...(data.workers.length === 0
              ? {}
              : {
                  action: {
                    label: 'Clear filters',
                    onClick: () => {
                      setGroup('all');
                      setProjectId('all');
                    },
                  },
                })}
          />
        ) : (
          <div className="v-ops__table-wrap">
            <table className="v-ops__table">
              <caption className="v-ops__sr">
                Superagents with their status, task and elapsed time
              </caption>
              <thead>
                <tr>
                  <th scope="col">Superagent</th>
                  <th scope="col">Objective</th>
                  <th scope="col">Status</th>
                  <th scope="col">Attempt</th>
                  <th scope="col">Elapsed</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="v-ops__sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {workers.map((worker) => {
                  const workerKey = workerGroup(worker.status);
                  return (
                    <tr
                      key={worker.id}
                      className={
                        selectedWorkerId === worker.id ? 'v-ops__row--selected' : undefined
                      }
                    >
                      <td>
                        <span className="v-ops__strong">{worker.workerType}</span>
                        <br />
                        <span className="v-ops__mono v-ops__muted">{worker.id}</span>
                      </td>
                      <td className="v-ops__objective-cell">{worker.assignment.objective}</td>
                      <td>
                        <Badge tone={workerGroupTone(workerKey)}>
                          {workerStatusLabel(worker.status)}
                        </Badge>
                      </td>
                      <td>{worker.attempts}</td>
                      <td>{formatDuration(workerDuration(worker))}</td>
                      <td>{relativeTime(worker.updatedAt)}</td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedWorkerId(worker.id)}
                          aria-label={`View details for ${worker.workerType} ${worker.id}`}
                        >
                          Details
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="v-ops__split">
        <section className="v-ops__section" aria-label="Task coordination">
          <h3>Task coordination</h3>
          {data.tasks.length === 0 ? (
            <p className="v-ops__muted">No tasks have been created yet.</p>
          ) : (
            <ul className="v-ops__tasks">
              {data.tasks.slice(0, 40).map((task) => {
                const contributors = data.workers.filter((worker) => worker.taskId === task.id);
                const reviewNeeded = contributors.some(
                  (worker) => workerGroup(worker.status) === 'awaiting_review',
                );
                return (
                  <li
                    key={task.id}
                    id={`v-ops-task-${task.id}`}
                    className={`v-ops__task ${highlightTaskId === task.id ? 'v-ops__task--highlight' : ''}`}
                  >
                    <div className="v-ops__task-head">
                      <span className="v-ops__strong">{task.title}</span>
                      <Badge tone={taskStatusTone(task.status)}>
                        {taskStatusLabel(task.status)}
                      </Badge>
                      {reviewNeeded && <Badge tone="warning">Review needed</Badge>}
                    </div>
                    <p className="v-ops__muted">{task.objective}</p>
                    {task.parentTaskId !== null && (
                      <p className="v-ops__timeline-meta">Part of {task.parentTaskId}</p>
                    )}
                    <div className="v-ops__chips">
                      {contributors.length === 0 ? (
                        <span className="v-ops__muted">No Superagents yet.</span>
                      ) : (
                        contributors.map((worker) => (
                          <button
                            key={worker.id}
                            type="button"
                            className="v-ops__chip v-ops__chip--button"
                            onClick={() => setSelectedWorkerId(worker.id)}
                          >
                            {worker.workerType}: {workerStatusLabel(worker.status)}
                          </button>
                        ))
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="v-ops__section" aria-label="Change sets">
          <h3>Change sets</h3>
          {data.changeSets.length === 0 ? (
            <p className="v-ops__muted">
              No worker has proposed changes to a project yet. Worker writes are staged and only
              reach a project after an approval.
            </p>
          ) : (
            <ul className="v-ops__tasks">
              {data.changeSets.slice(0, 40).map((entry) => {
                const counts = { create: 0, update: 0, delete: 0 };
                for (const file of entry.files) counts[file.op] += 1;
                return (
                  <li key={entry.id} className="v-ops__task">
                    <div className="v-ops__task-head">
                      <button
                        type="button"
                        className="v-ops__link"
                        onClick={() => setSelectedChangeSetId(entry.id)}
                      >
                        {entry.title}
                      </button>
                      <Badge tone={changeSetStatusTone(entry.status)}>
                        {changeSetStatusLabel(entry.status)}
                      </Badge>
                    </div>
                    <p className="v-ops__muted">
                      {entry.files.length} {entry.files.length === 1 ? 'file' : 'files'} · added{' '}
                      {counts.create}, modified {counts.update}, deleted {counts.delete} · base
                      revision {entry.baseRevision} · {relativeTime(entry.createdAt)}
                    </p>
                    {entry.verification.status !== 'none' && (
                      <p className="v-ops__muted">
                        Verification: {entry.verification.status.replace(/_/g, ' ')}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="v-ops__section" aria-label="Verification">
        <h3>Verification</h3>
        <p className="v-ops__muted">
          What ran, what did not, and why. A run is never shown as green unless a command actually
          executed and its counts were reported.
        </p>
        {data.verifications.length === 0 ? (
          <p className="v-ops__muted">
            No verification runs yet. A Superagent can only claim a test result by running one.
          </p>
        ) : (
          <ul className="v-ops__tasks">
            {data.verifications.slice(0, 20).map((run) => {
              const summary = summariseVerification(run);
              return (
                <li key={run.id} className="v-ops__task">
                  <div className="v-ops__task-head">
                    <span className="v-ops__strong">
                      {run.requestedOperations.join(', ') || 'No operations'}
                    </span>
                    <Badge tone={summary.tone}>{run.status.replace(/_/g, ' ')}</Badge>
                    {!summary.executed && <Badge tone="warning">Nothing ran</Badge>}
                  </div>
                  <p className="v-ops__muted">{summary.headline}</p>
                  <p className="v-ops__timeline-meta">
                    {run.workerId === null ? 'No worker' : `Worker ${run.workerId}`} · revision{' '}
                    {run.revision ?? 'none pinned'} · {relativeTime(run.startedAt)}
                  </p>
                  {run.results.length > 0 && (
                    <ul className="v-ops__list">
                      {run.results.map((result) => (
                        <li key={`${run.id}-${result.commandId}`}>
                          <span className="v-ops__mono">{result.commandId}</span> · exit{' '}
                          {result.exitCode === null ? '—' : result.exitCode} ·{' '}
                          {formatDuration(result.durationMs)}
                          {result.errorSummary !== null && (
                            <span className="v-ops__error"> · {result.errorSummary}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {run.blocked.length > 0 && (
                    <p className="v-ops__warn">
                      Refused:{' '}
                      {run.blocked
                        .map((item) => `${item.operation} (${item.reason.replace(/_/g, ' ')})`)
                        .join(', ')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="v-ops__split">
        <section className="v-ops__section" aria-label="Integration history">
          <h3>Integration history</h3>
          {data.records.length === 0 ? (
            <p className="v-ops__muted">Nothing has been integrated yet.</p>
          ) : (
            <ul className="v-ops__tasks">
              {data.records.slice(0, 20).map((record) => (
                <li key={record.id} className="v-ops__task">
                  <div className="v-ops__task-head">
                    <span className="v-ops__strong">
                      {record.changeSetIds.length} change set(s)
                    </span>
                    <Badge
                      tone={
                        record.status === 'completed'
                          ? 'success'
                          : record.status === 'failed'
                            ? 'error'
                            : record.rolledBackAt != null
                              ? 'warning'
                              : 'info'
                      }
                    >
                      {record.rolledBackAt != null
                        ? 'rolled back'
                        : record.status.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  <p className="v-ops__muted">
                    Revision {record.revisionBefore}
                    {record.revisionAfter === null ? '' : ` → ${record.revisionAfter}`} ·{' '}
                    {record.applied.length} {record.applied.length === 1 ? 'file' : 'files'} applied
                    · {relativeTime(record.createdAt)}
                  </p>
                  {record.failure !== null && (
                    <p className="v-ops__error">
                      {record.failure.code}: {record.failure.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="v-ops__section" aria-label="Scheduling decisions">
          <h3>Scheduling decisions</h3>
          <p className="v-ops__muted">Why the scheduler ran what it ran, and what it held back.</p>
          {data.decisions.length === 0 ? (
            <p className="v-ops__muted">The scheduler has not made a decision yet.</p>
          ) : (
            <ul className="v-ops__tasks">
              {data.decisions.slice(0, 10).map((decision) => (
                <li key={decision.id} className="v-ops__task">
                  <div className="v-ops__task-head">
                    <span className="v-ops__strong">
                      {decision.selected.length} started, {decision.skipped.length} held
                    </span>
                    <span className="v-ops__muted">{relativeTime(decision.at)}</span>
                  </div>
                  <p className="v-ops__muted">
                    Limit {decision.limit} · {decision.active} active
                  </p>
                  {decision.skipped.length > 0 && (
                    <ul className="v-ops__list">
                      {decision.skipped.map((item) => (
                        <li key={`${decision.id}-${item.workerId}`}>
                          <span className="v-ops__mono">{item.workerId}</span> · {item.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ExecutionPanel onChanged={() => void refresh({ silent: true })} />

      <RecoveryPanel
        cases={data.recovery}
        overview={data.recoveryOverview}
        filters={recoveryFilters}
        onFiltersChange={setRecoveryFilters}
        tasks={data.tasks}
        workers={data.workers}
        projects={projects}
        readAt={data.at}
        onRefresh={() => void refresh({ silent: true })}
        onChanged={onChanged}
        onNotifyFailed={onNotifyFailed}
        onOpenTask={(taskId) => {
          setHighlightTaskId(taskId);
          if (typeof document !== 'undefined') {
            const row = document.getElementById(`v-ops-task-${taskId}`);
            row?.scrollIntoView?.({ block: 'center' });
          }
        }}
        onOpenWorker={(workerId) => setSelectedWorkerId(workerId)}
        onOpenChangeSet={(changeSetId) => setSelectedChangeSetId(changeSetId)}
      />

      <ReliabilityPanel onChanged={() => void refresh({ silent: true })} />
      {/* Step 52: metering, below the machinery it measures. */}
      <UsagePanel />

      {/* Step 53: credits, what they were spent on, and the rate table. */}
      <MessageCreditsPanel />
      {/* Step 56: third-party and connector work, priced apart from model work. */}
      <IntegrationCreditsPanel />
      <WalletPanel />

      {selectedWorker !== null && (
        <div className="v-ops__drawer" role="region" aria-label="Selected Superagent">
          <WorkerDetailPanel
            workerId={selectedWorker.id}
            onChanged={onWorkerChanged}
            onClose={() => setSelectedWorkerId(null)}
          />
        </div>
      )}

      {selectedChangeSet !== null && (
        <div className="v-ops__drawer" role="region" aria-label="Selected change set">
          <ChangeSetReview
            changeSet={selectedChangeSet}
            records={data.records}
            onChanged={onChanged}
            onNotifyFailed={onNotifyFailed}
          />
          <Button variant="ghost" size="sm" onClick={() => setSelectedChangeSetId(null)}>
            Close
          </Button>
        </div>
      )}
    </section>
  );
}
