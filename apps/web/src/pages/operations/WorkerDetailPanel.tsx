import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, Button, Dialog, Divider, EmptyState, Spinner, Textarea } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  cancelWorker,
  getWorker,
  listWorkerEvents,
  requeueWorker,
  reviewWorker,
  type ReviewOutcome,
  type WorkerEventView,
  type WorkerView,
} from '../../api/operations';
import {
  canCancel,
  canReview,
  formatDuration,
  providerLabel,
  relativeTime,
  summariseUsage,
  describeRefusal,
  workerDuration,
  workerGroup,
  workerGroupTone,
  workerStatusLabel,
} from './status';

export interface WorkerDetailPanelProps {
  readonly workerId: string;
  /** Called after any control changes the worker, so the dashboard refetches. */
  readonly onChanged: (worker: WorkerView) => void;
  readonly onClose: () => void;
}

type ReviewDecision = 'accept' | 'reject' | 'request_revision';

/**
 * One Superagent, in full.
 *
 * Everything shown comes from the worker's own record: its assignment (what it
 * was bounded to), the events the server recorded, its deliverables and the
 * evidence behind them, its usage, and its review. Secrets are not part of that
 * record, so there is nothing here to redact; what the page adds is the honest
 * "not recorded" when a value is genuinely absent.
 */
export function WorkerDetailPanel({ workerId, onChanged, onClose }: WorkerDetailPanelProps) {
  const [worker, setWorker] = useState<WorkerView | null>(null);
  const [events, setEvents] = useState<readonly WorkerEventView[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');
  const [confirm, setConfirm] = useState<'cancel' | 'reject' | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [record, history] = await Promise.all([
        getWorker(workerId),
        listWorkerEvents(workerId, 0, 100),
      ]);
      setWorker(record);
      setEvents(history);
      setError(null);
      setState('ready');
    } catch (cause) {
      setError(cause);
      setState('error');
    }
  }, [workerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (label: string, action: () => Promise<WorkerView>, done = 'Updated') => {
      setBusy(label);
      setControlError(null);
      setNotice(null);
      try {
        const updated = await action();
        setWorker(updated);
        onChanged(updated);
        const history = await listWorkerEvents(workerId, 0, 100);
        setEvents(history);
        setNotice(`${done}.`);
      } catch (cause) {
        // The server's own words: a refusal names the reason it refused.
        setControlError(
          cause instanceof ApiError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : 'That action could not be completed.',
        );
      } finally {
        setBusy(null);
      }
    },
    [onChanged, workerId],
  );

  const review = useCallback(
    async (decision: ReviewDecision) => {
      setBusy(decision);
      setControlError(null);
      setNotice(null);
      try {
        const outcome: ReviewOutcome = await reviewWorker(workerId, {
          decision,
          summary:
            rationale.trim() === ''
              ? decision === 'accept'
                ? 'Reviewed against the assignment and accepted.'
                : decision === 'reject'
                  ? 'Reviewed and rejected.'
                  : 'Revision requested.'
              : rationale.trim(),
        });
        setWorker(outcome.worker);
        onChanged(outcome.worker);
        setRationale('');
        const failed = outcome.checks.filter((check) => !check.passed);
        setNotice(
          failed.length === 0
            ? 'Review recorded.'
            : `Review recorded with ${failed.length} unmet ${failed.length === 1 ? 'check' : 'checks'}.`,
        );
        const history = await listWorkerEvents(workerId, 0, 100);
        setEvents(history);
      } catch (cause) {
        setControlError(
          cause instanceof ApiError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : 'The review could not be recorded.',
        );
      } finally {
        setBusy(null);
      }
    },
    [onChanged, rationale, workerId],
  );

  const usage = useMemo(() => summariseUsage(worker?.result?.usage), [worker]);

  if (state === 'loading' && worker === null) {
    return (
      <aside className="v-ops__panel" aria-busy="true" aria-label="Superagent detail">
        <div className="v-ops__panel-loading">
          <Spinner size="sm" />
          <span>Loading the Superagent record…</span>
        </div>
      </aside>
    );
  }

  if (state === 'error' || worker === null) {
    return (
      <aside className="v-ops__panel" aria-label="Superagent detail">
        <EmptyState
          title="This Superagent could not be loaded"
          description={
            error instanceof ApiError
              ? error.message
              : 'The record is unavailable right now. Nothing was changed.'
          }
          action={{ label: 'Try again', onClick: () => void load() }}
        />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </aside>
    );
  }

  const group = workerGroup(worker.status);
  const assignment = worker.assignment;

  return (
    <aside className="v-ops__panel" aria-label="Superagent detail">
      <header className="v-ops__panel-head">
        <div>
          <p className="v-ops__eyebrow">Superagent</p>
          <h3 className="v-ops__panel-title">{worker.workerType}</h3>
          <p className="v-ops__muted v-ops__mono">{worker.id}</p>
        </div>
        <div className="v-ops__panel-head-right">
          <Badge tone={workerGroupTone(group)}>{workerStatusLabel(worker.status)}</Badge>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close Superagent detail">
            Close
          </Button>
        </div>
      </header>

      <p className="v-ops__objective">{assignment.objective}</p>

      <dl className="v-ops__facts">
        <div>
          <dt>Task</dt>
          <dd className="v-ops__mono">{worker.taskId}</dd>
        </div>
        <div>
          <dt>Parent task</dt>
          <dd className="v-ops__mono">{worker.parentTaskId ?? '—'}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{worker.attempts}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{formatDuration(workerDuration(worker))}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{relativeTime(worker.startedAt)}</dd>
        </div>
        <div>
          <dt>Last heartbeat</dt>
          <dd>{relativeTime(worker.lastHeartbeatAt)}</dd>
        </div>
      </dl>

      <section className="v-ops__section" aria-label="Assignment boundaries">
        <h4>Assignment boundaries</h4>
        <p className="v-ops__muted">
          What this Superagent was allowed to touch. Anything outside is refused by the server, not
          by the interface.
        </p>
        <div className="v-ops__chips">
          {assignment.scope.length === 0 ? (
            <span className="v-ops__muted">No paths in scope.</span>
          ) : (
            assignment.scope.map((path) => (
              <code key={`scope-${path}`} className="v-ops__chip">
                {path}
              </code>
            ))
          )}
        </div>
        {assignment.exclusions.length > 0 && (
          <>
            <p className="v-ops__label">Excluded</p>
            <div className="v-ops__chips">
              {assignment.exclusions.map((path) => (
                <code key={`excl-${path}`} className="v-ops__chip v-ops__chip--muted">
                  {path}
                </code>
              ))}
            </div>
          </>
        )}
        <p className="v-ops__label">Allowed tools</p>
        <div className="v-ops__chips">
          {assignment.allowedTools.length === 0 ? (
            <span className="v-ops__muted">No tools were granted.</span>
          ) : (
            assignment.allowedTools.map((tool) => (
              <code key={`tool-${tool}`} className="v-ops__chip">
                {tool}
              </code>
            ))
          )}
        </div>
        <p className="v-ops__label">Limits</p>
        <ul className="v-ops__list">
          <li>{formatDuration(assignment.limits.maxDurationMs)} wall clock</li>
          <li>{assignment.limits.maxToolCalls} tool calls</li>
          <li>{assignment.limits.maxDeliverables} deliverables</li>
        </ul>
        {assignment.acceptanceCriteria.length > 0 && (
          <>
            <p className="v-ops__label">Acceptance criteria</p>
            <ul className="v-ops__list">
              {assignment.acceptanceCriteria.map((criterion, index) => (
                <li key={`${index}-${criterion}`}>{criterion}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="v-ops__section" aria-label="Deliverables and evidence">
        <h4>Deliverables and evidence</h4>
        {worker.result === null ? (
          <p className="v-ops__muted">Nothing delivered yet.</p>
        ) : (
          <>
            <p className="v-ops__muted">{worker.result.summary}</p>
            {worker.result.simulated && (
              <p className="v-ops__warn">
                This result came from a simulated executor. No model was called and no real work
                ran.
              </p>
            )}
            {worker.result.deliverables.length === 0 ? (
              <p className="v-ops__muted">No files were delivered.</p>
            ) : (
              <ul className="v-ops__list">
                {worker.result.deliverables.map((deliverable, index) => (
                  <li key={`${index}-${deliverable.name}-${deliverable.path ?? 'none'}`}>
                    <span>{deliverable.name}</span>
                    {deliverable.path !== null && (
                      <code className="v-ops__chip">{deliverable.path}</code>
                    )}
                    <span className="v-ops__muted"> {deliverable.summary}</span>
                  </li>
                ))}
              </ul>
            )}
            {worker.result.evidence.length > 0 && (
              <>
                <p className="v-ops__label">Evidence</p>
                <ul className="v-ops__list">
                  {worker.result.evidence.map((item, index) => (
                    <li key={`${index}-${item.kind}-${item.ref}`}>
                      <Badge
                        tone={
                          item.passed === true
                            ? 'success'
                            : item.passed === false
                              ? 'error'
                              : 'neutral'
                        }
                      >
                        {item.kind}
                      </Badge>{' '}
                      <span className="v-ops__mono">{item.ref}</span>{' '}
                      <span className="v-ops__muted">{item.summary}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      <section className="v-ops__section" aria-label="Usage">
        <h4>Usage</h4>
        <dl className="v-ops__facts">
          <div>
            <dt>Provider · model</dt>
            <dd>{providerLabel(worker.result?.usage)}</dd>
          </div>
          <div>
            <dt>Calls</dt>
            <dd>{usage.calls}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{usage.tokens}</dd>
          </div>
          <div>
            <dt>Provenance</dt>
            <dd>
              {usage.provenance === 'live'
                ? 'Real provider call'
                : usage.provenance === 'simulated'
                  ? 'Simulated (not billed)'
                  : 'Not recorded'}
            </dd>
          </div>
        </dl>
        <p className="v-ops__muted">
          Costs are not shown: this build records tokens and calls, not a price table.
        </p>
      </section>

      {worker.failure !== null && (
        <section className="v-ops__section" aria-label="Failure">
          <h4>Failure</h4>
          <p className="v-ops__error">
            {worker.failure.code}: {worker.failure.message}
          </p>
          <p className="v-ops__muted">
            {worker.failure.retryable ? 'Recorded as retryable.' : 'Recorded as not retryable.'}{' '}
            {relativeTime(worker.failure.at)}
          </p>
        </section>
      )}

      <section className="v-ops__section" aria-label="Review">
        <h4>Review</h4>
        {worker.review === null ? (
          <p className="v-ops__muted">
            {canReview(worker.status)
              ? 'Waiting for the Primary Agent to review this work.'
              : 'No review recorded.'}
          </p>
        ) : (
          <>
            <p>
              <Badge
                tone={
                  worker.review.decision === 'accept'
                    ? 'success'
                    : worker.review.decision === 'reject'
                      ? 'error'
                      : 'warning'
                }
              >
                {worker.review.decision === 'request_revision'
                  ? 'Revision requested'
                  : worker.review.decision === 'accept'
                    ? 'Accepted'
                    : 'Rejected'}
              </Badge>{' '}
              <span className="v-ops__muted">{relativeTime(worker.review.at)}</span>
            </p>
            <p className="v-ops__muted">{worker.review.summary}</p>
            <ul className="v-ops__list">
              {worker.review.checks.map((check, index) => (
                <li key={`${index}-${check.name}`}>
                  <Badge tone={check.passed ? 'success' : 'warning'}>
                    {check.passed ? 'met' : 'unmet'}
                  </Badge>{' '}
                  <span>{check.name}</span> <span className="v-ops__muted">{check.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {canReview(worker.status) && (
          <div className="v-ops__review">
            <Textarea
              label="Review notes"
              rows={2}
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="What the Primary Agent concluded"
            />
            <div className="v-ops__row">
              <Button
                size="sm"
                loading={busy === 'accept'}
                disabled={busy !== null && busy !== 'accept'}
                onClick={() => void review('accept')}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === 'request_revision'}
                disabled={busy !== null && busy !== 'request_revision'}
                onClick={() => void review('request_revision')}
              >
                Request revision
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={busy === 'reject'}
                disabled={busy !== null && busy !== 'reject'}
                onClick={() => setConfirm('reject')}
              >
                Reject
              </Button>
            </div>
          </div>
        )}
      </section>

      {(canCancel(worker.status) ||
        worker.status === 'failed' ||
        worker.status === 'timed_out' ||
        worker.status === 'cancelled') && (
        <section className="v-ops__section" aria-label="Controls">
          <h4>Controls</h4>
          <div className="v-ops__row">
            {canCancel(worker.status) && (
              <Button
                size="sm"
                variant="danger"
                loading={busy === 'cancel'}
                disabled={busy !== null && busy !== 'cancel'}
                onClick={() => setConfirm('cancel')}
              >
                Cancel this work
              </Button>
            )}
            {(worker.status === 'failed' ||
              worker.status === 'timed_out' ||
              worker.status === 'cancelled') && (
              <Button
                size="sm"
                variant="secondary"
                loading={busy === 'requeue'}
                disabled={busy !== null && busy !== 'requeue'}
                onClick={() =>
                  void run('requeue', () =>
                    requeueWorker(worker.id, 'Returned to the queue by the Primary Agent.'),
                  )
                }
              >
                Re-queue for a retry
              </Button>
            )}
          </div>
        </section>
      )}

      {controlError !== null && (
        <div className="v-ops__error" role="alert">
          <p>{describeRefusal(controlError).intro}</p>
          {describeRefusal(controlError).codes.length > 0 && (
            <ul className="v-ops__codes">
              {describeRefusal(controlError).codes.map((code, index) => (
                <li key={`${code}-${index}`}>{code}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice !== null && (
        <div className="v-ops__notice" role="status">
          <p>{describeRefusal(notice).intro}</p>
          {describeRefusal(notice).codes.length > 0 && (
            <ul className="v-ops__codes">
              {describeRefusal(notice).codes.map((code, index) => (
                <li key={`${code}-${index}`}>{code}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Divider />

      <section className="v-ops__section" aria-label="Execution history">
        <h4>Execution history</h4>
        <p className="v-ops__muted">
          Recorded by the server. Each row is one event the worker's own lifecycle wrote.
        </p>
        {events.length === 0 ? (
          <p className="v-ops__muted">No events recorded.</p>
        ) : (
          <ol className="v-ops__timeline">
            {[...events].reverse().map((event, index) => (
              <li key={`${index}-${event.seq}`} className="v-ops__timeline-row">
                <span className="v-ops__timeline-dot" aria-hidden="true" />
                <div>
                  <p className="v-ops__timeline-title">
                    {event.type.replace(/_/g, ' ')}
                    {event.toStatus !== null && (
                      <span className="v-ops__muted"> → {event.toStatus.replace(/_/g, ' ')}</span>
                    )}
                  </p>
                  {event.message !== null && <p className="v-ops__muted">{event.message}</p>}
                  <p className="v-ops__timeline-meta">
                    {event.actor.replace(/_/g, ' ')} · {relativeTime(event.at)} · #{event.seq}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'cancel' ? 'Cancel this work?' : 'Reject this work?'}
        description={
          confirm === 'cancel'
            ? 'The Superagent stops and its partial output is kept for review. This cannot be undone; the Primary Agent can queue the work again.'
            : 'Rejecting ends this delivery. Nothing it staged is integrated, and the Primary Agent has to plan the work again.'
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy === 'cancel' || busy === 'reject'}
              onClick={() => {
                const decision = confirm;
                setConfirm(null);
                if (decision === 'cancel') {
                  void run(
                    'cancel',
                    () => cancelWorker(worker.id, 'Cancelled from the operations dashboard.'),
                    'Cancelled',
                  );
                } else if (decision === 'reject') {
                  void review('reject');
                }
              }}
            >
              {confirm === 'cancel' ? 'Cancel the work' : 'Reject the work'}
            </Button>
          </>
        }
      >
        <p className="v-ops__muted">
          {confirm === 'cancel'
            ? 'Events recorded so far stay in the execution history.'
            : 'The review decision is recorded with your notes.'}
        </p>
      </Dialog>
    </aside>
  );
}
