import { useCallback, useEffect, useState } from 'react';

import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import {
  cancelExecution,
  dispatchExecution,
  getExecution,
  listExecutions,
  reviewExecutionTask,
  syncExecution,
  type DeliveryReportView,
  type ExecutionSummaryView,
  type ExecutionView,
  type ProgressState,
} from '../../api/executions';
import { relativeTime } from './status';

/**
 * The execution panel (Step 50).
 *
 * One natural-language request, its plan and its real progress, over the routes
 * the coordinator already exposes. Nothing here decides anything: dispatch asks
 * the coordinator to start what its plan says is ready, sync reconciles against
 * stored records, and review goes through the worker engine's own gate.
 *
 * Progress is reported as the server computed it. Work waiting for the owner
 * reads as "needs review", never as done, and a task with no stored passing
 * verification run says so instead of implying a proof.
 */

const STATE_LABEL: Record<ProgressState, string> = {
  ready: 'Ready',
  running: 'Running',
  review: 'Needs review',
  done: 'Done',
  waiting: 'Waiting',
  blocked: 'Blocked',
  failed: 'Failed',
};

const STATE_TONE: Record<ProgressState, BadgeTone> = {
  ready: 'info',
  running: 'primary',
  review: 'warning',
  done: 'success',
  waiting: 'neutral',
  blocked: 'warning',
  failed: 'error',
};

/** Execution statuses carry their own tone; anything new reads neutral. */
const EXECUTION_TONE: Record<string, BadgeTone> = {
  intake: 'info',
  planning: 'info',
  awaiting_approval: 'warning',
  executing: 'primary',
  verifying: 'primary',
  awaiting_review: 'warning',
  integrating: 'primary',
  recovering: 'warning',
  completed: 'success',
  partially_completed: 'warning',
  blocked: 'warning',
  failed: 'error',
  cancelled: 'neutral',
};

export interface ExecutionPanelProps {
  /** Called after any control succeeds, so the page can re-read its records. */
  readonly onChanged: () => void;
}

export function ExecutionPanel({ onChanged }: ExecutionPanelProps) {
  const [summaries, setSummaries] = useState<readonly ExecutionSummaryView[] | null>(null);
  const [selected, setSelected] = useState<(ExecutionView & { report: DeliveryReportView }) | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listExecutions({ limit: 20 });
      setSummaries(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause);
      setSummaries([]);
      return [];
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(async (executionId: string) => {
    try {
      setSelected(await getExecution(executionId));
    } catch (cause) {
      setError(cause);
    }
  }, []);

  const act = useCallback(
    async (executionId: string, label: string, run: () => Promise<ExecutionView>) => {
      setBusy(`${executionId}:${label}`);
      try {
        await run();
        await open(executionId);
        await load();
        onChanged();
      } catch (cause) {
        setError(cause);
      } finally {
        setBusy(null);
      }
    },
    [load, onChanged, open],
  );

  if (error !== null) {
    return (
      <section className="v-ops__region" aria-label="Executions">
        <h2 className="v-ops__region-title">Executions</h2>
        <p className="v-ops__muted">
          The execution records could not be read. Nothing was started or changed.
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </section>
    );
  }

  if (summaries === null) {
    return (
      <section className="v-ops__region" aria-label="Executions">
        <h2 className="v-ops__region-title">Executions</h2>
        <p className="v-ops__muted">Reading executions…</p>
      </section>
    );
  }

  return (
    <section className="v-ops__region" aria-label="Executions">
      <h2 className="v-ops__region-title">Executions</h2>
      {summaries.length === 0 ? (
        <p className="v-ops__muted">
          No execution has been started yet. Ask for something to be built from the chat and its
          plan appears here with the progress the server has evidence for.
        </p>
      ) : (
        <ul className="v-ops__tasks">
          {summaries.map((execution) => (
            <li key={execution.id} className="v-ops__task">
              <div className="v-ops__task-head">
                <button
                  type="button"
                  className="v-ops__link"
                  onClick={() => void open(execution.id)}
                  aria-label={`Open execution ${execution.id}`}
                >
                  {execution.objective.slice(0, 90)}
                </button>
                <Badge tone={EXECUTION_TONE[execution.status] ?? 'neutral'}>
                  {execution.status.replace(/_/g, ' ')}
                </Badge>
              </div>
              <p className="v-ops__muted">
                {execution.taskIds.length} tasks · {execution.workerIds.length} workers · updated{' '}
                {relativeTime(execution.updatedAt)}
              </p>
              {execution.stoppedReason !== null && (
                <p className="v-ops__muted">{execution.stoppedReason}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {selected !== null && (
        <div className="v-ops__execution" role="region" aria-label="Execution detail">
          <div className="v-ops__task-head">
            <span className="v-ops__strong">{selected.plan.objective}</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>

          <ul className="v-ops__list">
            {selected.plan.tasks.map((task, index) => {
              const line = selected.progress.tasks[index];
              const state: ProgressState = line?.status ?? 'waiting';
              return (
                <li key={task.key}>
                  <span className="v-ops__strong">{task.title}</span>{' '}
                  <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
                  <span className="v-ops__muted">
                    {' '}
                    · {task.workerType} · proves: {task.verification}
                    {task.approval === null ? '' : ` · needs approval: ${task.approval}`}
                  </span>
                  {line?.note != null && <p className="v-ops__muted">{line.note}</p>}
                  {task.taskId !== null && state === 'review' && (
                    <div className="v-ops__actions">
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(selected.execution.id, `accept-${task.key}`, () =>
                            reviewExecutionTask(selected.execution.id, task.taskId!, 'accept'),
                          )
                        }
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(selected.execution.id, `reject-${task.key}`, () =>
                            reviewExecutionTask(
                              selected.execution.id,
                              task.taskId!,
                              'reject',
                              'The owner rejected this work.',
                            ),
                          )
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="v-ops__actions">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void act(selected.execution.id, 'dispatch', () =>
                  dispatchExecution(selected.execution.id),
                )
              }
            >
              Start ready tasks
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() =>
                void act(selected.execution.id, 'sync', () => syncExecution(selected.execution.id))
              }
            >
              Reconcile progress
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void act(selected.execution.id, 'cancel', () =>
                  cancelExecution(selected.execution.id),
                )
              }
            >
              Cancel execution
            </Button>
          </div>

          <div className="v-ops__report" aria-label="Delivery report">
            <p className="v-ops__strong">
              {selected.report.outcome.replace(/_/g, ' ')} · {selected.report.completed.length}{' '}
              delivered, {selected.report.notStarted.length} not started
            </p>
            {selected.report.completed.length > 0 && (
              <ul className="v-ops__list">
                {selected.report.completed.map((title, index) => (
                  <li key={`done-${index}`}>{title}</li>
                ))}
              </ul>
            )}
            {selected.report.blocked.length > 0 && (
              <ul className="v-ops__list">
                {selected.report.blocked.map((title, index) => (
                  <li key={`blocked-${index}`}>Blocked: {title}</li>
                ))}
              </ul>
            )}
            {selected.report.verification.length === 0 && (
              <p className="v-ops__muted">
                No stored verification run covers this execution yet, so nothing here is presented
                as proven.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
