import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, Button, EmptyState, ErrorState, Input, Select, Spinner } from '../../components/ui';
import { errorMessage } from '../../api/client';
import {
  getUsageBreakdown,
  getUsageOverview,
  listUsageHistory,
  usageExportUrl,
  type UsageBreakdownDimension,
  type UsageBreakdownView,
  type UsageEventStatus,
  type UsageEventView,
  type UsageHistoryCategory,
  type UsageHistoryGroup,
  type UsageHistoryOverview,
  type UsageHistoryQuery,
} from '../../api/usage-history';
import './usage-history.css';

/**
 * Usage and cost (Step 58).
 *
 * One page over numbers that already existed in four separate panels. Four rules
 * shape what is drawn:
 *
 *  1. The balance is the wallet's. Available, held and spent are printed exactly
 *     as the ledger reports them; this page adds nothing up to reach a balance.
 *  2. A reservation is not a deduction. Every row says which movement it was -
 *     held, charged, released, refunded, or measured without a price - because
 *     "credits used" that mixes a hold with a charge is simply wrong.
 *  3. A partial sum says so. When the server could not read the whole window, the
 *     note beside the totals names that, instead of showing a total that looks
 *     complete.
 *  4. Credits are not money. No cash figure is derived anywhere on this page.
 */

export interface UsageHistoryDeps {
  readonly overview?: () => Promise<UsageHistoryOverview>;
  readonly history?: (
    query: UsageHistoryQuery,
  ) => Promise<Awaited<ReturnType<typeof listUsageHistory>>>;
  readonly breakdown?: (
    dimension: UsageBreakdownDimension,
    query: UsageHistoryQuery,
  ) => Promise<UsageBreakdownView>;
  /** Injected in tests so the export link is stable. */
  readonly exportUrl?: (query: UsageHistoryQuery) => string;
}

type LoadState = 'loading' | 'ready' | 'error';

const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'committed', label: 'Charged' },
  { value: 'reserved', label: 'Held' },
  { value: 'released', label: 'Released' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'exempt', label: 'Not charged' },
  { value: 'measured', label: 'Measured only' },
];

const CATEGORY_OPTIONS: readonly { value: UsageHistoryCategory | ''; label: string }[] = [
  { value: '', label: 'All categories' },
  { value: 'ai_messages', label: 'Chat' },
  { value: 'coding', label: 'Coding runs' },
  { value: 'agents', label: 'Agents' },
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'tools', label: 'Tool calls' },
  { value: 'background', label: 'Background tasks' },
  { value: 'integrations', label: 'Integrations' },
  { value: 'infrastructure', label: 'Infrastructure' },
];

const MOVEMENT_LABEL: Record<UsageEventView['movement'], string> = {
  deduction: 'Charged',
  reservation: 'Held',
  release: 'Released',
  refund: 'Refunded',
  'no-charge': 'Not charged',
  measurement: 'Measured',
};

const MOVEMENT_TONE: Record<
  UsageEventView['movement'],
  'neutral' | 'success' | 'warning' | 'error' | 'info' | 'primary'
> = {
  deduction: 'primary',
  reservation: 'warning',
  release: 'info',
  refund: 'success',
  'no-charge': 'neutral',
  measurement: 'neutral',
};

/** Credits, to two decimals, without pretending to be money. */
export function credits(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function bytes(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${Math.round(size * 10) / 10} ${units[index]}`;
}

/** A measurement in its own unit, so "1,024" never reads as credits. */
export function quantity(value: number | null, unit: string): string {
  if (value === null) return 'not measured';
  if (unit === 'bytes') return bytes(value);
  if (unit === 'milliseconds') return `${Math.round(value / 100) / 10}s`;
  return `${value.toLocaleString('en-US')} ${unit}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

interface Filters {
  readonly from: string;
  readonly to: string;
  readonly category: UsageHistoryCategory | '';
  readonly status: UsageEventStatus | '';
  readonly projectId: string;
  readonly search: string;
}

const INITIAL_FILTERS: Filters = {
  from: daysAgo(29),
  to: today(),
  category: '',
  status: '',
  projectId: '',
  search: '',
};

export function UsageHistoryPage({ deps = {} }: { deps?: UsageHistoryDeps }) {
  const loadOverview = deps.overview ?? (() => getUsageOverview());
  const loadHistory = deps.history ?? listUsageHistory;
  const loadBreakdown = deps.breakdown ?? getUsageBreakdown;
  const exportUrl = deps.exportUrl ?? usageExportUrl;

  const [overview, setOverview] = useState<UsageHistoryOverview | null>(null);
  const [draft, setDraft] = useState<Filters>(INITIAL_FILTERS);
  const [applied, setApplied] = useState<Filters>(INITIAL_FILTERS);
  const [events, setEvents] = useState<readonly UsageEventView[]>([]);
  const [byCategory, setByCategory] = useState<readonly UsageHistoryGroup[]>([]);
  const [trend, setTrend] = useState<readonly UsageHistoryGroup[]>([]);
  const [largest, setLargest] = useState<readonly UsageEventView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const queryOf = useCallback(
    (filters: Filters): UsageHistoryQuery => ({
      from: filters.from,
      to: filters.to,
      ...(filters.category === '' ? {} : { categories: [filters.category] }),
      ...(filters.status === '' ? {} : { status: [filters.status] }),
      ...(filters.projectId.trim() === '' ? {} : { projectId: filters.projectId.trim() }),
      ...(filters.search.trim() === '' ? {} : { query: filters.search.trim() }),
    }),
    [],
  );

  const load = useCallback(
    async (filters: Filters) => {
      setState('loading');
      setError(null);
      try {
        const query = queryOf(filters);
        const [nextOverview, page, categoryView, trendView] = await Promise.all([
          loadOverview(),
          loadHistory({ ...query, limit: 25 }),
          loadBreakdown('category', query),
          loadBreakdown('day', query),
        ]);
        setOverview(nextOverview);
        setEvents(page.events);
        setNextCursor(page.nextCursor);
        setTotal(page.total);
        setByCategory(categoryView.groups);
        setTrend(trendView.groups);
        setLargest(categoryView.largest);
        setPartial(
          [page.completeness, categoryView.completeness]
            .filter((flag) => !flag.complete)
            .map((flag) => flag.note)[0] ?? null,
        );
        setState('ready');
      } catch (caught) {
        setError(errorMessage(caught));
        setState('error');
      }
    },
    [loadBreakdown, loadHistory, loadOverview, queryOf],
  );

  useEffect(() => {
    void load(INITIAL_FILTERS);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (nextCursor === null) return;
    setMore(true);
    try {
      const page = await loadHistory({ ...queryOf(applied), limit: 25, cursor: nextCursor });
      setEvents((current) => [...current, ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setMore(false);
    }
  }, [applied, loadHistory, nextCursor, queryOf]);

  const apply = useCallback(() => {
    setApplied(draft);
    void load(draft);
  }, [draft, load]);

  const peak = useMemo(
    () => trend.reduce((highest, group) => Math.max(highest, group.credits), 0),
    [trend],
  );

  const header = (
    <header className="v-usage__head">
      <div>
        <h2 className="v-usage__title">Usage &amp; cost</h2>
        <p className="v-usage__lede">
          What your work used, what it cost in credits, and what is being held for work still
          running. Balances come from your credit wallet; nothing here recalculates them.
        </p>
      </div>
      <a className="v-usage__export" href={usageExportUrlFor(exportUrl, applied)} download>
        Download CSV
      </a>
    </header>
  );

  if (state === 'loading' && overview === null) {
    return (
      <section className="v-usage" aria-labelledby="v-usage-heading">
        {header}
        <p className="v-usage__loading" role="status">
          <Spinner /> Reading your usage…
        </p>
      </section>
    );
  }

  if (state === 'error' && overview === null) {
    return (
      <section className="v-usage" aria-labelledby="v-usage-heading">
        {header}
        <ErrorState
          title="Usage could not be read"
          description={error ?? 'The usage service did not answer.'}
          retry={{ label: 'Try again', onClick: () => void load(applied) }}
        />
      </section>
    );
  }

  const wallet = overview?.wallet;
  const selected = overview?.selected;
  const period = overview?.period;

  return (
    <section className="v-usage" aria-labelledby="v-usage-heading">
      <h2 id="v-usage-heading" className="v-visually-hidden">
        Usage and cost
      </h2>
      {header}

      <div className="v-usage__cards">
        <article className="v-usage__card">
          <h3>Available credits</h3>
          <p className="v-usage__figure">{credits(wallet?.available ?? 0)}</p>
          <p className="v-usage__card-note">
            {wallet?.durable === false
              ? 'Held in this instance only; a restart would not keep it.'
              : 'Your spendable balance, straight from the ledger.'}
          </p>
        </article>
        <article className="v-usage__card">
          <h3>Held for work in flight</h3>
          <p className="v-usage__figure">{credits(wallet?.reserved ?? 0)}</p>
          <p className="v-usage__card-note">
            Reserved, not spent. It returns if the work fails or is cancelled.
          </p>
        </article>
        <article className="v-usage__card">
          <h3>Spent in total</h3>
          <p className="v-usage__figure">{credits(wallet?.spent ?? 0)}</p>
          <p className="v-usage__card-note">Every settled charge on this wallet.</p>
        </article>
        <article className="v-usage__card">
          <h3>Refunded in range</h3>
          <p className="v-usage__figure">{credits(selected?.refunded ?? 0)}</p>
          <p className="v-usage__card-note">
            {overview === null
              ? ''
              : `Range ${overview.range.label}. ${overview.selected.released} hold(s) released without charge.`}
          </p>
        </article>
      </div>

      <p className="v-usage__caption">
        Credits are Veltravia&apos;s own unit. They are not a currency, and this page does not
        convert them to money.
      </p>

      <section className="v-usage__panel" aria-labelledby="v-usage-filters">
        <h3 id="v-usage-filters">Filters</h3>
        <div className="v-usage__filters">
          <Input
            label="From"
            type="date"
            value={draft.from}
            max={draft.to}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
          <Input
            label="To"
            type="date"
            value={draft.to}
            min={draft.from}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
          <Select
            label="Category"
            value={draft.category}
            options={CATEGORY_OPTIONS}
            onChange={(event) =>
              setDraft({ ...draft, category: event.target.value as UsageHistoryCategory | '' })
            }
          />
          <Select
            label="Status"
            value={draft.status}
            options={STATUS_OPTIONS}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value as UsageEventStatus | '' })
            }
          />
          <Input
            label="Project"
            placeholder="Project id"
            value={draft.projectId}
            onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
          />
          <Input
            label="Search"
            placeholder="Model, provider, charge id"
            value={draft.search}
            onChange={(event) => setDraft({ ...draft, search: event.target.value })}
          />
          <div className="v-usage__actions">
            <Button onClick={apply} disabled={state === 'loading'}>
              Apply
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(INITIAL_FILTERS);
                setApplied(INITIAL_FILTERS);
                void load(INITIAL_FILTERS);
              }}
            >
              Reset
            </Button>
          </div>
        </div>
        {partial !== null && (
          <p className="v-usage__partial" role="status">
            {partial}
          </p>
        )}
      </section>

      <div className="v-usage__grid">
        <section className="v-usage__panel" aria-labelledby="v-usage-by-category">
          <h3 id="v-usage-by-category">Usage by category</h3>
          {byCategory.length === 0 ? (
            <p className="v-usage__empty">Nothing was charged in this range.</p>
          ) : (
            <ul className="v-usage__bars">
              {byCategory.map((group) => {
                const width = `${Math.round(group.share * 100)}%`;
                return (
                  <li key={group.key} className="v-usage__bar-row">
                    <span className="v-usage__bar-label">{group.label}</span>
                    <span className="v-usage__bar-track" aria-hidden="true">
                      <span className="v-usage__bar-fill" style={{ width }} />
                    </span>
                    <span className="v-usage__bar-value">
                      {credits(group.credits)} credits
                      <span className="v-usage__bar-count"> · {group.events} records</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="v-usage__panel" aria-labelledby="v-usage-trend">
          <h3 id="v-usage-trend">Daily credits</h3>
          {peak === 0 ? (
            <p className="v-usage__empty">No credits were charged in this range.</p>
          ) : (
            <ol className="v-usage__trend" aria-label="Credits per day">
              {trend.map((group) => {
                const share = peak === 0 ? 0 : group.credits / peak;
                return (
                  <li
                    key={group.key}
                    className="v-usage__trend-day"
                    title={`${group.key}: ${credits(group.credits)} credits`}
                  >
                    <span
                      className="v-usage__trend-bar"
                      style={{ height: `${Math.max(2, Math.round(share * 100))}%` }}
                      aria-hidden="true"
                    />
                    <span className="v-usage__trend-label">{group.key.slice(5)}</span>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="v-usage__caption">
            Bars are credits charged per day. A day with no bar charged nothing.
          </p>
        </section>
      </div>

      <section className="v-usage__panel" aria-labelledby="v-usage-events">
        <div className="v-usage__panel-head">
          <h3 id="v-usage-events">History</h3>
          <span className="v-usage__count" aria-live="polite">
            {total === null ? `${events.length} shown` : `${events.length} of ${total} shown`}
          </span>
        </div>
        {state === 'error' && (
          <p className="v-usage__partial" role="alert">
            {error ?? 'That page could not be read.'}
          </p>
        )}
        {events.length === 0 ? (
          <EmptyState
            title="Nothing in this range"
            description="Widen the dates or clear the filters. Charges appear here as soon as work runs."
          />
        ) : (
          <>
            <div className="v-usage__table-wrap">
              <table className="v-usage__table">
                <caption className="v-visually-hidden">
                  Charge and measurement records, newest first
                </caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Activity</th>
                    <th scope="col">Details</th>
                    <th scope="col">Status</th>
                    <th scope="col">Credits</th>
                    <th scope="col">Project</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td data-label="When">{when(event.occurredAt)}</td>
                      <td data-label="Activity">
                        <span className="v-usage__activity">{event.activity}</span>
                        <span className="v-usage__category">{event.categoryLabel}</span>
                      </td>
                      <td data-label="Details" className="v-usage__detail">
                        {event.detail}
                        {event.limitations.length > 0 && (
                          <span className="v-usage__limitation">
                            {' '}
                            Not measured: {event.limitations.join(', ')}
                          </span>
                        )}
                      </td>
                      <td data-label="Status">
                        <Badge tone={MOVEMENT_TONE[event.movement]}>
                          {MOVEMENT_LABEL[event.movement]}
                        </Badge>
                      </td>
                      <td data-label="Credits" className="v-usage__credits">
                        {event.movement === 'measurement'
                          ? quantity(
                              event.measurement?.quantity ?? null,
                              event.measurement?.unit ?? 'units',
                            )
                          : credits(event.credits)}
                      </td>
                      <td data-label="Project">{event.projectId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nextCursor !== null && (
              <div className="v-usage__more">
                <Button variant="secondary" onClick={() => void loadMore()} disabled={more}>
                  {more ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <div className="v-usage__grid">
        <section className="v-usage__panel" aria-labelledby="v-usage-largest">
          <h3 id="v-usage-largest">Largest charges</h3>
          {largest.length === 0 ? (
            <p className="v-usage__empty">No settled charges in this range.</p>
          ) : (
            <ol className="v-usage__largest">
              {largest.map((event) => (
                <li key={event.id}>
                  <span className="v-usage__activity">{event.activity}</span>
                  <span className="v-usage__bar-value">{credits(event.credits)} credits</span>
                  <span className="v-usage__category">{when(event.occurredAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="v-usage__panel" aria-labelledby="v-usage-infra">
          <h3 id="v-usage-infra">Measured infrastructure</h3>
          <ul className="v-usage__infra">
            {(overview?.infrastructure.measured ?? []).map((entry) => (
              <li key={entry.category}>
                <span className="v-usage__activity">{entry.label}</span>
                <span className="v-usage__bar-value">{quantity(entry.quantity, entry.unit)}</span>
                <Badge tone={entry.status === 'measured' ? 'success' : 'neutral'}>
                  {entry.status === 'measured' ? 'Measured' : entry.status}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="v-usage__caption">{overview?.infrastructure.note}</p>
        </section>
      </div>

      <section className="v-usage__panel" aria-labelledby="v-usage-month">
        <h3 id="v-usage-month">This billing period</h3>
        <dl className="v-usage__figures">
          <div>
            <dt>Credits charged</dt>
            <dd>{credits(period?.credits ?? 0)}</dd>
          </div>
          <div>
            <dt>Charged records</dt>
            <dd>{period?.charges ?? 0}</dd>
          </div>
          <div>
            <dt>Held right now</dt>
            <dd>{credits(period?.openCredits ?? 0)}</dd>
          </div>
          <div>
            <dt>Input tokens</dt>
            <dd>{credits(period?.tokens.input ?? 0)}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{credits(period?.tokens.output ?? 0)}</dd>
          </div>
          <div>
            <dt>Integration charges</dt>
            <dd>{credits(period?.integration.credits ?? 0)}</dd>
          </div>
        </dl>
        <p className="v-usage__caption">
          {period?.completeness.note} {overview?.pricing.note}
        </p>
      </section>
    </section>
  );
}

/** The export link, kept separate so tests can see exactly what was asked for. */
function usageExportUrlFor(build: (query: UsageHistoryQuery) => string, filters: Filters): string {
  return build({
    from: filters.from,
    to: filters.to,
    ...(filters.category === '' ? {} : { categories: [filters.category] }),
    ...(filters.status === '' ? {} : { status: [filters.status] }),
    ...(filters.projectId.trim() === '' ? {} : { projectId: filters.projectId.trim() }),
    ...(filters.search.trim() === '' ? {} : { query: filters.search.trim() }),
  });
}
