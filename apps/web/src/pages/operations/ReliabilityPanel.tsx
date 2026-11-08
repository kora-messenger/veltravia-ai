import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, EmptyState, Spinner, useToast } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  getRecoveryDecisions,
  getReliabilityCapabilities,
  getReliabilityHealth,
  listKeyRecords,
  listSideEffects,
  runSweep,
  type KeyRecordView,
  type ReliabilityCapabilities,
  type ReliabilityHealth,
  type RecoveryDecision,
  type SideEffectView,
  type SweepResult,
} from '../../api/reliability';
import { relativeTime } from './status';

/**
 * The reliability panel (Step 51).
 *
 * What it is for: a person asking "is the machinery healthy, and what did it do
 * while I was not looking?".
 *
 * It reports only what the server stored. A durable health snapshot is a
 * database reading; the in-memory store says so in an amber finding rather than
 * letting the page imply a restart would be safe. A sweep shows what it decided
 * per execution, with the evidence it decided from, and never reports an
 * execution as finished: finishing is the review gate's business.
 */

const LEVEL_TONE = {
  ok: 'success',
  attention: 'warning',
  critical: 'error',
} as const;

const ACTION_LABEL: Record<RecoveryDecision['action'], string> = {
  resume: 'Resumed',
  recover: 'Recovering',
  await_owner: 'Needs you',
  leave: 'Left alone',
};

const ACTION_TONE: Record<RecoveryDecision['action'], 'info' | 'warning' | 'primary' | 'neutral'> =
  {
    resume: 'info',
    recover: 'primary',
    await_owner: 'warning',
    leave: 'neutral',
  };

export function ReliabilityPanel({ onChanged }: { readonly onChanged?: () => void }) {
  const { toast } = useToast();
  const [health, setHealth] = useState<ReliabilityHealth | null>(null);
  const [capabilities, setCapabilities] = useState<ReliabilityCapabilities | null>(null);
  const [decisions, setDecisions] = useState<readonly RecoveryDecision[]>([]);
  const [keys, setKeys] = useState<readonly KeyRecordView[]>([]);
  const [effects, setEffects] = useState<readonly SideEffectView[]>([]);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [nextHealth, nextCapabilities, nextDecisions, nextKeys, nextEffects] =
        await Promise.all([
          getReliabilityHealth(),
          getReliabilityCapabilities(),
          getRecoveryDecisions(),
          listKeyRecords({ status: ['in_progress', 'failed'] }),
          listSideEffects({ status: ['pending', 'failed'] }),
        ]);
      setHealth(nextHealth);
      setCapabilities(nextCapabilities);
      setDecisions(nextDecisions);
      setKeys(nextKeys);
      setEffects(nextEffects);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The reliability snapshot could not be read.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const onSweep = async () => {
    setSweeping(true);
    try {
      const result = await runSweep();
      setSweep(result);
      await load(true);
      onChanged?.();
      toast(
        result.decisions.length === 0
          ? `Nothing was interrupted. Checked ${result.examined} open execution${result.examined === 1 ? '' : 's'}.`
          : `${result.decisions.length} execution${result.decisions.length === 1 ? '' : 's'} examined. See the decisions below.`,
        { tone: result.decisions.length === 0 ? 'success' : 'info' },
      );
    } catch (caught) {
      toast(
        `The sweep could not run. ${caught instanceof ApiError ? caught.message : 'Try again in a moment.'}`,
        { tone: 'error' },
      );
    } finally {
      setSweeping(false);
    }
  };

  if (loading && health === null) {
    return (
      <section className="v-ops__panel" aria-busy="true">
        <Spinner size="sm" /> Reading reliability state…
      </section>
    );
  }

  return (
    <section className="v-ops__panel" aria-labelledby="reliability-heading">
      <header className="v-ops__panel-head">
        <div>
          <h2 id="reliability-heading">Reliability</h2>
          <p className="v-ops__muted">
            Idempotent requests, leases and interrupted work. Reads stored records only.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void onSweep()} disabled={sweeping}>
          {sweeping ? 'Sweeping…' : 'Sweep interrupted work'}
        </Button>
      </header>

      {error !== null && (
        <div className="v-ops__notice v-ops__notice--error" role="alert">
          <strong>The snapshot could not be refreshed.</strong>
          <span>{error}</span>
          <Button variant="ghost" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {health !== null && (
        <>
          <div className="v-ops__tiles">
            <Tile label="Open executions" value={health.queue.openExecutions} />
            <Tile label="Needs review" value={health.queue.awaitingReview} />
            <Tile label="Blocked workers" value={health.queue.blockedWorkers} />
            <Tile label="Expired leases" value={health.leases.expired} />
            <Tile
              label="Side effects waiting"
              value={health.events.pending + health.integration.pending}
            />
            <Tile label="Recovery open" value={health.recovery.open} />
            <Tile label="Recovery escalated" value={health.recovery.escalated} />
            <Tile
              label="Coordination store"
              value={health.durable ? 'Database' : 'Memory'}
              hint={health.durable ? undefined : 'Survives a restart'}
            />
          </div>

          {health.unavailable.length > 0 && (
            <div className="v-ops__notice v-ops__notice--error" role="status">
              <strong>Some sources could not be read.</strong>
              <span>{health.unavailable.join(', ')}. The counts below are partial.</span>
            </div>
          )}
          <ul className="v-reliability__findings">
            {health.findings.map((finding) => (
              <li key={finding.code} className="v-reliability__finding">
                <Badge tone={LEVEL_TONE[finding.level]}>{finding.level}</Badge>
                <div>
                  <p>{finding.summary}</p>
                  {finding.evidence.length > 0 && (
                    <ul className="v-reliability__evidence">
                      {finding.evidence.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {sweep !== null && (
        <div className="v-ops__subsection">
          <h3>Last sweep</h3>
          <p className="v-ops__muted">
            {sweep.examined} examined, {sweep.skipped} skipped (another process held them),{' '}
            {sweep.recoveredWorkers} worker{sweep.recoveredWorkers === 1 ? '' : 's'} recovered.
          </p>
          {sweep.decisions.length === 0 ? (
            <EmptyState
              title="Nothing needed attention"
              description="No interrupted execution was found in this pass."
            />
          ) : (
            <ul className="v-reliability__decisions">
              {sweep.decisions.map((decision) => (
                <li key={decision.executionId} className="v-reliability__decision">
                  <Badge tone={ACTION_TONE[decision.action]}>{ACTION_LABEL[decision.action]}</Badge>
                  <div>
                    <p className="v-reliability__reason">{decision.reason}</p>
                    {decision.evidence.length > 0 && (
                      <ul className="v-reliability__evidence">
                        {decision.evidence.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    )}
                    {decision.ownerAction !== null && (
                      <p className="v-reliability__action">You: {decision.ownerAction}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {decisions.length > 0 && (
        <div className="v-ops__subsection">
          <h3>Recovery decisions</h3>
          <ul className="v-reliability__decisions">
            {decisions.map((decision) => (
              <li
                key={`${decision.executionId}_${decision.reason}`}
                className="v-reliability__decision"
              >
                <Badge tone={ACTION_TONE[decision.action]}>{ACTION_LABEL[decision.action]}</Badge>
                <div>
                  <p className="v-reliability__reason">{decision.reason}</p>
                  <p className="v-ops__muted">{decision.executionId}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="v-ops__subsection">
        <h3>Keyed requests still open</h3>
        {keys.length === 0 ? (
          <EmptyState
            title="No keys in flight"
            description="Every keyed request finished, so a retry will replay a stored answer."
          />
        ) : (
          <table className="v-ops__table">
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">Key</th>
                <th scope="col">State</th>
                <th scope="col">Age</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((record) => (
                <tr key={`${record.scope}_${record.keyHint}_${record.createdAt}`}>
                  <td>{record.scope}</td>
                  <td>
                    <code>{record.keyHint}</code>
                  </td>
                  <td>
                    <Badge tone={record.status === 'failed' ? 'error' : 'warning'}>
                      {record.status === 'failed' ? 'failed' : 'running'}
                    </Badge>
                    {record.failure !== null && (
                      <p className="v-ops__muted">{record.failure.message}</p>
                    )}
                  </td>
                  <td>{relativeTime(record.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="v-ops__subsection">
        <h3>Outstanding side effects</h3>
        {effects.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description="No recorded side effect is waiting."
          />
        ) : (
          <table className="v-ops__table">
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">State</th>
                <th scope="col">Attempts</th>
                <th scope="col">Last error</th>
              </tr>
            </thead>
            <tbody>
              {effects.map((effect) => (
                <tr key={effect.eventKey}>
                  <td>{effect.topic}</td>
                  <td>
                    <Badge tone={effect.status === 'failed' ? 'error' : 'warning'}>
                      {effect.status}
                    </Badge>
                  </td>
                  <td>{effect.attempts}</td>
                  <td>{effect.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {capabilities !== null && (
        <footer className="v-ops__subsection">
          <p>
            Keys: <code>{capabilities.idempotency.header}</code>, replayed for{' '}
            {capabilities.idempotency.retentionHours}h. Leases: {capabilities.leases.ttlSeconds}s.
            Open executions per owner: {capabilities.backpressure.maxOpenExecutionsPerOwner}.
          </p>
          {capabilities.excluded.length > 0 && (
            <p className="v-ops__muted">Not promised: {capabilities.excluded.join(', ')}.</p>
          )}
        </footer>
      )}
    </section>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly hint?: string;
}) {
  return (
    <div className="v-ops__tile">
      <span className="v-ops__tile-label">{label}</span>
      <strong className="v-ops__tile-value">{value}</strong>
      {hint !== undefined && <span className="v-reliability__hint">{hint}</span>}
    </div>
  );
}
