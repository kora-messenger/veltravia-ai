import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Badge, Button, ErrorState, Input, Select, Spinner } from '../../components/ui';
import { errorMessage } from '../../api/client';
import {
  adjustAllocation,
  createAllocation,
  getAllocationHistory,
  getAllocations,
  getAccountActivity,
  setAllocationPool,
  type AccountActivityEntry,
  type AllocationEventView,
  type AllocationSummary,
  type AllocationTargetKind,
  type AllocationView,
  type CreditCategory,
} from '../../api/allocations';
import './allocation.css';

/**
 * Workspace credit allocation (Step 62).
 *
 * Four rules shape what this screen draws, and each one exists because the
 * obvious alternative would be misleading:
 *
 *  1. **An allocation is a ceiling, not a balance.** The wallet still holds the
 *     credit; this page shows what each target is allowed to draw from the
 *     workspace pool. Nothing here creates credit out of nothing, and the page
 *     says so in words rather than in a tooltip.
 *  2. **Two lanes, never merged.** AI token credits and integration credits are
 *     drawn side by side and are never added together, because spending one must
 *     never silently consume the other.
 *  3. **Unset is a real state.** A workspace that never set a pool is shown as
 *     having no pool, not as a pool of zero: those mean different things.
 *  4. **The assistant is audited here.** The activity list is the same trail the
 *     account agent writes, so "what did it do" is answered by records, not by a
 *     log line somebody has to trust.
 */

export interface AllocationPanelDeps {
  readonly load?: (workspaceId: string) => Promise<AllocationSummary>;
  readonly history?: (workspaceId: string) => Promise<{ events: readonly AllocationEventView[] }>;
  readonly activity?: () => Promise<{ entries: readonly AccountActivityEntry[] }>;
  readonly setPool?: typeof setAllocationPool;
  readonly create?: typeof createAllocation;
  readonly adjust?: typeof adjustAllocation;
}

export interface AllocationPanelProps {
  /** The workspace in view. Without one the panel explains what it needs. */
  readonly workspaceId?: string | null;
  readonly deps?: AllocationPanelDeps;
}

type LoadState = 'loading' | 'ready' | 'error';

const CATEGORY_LABEL: Record<CreditCategory, string> = {
  ai_tokens: 'AI token credits',
  integration_credits: 'Integration credits',
};

const TARGET_LABEL: Record<AllocationTargetKind, string> = {
  member: 'Member',
  project: 'Project',
  agent: 'Agent',
  environment: 'Environment',
};

const TARGET_OPTIONS = (Object.keys(TARGET_LABEL) as AllocationTargetKind[]).map((value) => ({
  value,
  label: TARGET_LABEL[value],
}));

const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABEL) as CreditCategory[]).map((value) => ({
  value,
  label: CATEGORY_LABEL[value],
}));

const format = (value: number): string =>
  Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '0';

export function AllocationPanel({ workspaceId, deps }: AllocationPanelProps): ReactElement {
  const load = deps?.load ?? getAllocations;
  const loadHistory = deps?.history ?? ((id: string) => getAllocationHistory(id, 10));
  const loadActivity = deps?.activity ?? (() => getAccountActivity(15));
  const savePool = deps?.setPool ?? setAllocationPool;
  const addAllocation = deps?.create ?? createAllocation;
  const adjust = deps?.adjust ?? adjustAllocation;

  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AllocationSummary | null>(null);
  const [events, setEvents] = useState<readonly AllocationEventView[]>([]);
  const [activity, setActivity] = useState<readonly AccountActivityEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [poolTotal, setPoolTotal] = useState('');
  const [poolCategory, setPoolCategory] = useState<CreditCategory>('ai_tokens');
  const [targetKind, setTargetKind] = useState<AllocationTargetKind>('project');
  const [targetRef, setTargetRef] = useState('');
  const [amount, setAmount] = useState('');
  const [formCategory, setFormCategory] = useState<CreditCategory>('ai_tokens');

  const refresh = useCallback(async (): Promise<void> => {
    if (workspaceId === null || workspaceId === undefined) {
      setState('ready');
      return;
    }
    setState('loading');
    setError(null);
    try {
      const [next, history, trail] = await Promise.all([
        load(workspaceId),
        loadHistory(workspaceId).catch(() => ({ events: [] as readonly AllocationEventView[] })),
        loadActivity().catch(() => ({ entries: [] as readonly AccountActivityEntry[] })),
      ]);
      setSummary(next);
      setEvents(history.events);
      setActivity(trail.entries);
      setState('ready');
    } catch (caught) {
      setError(errorMessage(caught));
      setState('error');
    }
  }, [workspaceId, load, loadHistory, loadActivity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const categories = summary?.categories ?? [];
  const ai = useMemo(
    () => categories.find((entry) => entry.category === 'ai_tokens') ?? null,
    [categories],
  );
  const integration = useMemo(
    () => categories.find((entry) => entry.category === 'integration_credits') ?? null,
    [categories],
  );

  const runWrite = async (work: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      await refresh();
    } catch (caught) {
      // A refusal is shown where the action was taken, not as a page error: the
      // page is still readable and the numbers on it are still true.
      setNotice(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (workspaceId === null || workspaceId === undefined) {
    return (
      <section className="v-alloc" aria-labelledby="v-alloc-title">
        <header className="v-alloc__head">
          <h3 id="v-alloc-title">Credit allocation</h3>
        </header>
        <p className="v-alloc__note">
          Choose a workspace to see what it has set aside. An allocation is a ceiling over the
          workspace balance, so nothing here creates credit.
        </p>
      </section>
    );
  }

  return (
    <section className="v-alloc" aria-labelledby="v-alloc-title">
      <header className="v-alloc__head">
        <h3 id="v-alloc-title">Credit allocation</h3>
        <p className="v-alloc__note">
          A ceiling over this workspace&apos;s balance, per target. The wallet still holds the
          credit, and the two lanes are never combined.
        </p>
      </header>

      {state === 'loading' ? (
        <p className="v-alloc__state" role="status">
          <Spinner /> Reading this workspace&apos;s allocations…
        </p>
      ) : null}

      {state === 'error' ? (
        <ErrorState
          title="Allocations could not be read"
          description={error ?? 'The server did not answer.'}
          retry={{ label: 'Try again', onClick: () => void refresh() }}
        />
      ) : null}

      {state === 'ready' ? (
        <>
          <div className="v-alloc__lanes">
            {[ai, integration].map((lane, index) => {
              const category = index === 0 ? 'ai_tokens' : 'integration_credits';
              return (
                <article key={category} className="v-alloc__lane">
                  <h4>{CATEGORY_LABEL[category]}</h4>
                  {lane === null || !lane.pool.set ? (
                    <p className="v-alloc__empty">
                      No pool is set for this lane, so credit is checked against the workspace
                      balance only.
                    </p>
                  ) : (
                    <>
                      <dl className="v-alloc__figures">
                        <div>
                          <dt>Pool</dt>
                          <dd>{format(lane.pool.total)}</dd>
                        </div>
                        <div>
                          <dt>Allocated</dt>
                          <dd>{format(lane.pool.allocated)}</dd>
                        </div>
                        <div>
                          <dt>Unallocated</dt>
                          <dd>{format(lane.pool.available)}</dd>
                        </div>
                        <div>
                          <dt>Spent</dt>
                          <dd>{format(lane.totals.consumed)}</dd>
                        </div>
                      </dl>
                      {lane.allocations.length === 0 ? (
                        <p className="v-alloc__empty">
                          Nothing is allocated yet, so every run draws on the pool as a whole.
                        </p>
                      ) : (
                        <ul className="v-alloc__list">
                          {lane.allocations.map((entry) => (
                            <AllocationRow
                              key={entry.id}
                              allocation={entry}
                              busy={busy}
                              onAdjust={(action, value) =>
                                void runWrite(
                                  () =>
                                    adjust({
                                      allocationId: entry.id,
                                      action,
                                      ...(value === undefined ? {} : { amount: value }),
                                    }),
                                  `Updated ${TARGET_LABEL[entry.targetKind].toLowerCase()} ${entry.targetRef}.`,
                                )
                              }
                            />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>

          <div className="v-alloc__forms">
            <form
              className="v-alloc__form"
              onSubmit={(event) => {
                event.preventDefault();
                const total = Number(poolTotal);
                if (!Number.isFinite(total) || total < 0) {
                  setNotice('Enter a pool size of zero or more.');
                  return;
                }
                void runWrite(
                  () => savePool({ workspaceId, category: poolCategory, total }),
                  'Pool saved.',
                );
                setPoolTotal('');
              }}
            >
              <h4>Set a pool</h4>
              <Select
                label="Lane"
                value={poolCategory}
                options={CATEGORY_OPTIONS}
                onChange={(event) => setPoolCategory(event.target.value as CreditCategory)}
              />
              <Input
                label="Pool size"
                inputMode="numeric"
                value={poolTotal}
                onChange={(event) => setPoolTotal(event.target.value)}
                placeholder="5000"
              />
              <Button type="submit" disabled={busy}>
                Save pool
              </Button>
            </form>

            <form
              className="v-alloc__form"
              onSubmit={(event) => {
                event.preventDefault();
                const value = Number(amount);
                if (targetRef.trim().length === 0) {
                  setNotice('Name the target this allowance is for.');
                  return;
                }
                if (!Number.isFinite(value) || value <= 0) {
                  setNotice('Enter an amount greater than zero.');
                  return;
                }
                void runWrite(
                  () =>
                    addAllocation({
                      workspaceId,
                      category: formCategory,
                      targetKind,
                      targetRef: targetRef.trim(),
                      amount: value,
                    }),
                  'Allocation created.',
                );
                setTargetRef('');
                setAmount('');
              }}
            >
              <h4>Allocate credit</h4>
              <Select
                label="Lane"
                value={formCategory}
                options={CATEGORY_OPTIONS}
                onChange={(event) => setFormCategory(event.target.value as CreditCategory)}
              />
              <Select
                label="Target"
                value={targetKind}
                options={TARGET_OPTIONS}
                onChange={(event) => setTargetKind(event.target.value as AllocationTargetKind)}
              />
              <Input
                label="Target reference"
                value={targetRef}
                onChange={(event) => setTargetRef(event.target.value)}
                placeholder="Project id, member email, agent name"
              />
              <Input
                label="Amount"
                inputMode="numeric"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="1000"
              />
              <Button type="submit" disabled={busy}>
                Allocate
              </Button>
            </form>
          </div>

          {notice === null ? null : (
            <p className="v-alloc__notice" role="status">
              {notice}
            </p>
          )}

          <div className="v-alloc__trail">
            <div>
              <h4>Movements</h4>
              {events.length === 0 ? (
                <p className="v-alloc__empty">No movements recorded yet.</p>
              ) : (
                <ul className="v-alloc__events">
                  {events.slice(0, 8).map((event) => (
                    <li key={event.id}>
                      <span className="v-alloc__event-kind">{event.kind.replace(/_/g, ' ')}</span>
                      <span>{format(event.amount)}</span>
                      <span className="v-alloc__event-when">
                        {new Date(event.at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h4>What the assistant did</h4>
              {activity.length === 0 ? (
                <p className="v-alloc__empty">
                  The assistant has not performed any account actions yet.
                </p>
              ) : (
                <ul className="v-alloc__events">
                  {activity.slice(0, 8).map((entry) => (
                    <li key={entry.id}>
                      <Badge tone={entry.status === 'executed' ? 'success' : 'neutral'}>
                        {entry.status.replace(/_/g, ' ')}
                      </Badge>
                      <span>{entry.resultSummary || entry.tool}</span>
                      <span className="v-alloc__event-when">
                        {new Date(entry.occurredAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function AllocationRow({
  allocation,
  busy,
  onAdjust,
}: {
  allocation: AllocationView;
  busy: boolean;
  onAdjust: (action: 'reduce' | 'reclaim' | 'revoke', amount?: number) => void;
}): ReactElement {
  return (
    <li className="v-alloc__row" data-state={allocation.state}>
      <div className="v-alloc__row-head">
        <span className="v-alloc__target">{allocation.targetRef}</span>
        <span className="v-alloc__kind">{TARGET_LABEL[allocation.targetKind]}</span>
        {allocation.state === 'active' ? null : <Badge tone="warning">{allocation.state}</Badge>}
      </div>
      <div className="v-alloc__row-figures">
        <span>{format(allocation.allocated)} allocated</span>
        <span>{format(allocation.available)} available</span>
        <span>{format(allocation.consumed)} spent</span>
        {allocation.reserved > 0 ? <span>{format(allocation.reserved)} held</span> : null}
      </div>
      {allocation.state === 'active' ? (
        <div className="v-alloc__row-actions">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onAdjust('reclaim')}
            aria-label={`Reclaim unspent credit from ${allocation.targetRef}`}
          >
            Reclaim
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onAdjust('revoke')}
            aria-label={`Revoke the allocation for ${allocation.targetRef}`}
          >
            Revoke
          </Button>
        </div>
      ) : null}
    </li>
  );
}
