import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, Button, ErrorState, Input, Select, Spinner } from '../../components/ui';
import { ApiError, errorMessage } from '../../api/client';
import {
  getSpendingLimits,
  resetSpendingPolicy,
  saveSpendingPolicy,
  type LimitMode,
  type LimitPeriod,
  type LimitRuleDraft,
  type LimitRuleTarget,
  type SpendingLimitsOverview,
} from '../../api/spending-limits';
import './spending-limits.css';

/**
 * Spending limits (Step 59).
 *
 * Bounds, not a balance. This panel sets what the platform will refuse; the
 * wallet still says what is left, and neither is derived from the other. Four
 * rules shape what is drawn:
 *
 *  1. No limit is the default and is said plainly. An account that never set one
 *     is not shown a made-up ceiling.
 *  2. A limit counts credit that is held. The row shows committed and held
 *     together because that is the number that decides a refusal.
 *  3. Soft and hard are different promises: one warns, the other refuses. The
 *     mode is printed, not implied by colour.
 *  4. A stale write is refused, not forced. When somebody else changed the
 *     policy first, the panel reloads and says so rather than overwriting.
 */

const TARGETS: readonly { value: LimitRuleTarget; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'ai_messages', label: 'Chat and messages' },
  { value: 'coding', label: 'Coding agent' },
  { value: 'agents', label: 'Agents and delegation' },
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'tools', label: 'Tool calls' },
  { value: 'background', label: 'Background work' },
  { value: 'integrations', label: 'Integrations' },
  { value: 'infrastructure', label: 'Infrastructure' },
];

const PERIODS: readonly { value: LimitPeriod; label: string }[] = [
  { value: 'daily', label: 'per day' },
  { value: 'weekly', label: 'per week' },
  { value: 'monthly', label: 'per month' },
];

const MODES: readonly { value: LimitMode; label: string }[] = [
  { value: 'hard', label: 'Refuse' },
  { value: 'soft', label: 'Warn only' },
];

const DEFAULTS = {
  target: 'all' as LimitRuleTarget,
  period: 'monthly' as LimitPeriod,
  mode: 'hard' as LimitMode,
};

function credits(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${rounded === 1 ? 'credit' : 'credits'}`;
}

function targetLabel(target: LimitRuleTarget): string {
  return TARGETS.find((entry) => entry.value === target)?.label ?? target;
}

function plainDate(iso: string | null): string {
  if (iso === null) return 'no reset';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'no reset';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface SpendingLimitsPanelDeps {
  readonly load?: () => Promise<SpendingLimitsOverview>;
  readonly save?: typeof saveSpendingPolicy;
  readonly reset?: typeof resetSpendingPolicy;
}

export function SpendingLimitsPanel({ deps }: { deps?: SpendingLimitsPanelDeps } = {}) {
  const load = deps?.load ?? getSpendingLimits;
  const save = deps?.save ?? saveSpendingPolicy;
  const reset = deps?.reset ?? resetSpendingPolicy;

  const [overview, setOverview] = useState<SpendingLimitsOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [target, setTarget] = useState<LimitRuleTarget>(DEFAULTS.target);
  const [period, setPeriod] = useState<LimitPeriod>(DEFAULTS.period);
  const [mode, setMode] = useState<LimitMode>(DEFAULTS.mode);
  const [amount, setAmount] = useState('50');
  const [warnAt, setWarnAt] = useState('80');
  const [perOperation, setPerOperation] = useState('');
  const [reservedCeiling, setReservedCeiling] = useState('');

  const refresh = useCallback(async () => {
    setState((previous) => (previous === 'ready' ? previous : 'loading'));
    try {
      const next = await load();
      setOverview(next);
      setState('ready');
      setFailure(null);
      // The ceilings are shown as they are stored, so the form never invents one.
      setPerOperation(next.perOperationLimit === null ? '' : String(next.perOperationLimit));
      setReservedCeiling(next.maxReservedCredits === null ? '' : String(next.maxReservedCredits));
    } catch (error) {
      setState('error');
      setFailure(errorMessage(error));
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const personal = useMemo(
    () => overview?.scopes.find((scope) => scope.scope === 'user')?.policy ?? null,
    [overview],
  );

  const parsedWarnAt = useMemo(() => {
    const value = Number(warnAt.trim() === '' ? '0' : warnAt);
    if (!Number.isFinite(value) || value <= 0) return [] as number[];
    // Typed as a percentage, stored as a fraction: 80 becomes 0.8.
    return [Math.min(value / 100, 0.99)];
  }, [warnAt]);

  const onSave = useCallback(async () => {
    if (overview === null) return;
    const limit = Number(amount);
    if (!Number.isFinite(limit) || limit < 0) {
      setFailure('Enter a whole number of credits. Zero is allowed and means "nothing further".');
      return;
    }
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      const rules: LimitRuleDraft[] = [
        {
          target,
          period,
          limit: Math.round(limit),
          mode,
          warnAt: parsedWarnAt,
        },
      ];
      const saved = await save({
        scope: 'user',
        rules,
        perOperationLimit: perOperation.trim() === '' ? null : Math.round(Number(perOperation)),
        maxReservedCredits:
          reservedCeiling.trim() === '' ? null : Math.round(Number(reservedCeiling)),
        expectedVersion: personal?.version ?? null,
        reason: 'Changed from the spending limits screen.',
      });
      setNotice(saved.version === 1 ? 'Limit created. It applies from now on.' : 'Limit updated.');
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') {
        // Somebody else saved first. Reload and say so; never overwrite silently.
        setNotice(
          'Somebody changed this limit first. The screen has been reloaded with their version.',
        );
        await refresh();
      } else {
        setFailure(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }, [
    amount,
    mode,
    overview,
    parsedWarnAt,
    perOperation,
    period,
    personal,
    refresh,
    reservedCeiling,
    save,
    target,
  ]);

  const onReset = useCallback(async () => {
    if (personal === null) return;
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      await reset({ scope: 'user', expectedVersion: personal.version });
      setNotice('Limit removed. Nothing is refused on spending any more.');
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') {
        setNotice('Somebody changed this limit first. The screen has been reloaded.');
        await refresh();
      } else {
        setFailure(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }, [personal, refresh, reset]);

  if (state === 'loading' && overview === null) {
    return (
      <section className="limits" aria-busy="true">
        <Spinner aria-label="Reading your spending limits" />
      </section>
    );
  }

  if (state === 'error' && overview === null) {
    return (
      <section className="limits">
        <ErrorState
          title="Your spending limits could not be read"
          description={failure ?? 'The server did not answer.'}
          retry={{ label: 'Try again', onClick: () => void refresh() }}
        />
      </section>
    );
  }

  if (overview === null) return null;

  return (
    <section className="limits">
      <header className="limits__head">
        <div>
          <h2 className="limits__title">Spending limits</h2>
          <p className="limits__note">
            {overview.enforcement === 'unconfigured'
              ? 'No limit is set, so nothing is refused on spending. Balance alone decides.'
              : overview.enforcement === 'disabled'
                ? 'Limits are recorded but not enforced right now (set by the platform operator).'
                : 'A hard limit refuses an operation before any credit is held. A soft limit only warns.'}
          </p>
        </div>
        <Badge tone={overview.enforcement === 'enforced' ? 'success' : 'neutral'}>
          {overview.enforcement === 'enforced'
            ? 'Enforced'
            : overview.enforcement === 'disabled'
              ? 'Not enforced'
              : 'No limit set'}
        </Badge>
      </header>

      {notice !== null && (
        <p className="limits__notice" role="status">
          {notice}
        </p>
      )}
      {failure !== null && (
        <p className="limits__failure" role="alert">
          {failure}
        </p>
      )}

      {overview.limits.length === 0 ? (
        <p className="limits__empty">
          Nothing is limited yet. Until you set one, an operation is refused only when the wallet
          cannot cover it.
        </p>
      ) : (
        <ul className="limits__list">
          {overview.limits.map((limit) => {
            const share = limit.limit <= 0 ? 1 : Math.min(limit.consumed / limit.limit, 1);
            return (
              <li key={limit.ruleId} className={`limits__row limits__row--${limit.state}`}>
                <div className="limits__rowHead">
                  <span className="limits__rowTitle">
                    {credits(limit.limit)} {targetLabel(limit.target)}{' '}
                    {limit.period === 'daily'
                      ? 'per day'
                      : limit.period === 'weekly'
                        ? 'per week'
                        : limit.period === 'monthly'
                          ? 'per month'
                          : 'per custom window'}
                  </span>
                  <Badge
                    tone={
                      limit.state === 'reached'
                        ? 'error'
                        : limit.state === 'warning'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {limit.state === 'reached'
                      ? 'Used up'
                      : limit.state === 'warning'
                        ? 'Nearing the limit'
                        : 'Within the limit'}
                  </Badge>
                </div>
                <div
                  className="limits__bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={limit.limit}
                  aria-valuenow={limit.consumed}
                  aria-label={`${limit.label}: ${credits(limit.consumed)} of ${credits(limit.limit)} used`}
                >
                  <span className="limits__fill" style={{ width: `${share * 100}%` }} />
                </div>
                <p className="limits__rowMeta">
                  {/* The mode is text, always: a soft limit never refuses, and a
                      reader must not have to infer that from a colour. */}
                  {credits(limit.consumed)} used, {credits(limit.remaining)} left.{' '}
                  {limit.mode === 'hard' ? 'Refuses at the limit.' : 'Warns only.'} Resets{' '}
                  {plainDate(limit.resetsAt)}.
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <dl className="limits__facts">
        <div>
          <dt>Held right now</dt>
          <dd>{credits(overview.heldCredits)}</dd>
        </div>
        <div>
          <dt>One operation may spend up to</dt>
          <dd>
            {overview.perOperationLimit === null
              ? 'no ceiling'
              : credits(overview.perOperationLimit)}
          </dd>
        </div>
        <div>
          <dt>Held at once may not exceed</dt>
          <dd>
            {overview.maxReservedCredits === null
              ? 'no ceiling'
              : credits(overview.maxReservedCredits)}
          </dd>
        </div>
        <div>
          <dt>Available balance</dt>
          <dd>{overview.wallet === null ? 'not read' : credits(overview.wallet.available)}</dd>
        </div>
      </dl>

      <form
        className="limits__form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <h3 className="limits__formTitle">
          {personal === null ? 'Set a limit' : 'Change your limit'}
        </h3>
        <div className="limits__fields">
          <label className="limits__field">
            <span>What it covers</span>
            <Select
              value={target}
              onChange={(event) => setTarget(event.target.value as LimitRuleTarget)}
              options={TARGETS}
            />
          </label>
          <label className="limits__field">
            <span>Over</span>
            <Select
              value={period}
              onChange={(event) => setPeriod(event.target.value as LimitPeriod)}
              options={PERIODS}
            />
          </label>
          <label className="limits__field">
            <span>Credits</span>
            <Input
              type="number"
              min={0}
              step={1}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-label="Credits allowed in the window"
            />
          </label>
          <label className="limits__field">
            <span>When it runs out</span>
            <Select
              value={mode}
              onChange={(event) => setMode(event.target.value as LimitMode)}
              options={MODES}
            />
          </label>
          <label className="limits__field">
            <span>Warn at (% of the limit)</span>
            <Input
              type="number"
              min={1}
              max={99}
              step={1}
              value={warnAt}
              onChange={(event) => setWarnAt(event.target.value)}
              aria-label="Warn at this percentage of the limit"
            />
          </label>
          <label className="limits__field">
            <span>One operation may spend up to</span>
            <Input
              type="number"
              min={0}
              step={1}
              value={perOperation}
              placeholder="no ceiling"
              onChange={(event) => setPerOperation(event.target.value)}
            />
          </label>
          <label className="limits__field">
            <span>Held at once, at most</span>
            <Input
              type="number"
              min={0}
              step={1}
              value={reservedCeiling}
              placeholder="no ceiling"
              onChange={(event) => setReservedCeiling(event.target.value)}
            />
          </label>
        </div>
        <div className="limits__actions">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving' : personal === null ? 'Set limit' : 'Save change'}
          </Button>
          {personal !== null && (
            <Button variant="ghost" type="button" disabled={busy} onClick={() => void onReset()}>
              Remove limit
            </Button>
          )}
        </div>
        <p className="limits__fine">
          Limits are in credits, the unit the wallet uses. They are not money, and this screen never
          converts them.
        </p>
      </form>

      {overview.events.length > 0 && (
        <div className="limits__events">
          <h3 className="limits__formTitle">Recent limit activity</h3>
          <ul>
            {overview.events.map((event) => (
              <li key={event.id} className={`limits__event limits__event--${event.kind}`}>
                <span>{event.message}</span>
                <time dateTime={event.occurredAt}>{plainDate(event.occurredAt)}</time>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
