import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Spinner } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  getUsageCapabilities,
  getUsageSnapshot,
  listUsageRecords,
  type UsageCapabilities,
  type UsageLimitView,
  type UsageRecordView,
  type UsageSnapshot,
} from '../../api/usage';

/**
 * Usage and quotas (Step 52).
 *
 * The question this panel answers is "what have I used, and what happens when I
 * hit the line?". It is built around one display rule that the server already
 * enforces: a limit is only drawn as a bar when something measured it. A limit
 * with no measurement is shown as a stated number with the reason it is not
 * enforced, because a full-looking bar over an unmeasured quantity is a lie that
 * reads as reassurance.
 *
 * Cost is shown in two columns and never added together: infrastructure belongs
 * to this platform, provider spend belongs to whoever holds the key.
 */

function formatQuantity(value: number, unit: string): string {
  if (unit === 'bytes') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Math.max(0, value);
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${index === 0 ? String(Math.round(size)) : size.toFixed(1)} ${units[index]}`;
  }
  if (unit === 'milliseconds') {
    return value >= 60_000
      ? `${(value / 60_000).toFixed(1)} min`
      : `${(value / 1000).toFixed(1)} s`;
  }
  return Math.round(value).toLocaleString('en-US');
}

function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function Tile({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly hint?: string | undefined;
}) {
  return (
    <div className="v-ops__tile">
      <span className="v-ops__tile-label">{label}</span>
      <strong className="v-ops__tile-value">{value}</strong>
      {hint !== undefined && <span className="v-usage__tile-hint">{hint}</span>}
    </div>
  );
}

/** One limit: a bar only when the number behind it was actually measured. */
function LimitRow({ limit }: { readonly limit: UsageLimitView }) {
  const measured = limit.used !== null;
  const unlimited = limit.value === null;
  const percent =
    measured && !unlimited && limit.value !== null && limit.value > 0
      ? Math.min(100, Math.round(((limit.used as number) / limit.value) * 100))
      : 0;
  const tone = !measured
    ? 'neutral'
    : percent >= 100
      ? 'error'
      : percent >= 85
        ? 'warning'
        : 'success';

  return (
    <li className="v-usage__limit">
      <div className="v-usage__limit-head">
        <span className="v-usage__limit-label">{limit.label}</span>
        <Badge tone={tone}>
          {!measured ? 'Not measured' : unlimited ? 'No limit' : `${percent}% used`}
        </Badge>
      </div>
      {measured ? (
        <>
          <div
            className="v-usage__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={unlimited ? 0 : percent}
            aria-label={`${limit.label}: ${formatQuantity(limit.used as number, limit.unit)} of ${
              unlimited ? 'no limit' : formatQuantity(limit.value as number, limit.unit)
            }`}
          >
            <div
              className="v-usage__bar-fill"
              data-tone={tone}
              style={{ width: `${unlimited ? 0 : percent}%` }}
            />
          </div>
          <p className="v-usage__limit-line">
            {formatQuantity(limit.used as number, limit.unit)} used
            {unlimited
              ? ' with no limit set'
              : ` of ${formatQuantity(limit.value as number, limit.unit)}`}
            {limit.scope !== 'plan' && (
              <span className="v-ops__muted"> · {limit.scope} override</span>
            )}
          </p>
        </>
      ) : (
        <p className="v-usage__limit-line">
          {limit.value === null
            ? 'No limit set'
            : `Limit ${formatQuantity(limit.value, limit.unit)}`}
          <span className="v-usage__unmeasured"> · nothing measures this yet</span>
        </p>
      )}
      {limit.note !== null && <p className="v-ops__muted v-usage__note">{limit.note}</p>}
    </li>
  );
}

export function UsagePanel({ projectId }: { readonly projectId?: string | null }) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<UsageCapabilities | null>(null);
  const [records, setRecords] = useState<readonly UsageRecordView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [nextSnapshot, nextCapabilities, nextRecords] = await Promise.all([
          getUsageSnapshot(projectId ?? null),
          getUsageCapabilities(),
          listUsageRecords(projectId ?? null, 15),
        ]);
        setSnapshot(nextSnapshot);
        setCapabilities(nextCapabilities);
        setRecords(nextRecords);
        setError(null);
      } catch (caught) {
        setError(
          caught instanceof ApiError ? caught.message : 'The usage snapshot could not be read.',
        );
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && snapshot === null) {
    return (
      <section className="v-ops__panel" aria-busy="true">
        <Spinner size="sm" /> Reading usage…
      </section>
    );
  }

  const counters = snapshot?.counters;
  const jobs = limitsFor(snapshot, 'backgroundJobs');
  const tokens = limitsFor(snapshot, 'providerTokens');
  const storage = limitsFor(snapshot, 'fileStorageBytes');

  return (
    <section className="v-ops__panel" aria-labelledby="usage-heading">
      <header className="v-ops__panel-head">
        <div>
          <h2 id="usage-heading">Usage and quotas</h2>
          <p className="v-ops__muted">
            Counted from what actually ran this month. Storage and open jobs are read as they are
            now, not summed over the month.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>

      {error !== null && (
        <div className="v-ops__notice v-ops__notice--error" role="alert">
          <strong>The usage snapshot could not be refreshed.</strong>
          <span>{error}</span>
          <Button variant="ghost" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {snapshot !== null && counters !== undefined && (
        <>
          <div className="v-ops__tiles">
            <Tile
              label="Jobs this month"
              value={counters.background_jobs}
              hint={jobs?.value === null || jobs === undefined ? undefined : `of ${jobs.value}`}
            />
            <Tile
              label="Backend time"
              value={formatQuantity(counters.backend_execution, 'milliseconds')}
              hint="measured wall clock"
            />
            <Tile label="Provider tokens" value={counters.ai_provider.toLocaleString('en-US')} />
            <Tile
              label="Files stored"
              value={
                snapshot.gauges.fileBytes === null
                  ? 'not measured'
                  : formatQuantity(snapshot.gauges.fileBytes, 'bytes')
              }
              hint={
                storage?.value === null || storage === undefined
                  ? undefined
                  : `of ${formatQuantity(storage.value, 'bytes')}`
              }
            />
            <Tile label="Records this month" value={snapshot.records} />
            <Tile
              label="Plan"
              value={snapshot.entitlement.label}
              hint={snapshot.entitlement.source === 'operator' ? 'set by an operator' : 'default'}
            />
          </div>

          {!snapshot.durable && (
            <div className="v-ops__notice" role="status">
              <strong>This deployment keeps usage in memory.</strong>
              <span>
                Counts reset when the server restarts, and plan or limit changes are refused rather
                than quietly forgotten.
              </span>
            </div>
          )}

          {tokens !== undefined && snapshot.counters.ai_provider > 0 && (
            <p className="v-ops__muted v-usage__line">
              {tokens.used === 0
                ? 'Provider tokens are recorded but not deducted: every call uses your own provider key, so the spend is on your provider account, not this allowance.'
                : `Provider tokens counted against the allowance: ${formatQuantity(tokens.used ?? 0, 'tokens')}.`}
            </p>
          )}

          <div className="v-usage__costs">
            <div>
              <span className="v-ops__tile-label">This platform</span>
              <strong>{formatUsd(snapshot.cost.infrastructureUsd)}</strong>
              <span className="v-ops__muted">execution, storage, jobs</span>
            </div>
            <div>
              <span className="v-ops__tile-label">Your provider account</span>
              <strong>{formatUsd(snapshot.cost.byokProviderUsd)}</strong>
              <span className="v-ops__muted">
                {snapshot.cost.unpricedCalls === 0
                  ? 'from your own keys'
                  : `${snapshot.cost.unpricedCalls} call${snapshot.cost.unpricedCalls === 1 ? '' : 's'} unpriced (no price table)`}
              </span>
            </div>
          </div>

          <h3 className="v-usage__subhead">Limits</h3>
          <ul className="v-usage__limits">
            {snapshot.limits.map((limit) => (
              <LimitRow key={limit.key} limit={limit} />
            ))}
          </ul>

          {capabilities !== null && (
            <details className="v-usage__details">
              <summary>What is measured here</summary>
              <ul className="v-usage__categories">
                {capabilities.categories.map((entry) => (
                  <li key={entry.category}>
                    <code>{entry.category}</code>
                    <Badge tone={entry.status === 'unavailable' ? 'neutral' : 'info'}>
                      {entry.status}
                    </Badge>
                    <span className="v-ops__muted">{entry.note}</span>
                  </li>
                ))}
              </ul>
              <ul className="v-usage__notes">
                {capabilities.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          )}

          <h3 className="v-usage__subhead">Recent usage</h3>
          {records.length === 0 ? (
            <p className="v-ops__muted">
              Nothing has been recorded this month. Usage appears here as work runs, not before.
            </p>
          ) : (
            <table className="v-usage__table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Paid by</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>{new Date(record.occurredAt).toLocaleTimeString()}</td>
                    <td>
                      <code>{record.operation}</code>
                      {record.providerId !== null && (
                        <span className="v-ops__muted">
                          {' '}
                          {record.providerId}
                          {record.modelId === null ? '' : ` / ${record.modelId}`}
                        </span>
                      )}
                    </td>
                    <td>{formatQuantity(record.quantity, record.unit)}</td>
                    <td>
                      {record.costBearer === null
                        ? 'this platform'
                        : record.costBearer === 'user_provider'
                          ? 'your key'
                          : 'allowance'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function limitsFor(snapshot: UsageSnapshot | null, key: string): UsageLimitView | undefined {
  return snapshot?.limits.find((limit) => limit.key === key);
}
