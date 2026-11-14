import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, Button, Card, EmptyState, ErrorState, Spinner } from '../../components/ui';
import { errorMessage, isOffline } from '../../api/client';
import {
  cancelMySubscription,
  changeMyPlan,
  getSubscriptionOverview,
  type PlanEventView,
  type PlanView,
  type SubscriptionOverview,
  type SubscriptionStatus,
} from '../../api/subscriptions';
import './subscription-plan.css';

/**
 * Subscription and plan (Step 60).
 *
 * The rules this screen is built on, all of them about not lying:
 *
 *  1. The plan in force comes from the server as `effective.plan`. When a paid
 *     period has lapsed the server says so and names the included allowance;
 *     this page then shows that, rather than the plan the account used to have.
 *  2. An allowance is a ceiling, not a purchase. Nothing here prints a price,
 *     because no checkout exists in this build.
 *  3. A refused feature is explained in words, in the place it would have been
 *     used. A hidden button is not an explanation, and a disabled button is not
 *     the enforcement either: every protected route checks the same answer.
 *  4. Nothing on this page claims a change happened that the server did not
 *     confirm. A failed change says what failed and keeps the screen's numbers.
 */

export interface SubscriptionPlanDeps {
  readonly overview?: () => Promise<SubscriptionOverview>;
  readonly changePlan?: (
    planId: string,
    expectedVersion?: number,
  ) => Promise<{ direction: string }>;
  readonly cancel?: (reason: string) => Promise<unknown>;
}

type LoadState = 'loading' | 'ready' | 'error' | 'offline';

const STATUS_LABEL: Record<SubscriptionStatus | 'none', string> = {
  none: 'No paid plan',
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment due',
  canceled: 'Canceled',
  suspended: 'Suspended',
  expired: 'Ended',
};

const STATUS_TONE: Record<
  SubscriptionStatus | 'none',
  'neutral' | 'success' | 'warning' | 'error' | 'info'
> = {
  none: 'neutral',
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  canceled: 'neutral',
  suspended: 'error',
  expired: 'neutral',
};

/**
 * The features a plan can carry, in the order a person cares about them. A key
 * absent from a plan's entitlements is denied: the row reads "Not included"
 * rather than being left out, so nobody has to guess.
 */
const FEATURES: readonly { readonly key: string; readonly label: string; readonly note: string }[] =
  [
    {
      key: 'managedProviders',
      label: 'Managed AI models',
      note: 'Veltravia runs the model for you.',
    },
    {
      key: 'byokProviders',
      label: 'Your own provider keys',
      note: 'Bring a key and pay the provider directly.',
    },
    { key: 'codingAgent', label: 'Coding agent', note: 'Workers that write and verify code.' },
    { key: 'superagent', label: 'Superagent runs', note: 'Long, multi-step work with review.' },
    { key: 'subagents', label: 'Parallel subagents', note: 'Several workers at once.' },
    { key: 'appBuilder', label: 'App builder', note: 'Generate and run an application.' },
    { key: 'integrations', label: 'Connected integrations', note: 'GitHub, storage and the rest.' },
    { key: 'apiAccess', label: 'API access', note: 'Call Veltravia from your own code.' },
    { key: 'exportSources', label: 'Source export', note: 'Download the project as a ZIP.' },
    { key: 'collaboration', label: 'Collaboration', note: 'Work with someone else on a project.' },
    { key: 'hosting', label: 'Deployment and hosting', note: 'Publish what you built.' },
    { key: 'advancedModels', label: 'Advanced models', note: 'The larger reasoning models.' },
  ];

const QUOTA_LABEL: Readonly<Record<string, string>> = {
  databaseStorageBytes: 'Database storage',
  fileStorageBytes: 'File storage',
  bandwidthBytes: 'Bandwidth',
  backendExecutionMs: 'Backend execution time',
  backendExecutionCalls: 'Backend calls',
  backgroundJobs: 'Background jobs',
  concurrentJobs: 'Jobs at once',
  realtimeConnections: 'Realtime connections',
  providerTokens: 'Provider tokens',
};

/** Bytes as something a person can read, without pretending to more precision. */
function bytes(value: number | null): string {
  if (value === null) return 'Not stated';
  if (value === 0) return 'Not included';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function quota(key: string, value: number | null): string {
  if (value === null) return 'Not stated';
  if (value === 0) return 'Not included';
  if (key.endsWith('Bytes')) return bytes(value);
  if (key.endsWith('Ms')) {
    const minutes = value / 60_000;
    return minutes >= 1 ? `${Math.round(minutes)} min` : `${Math.round(value / 1000)} s`;
  }
  return new Intl.NumberFormat().format(value);
}

/** A plan's entitlement as a yes/no, and its ceiling when it is a number. */
function entitlementLabel(value: boolean | number | null | undefined): string {
  if (value === undefined || value === null) return 'Not included';
  if (value === true) return 'Included';
  if (value === false) return 'Not included';
  if (value === 0) return 'Not included';
  return `${new Intl.NumberFormat().format(value)} included`;
}

function dateText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function SubscriptionPlanPage({ deps = {} }: { readonly deps?: SubscriptionPlanDeps }) {
  const readOverview = deps.overview ?? getSubscriptionOverview;
  const changePlan = deps.changePlan ?? changeMyPlan;
  const cancel = deps.cancel ?? cancelMySubscription;

  const [state, setState] = useState<LoadState>('loading');
  const [overview, setOverview] = useState<SubscriptionOverview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showAllPlans, setShowAllPlans] = useState(false);
  const [showEvents, setShowEvents] = useState(false);

  const load = useCallback(async () => {
    if (isOffline()) {
      setState('offline');
      return;
    }
    setState('loading');
    try {
      setOverview(await readOverview());
      setState('ready');
    } catch (error) {
      setFailure(errorMessage(error));
      setState(isOffline() ? 'offline' : 'error');
    }
  }, [readOverview]);

  useEffect(() => {
    void load();
  }, [load]);

  const onChoose = useCallback(
    async (plan: PlanView) => {
      if (overview === null) return;
      setBusyPlan(plan.id);
      setProblem(null);
      setNotice(null);
      try {
        const result = await changePlan(plan.id, overview.subscription?.version);
        const verb = result.direction === 'downgrade' ? 'lowered' : 'changed';
        setNotice(`Your plan was ${verb} to ${plan.name}. Your projects and credits were kept.`);
        await load();
      } catch (error) {
        setProblem(errorMessage(error));
      } finally {
        setBusyPlan(null);
      }
    },
    [changePlan, load, overview],
  );

  const onCancel = useCallback(async () => {
    setProblem(null);
    setNotice(null);
    try {
      await cancel('Canceled from the plan screen');
      setNotice(
        'Your plan will not renew. It stays active until the current period ends, then the included allowance applies. Nothing is deleted.',
      );
      await load();
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }, [cancel, load]);

  const currentPlanId = overview?.effective.plan.id ?? null;
  const visiblePlans = useMemo(() => {
    const plans = overview?.plans ?? [];
    return showAllPlans ? plans : plans.slice(0, 3);
  }, [overview, showAllPlans]);

  if (state === 'loading' && overview === null) {
    return (
      <section className="plan-page" aria-busy="true">
        <Spinner aria-label="Reading your plan" />
      </section>
    );
  }

  if (state === 'offline') {
    return (
      <section className="plan-page">
        <ErrorState
          title="You are offline"
          description="Your plan is read from the service, so it cannot be shown while the device has no connection."
          retry={{ label: 'Try again', onClick: () => void load() }}
        />
      </section>
    );
  }

  if (state === 'error' || overview === null) {
    return (
      <section className="plan-page">
        <ErrorState
          title="Your plan could not be read"
          description={failure ?? 'The service did not answer. Nothing was changed.'}
          retry={{ label: 'Try again', onClick: () => void load() }}
        />
      </section>
    );
  }

  const { effective, subscription, allowances } = overview;
  const plan = effective.plan;
  /*
   * The server's reason is shown whenever it has one, including on a lapsed plan
   * where it says what happened to the data. Hiding it when the account is still
   * entitled would keep the reassuring half of the sentence to ourselves.
   */
  const reason = effective.reason;
  const canChange = overview.selfService.enabled;
  const statusKey: SubscriptionStatus | 'none' =
    subscription === null ? 'none' : effective.status === 'none' ? 'none' : effective.status;
  const statusLabel = STATUS_LABEL[statusKey];

  return (
    <section className="plan-page">
      {(notice !== null || problem !== null) && (
        <div className="plan-page__alerts" role="status" aria-live="polite">
          {notice !== null && <p className="plan-page__notice">{notice}</p>}
          {problem !== null && (
            <p className="plan-page__problem" role="alert">
              {problem}
            </p>
          )}
        </div>
      )}

      <Card
        title="Your plan"
        description={plan.description}
        raised
        actions={<Badge tone={STATUS_TONE[statusKey]}>{statusLabel}</Badge>}
      >
        <div className="plan-current">
          <div className="plan-current__name">
            <h2>{plan.name}</h2>
            <p className="plan-current__source">
              {effective.source === 'subscription'
                ? `Renews on ${dateText(subscription?.currentPeriodEnd ?? '')}`
                : effective.source === 'lapsed'
                  ? `Paid period ended ${dateText(subscription?.currentPeriodEnd ?? '')}. The included allowance applies.`
                  : effective.source === 'suspended'
                    ? 'Suspended. Paid features are held until it is lifted.'
                    : 'The included allowance. No paid plan is active on this account.'}
            </p>
            {reason !== null && <p className="plan-current__reason">{reason}</p>}
          </div>
          <dl className="plan-metrics">
            <div className="plan-metric">
              <dt>Integration credits each month</dt>
              <dd>{new Intl.NumberFormat().format(allowances.integrationCredits)}</dd>
            </div>
            <div className="plan-metric">
              <dt>Message credits each month</dt>
              <dd>{new Intl.NumberFormat().format(allowances.messageCredits)}</dd>
            </div>
            <div className="plan-metric">
              <dt>Period ends</dt>
              <dd>
                {subscription === null ? 'No paid period' : dateText(subscription.currentPeriodEnd)}
              </dd>
            </div>
          </dl>
        </div>

        {!effective.entitled && (
          <p className="plan-current__warning" role="note">
            {effective.reason ??
              'Paid features are not available while this plan is not active. Your projects, files and credits are untouched.'}
          </p>
        )}

        {subscription !== null && subscription.renews && effective.entitled && (
          <footer className="plan-current__footer">
            <Button variant="secondary" onClick={() => void onCancel()}>
              Stop renewing
            </Button>
            <span className="plan-current__hint">
              The plan runs to the end of the period. Nothing is deleted.
            </span>
          </footer>
        )}
      </Card>

      <Card
        title="What this plan includes"
        description="A feature missing from a plan is refused by the server, not just hidden here."
      >
        <ul className="plan-features">
          {FEATURES.map((feature) => {
            const value = overview.entitlements[feature.key];
            const included = value === true || (typeof value === 'number' && value > 0);
            return (
              <li key={feature.key} className="plan-feature" data-included={included}>
                <span className="plan-feature__mark" aria-hidden="true">
                  {included ? '✓' : '–'}
                </span>
                <span className="plan-feature__body">
                  <span className="plan-feature__label">{feature.label}</span>
                  <span className="plan-feature__note">
                    {included ? entitlementLabel(value) : 'Not included'} · {feature.note}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>

        <h4 className="plan-subhead">Usage ceilings</h4>
        <dl className="plan-quotas">
          {Object.entries(overview.quotas).map(([key, value]) => (
            <div key={key} className="plan-quota">
              <dt>{QUOTA_LABEL[key] ?? key}</dt>
              <dd>{quota(key, value)}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card
        title="Plans"
        description={
          canChange
            ? 'Changing plan applies the new limits straight away. Your credits and projects stay.'
            : (overview.selfService.note ?? 'Plan changes are made by an operator for now.')
        }
        actions={
          overview.plans.length > 3 ? (
            <Button variant="ghost" onClick={() => setShowAllPlans((shown) => !shown)}>
              {showAllPlans ? 'Show less' : `Show all ${overview.plans.length}`}
            </Button>
          ) : undefined
        }
      >
        {overview.plans.length === 0 ? (
          <EmptyState
            title="No plans are published"
            description="An operator has not published a plan yet. Your included allowance still applies."
          />
        ) : (
          <ul className="plan-cards">
            {visiblePlans.map((candidate) => {
              const isCurrent = candidate.id === currentPlanId;
              const busy = busyPlan === candidate.id;
              return (
                <li
                  key={candidate.id}
                  className="plan-card"
                  data-current={isCurrent}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <header className="plan-card__header">
                    <h4>{candidate.name}</h4>
                    {isCurrent && <Badge tone="primary">Current</Badge>}
                  </header>
                  <p className="plan-card__description">{candidate.description}</p>
                  <ul className="plan-card__facts">
                    <li>
                      {new Intl.NumberFormat().format(candidate.monthlyIntegrationCredits)}{' '}
                      integration credits a month
                    </li>
                    <li>
                      {new Intl.NumberFormat().format(candidate.monthlyMessageCredits)} message
                      credits a month
                    </li>
                    <li>
                      {candidate.entitlements['managedProviders'] === true
                        ? 'Managed AI models'
                        : 'Your own provider keys'}{' '}
                      ·{' '}
                      {candidate.entitlements['codingAgent'] === true
                        ? 'coding agent'
                        : 'no coding agent'}
                    </li>
                  </ul>
                  <footer className="plan-card__footer">
                    <Button
                      variant={isCurrent ? 'secondary' : 'primary'}
                      disabled={isCurrent || busy || !canChange || !candidate.active}
                      onClick={() => void onChoose(candidate)}
                    >
                      {isCurrent
                        ? 'This is your plan'
                        : busy
                          ? 'Changing'
                          : !candidate.active
                            ? 'Not available'
                            : canChange
                              ? `Move to ${candidate.name}`
                              : 'Operator only'}
                    </Button>
                    {!canChange && (
                      <span className="plan-card__hint">
                        An operator makes plan changes until checkout exists.
                      </span>
                    )}
                  </footer>
                </li>
              );
            })}
          </ul>
        )}
        <p className="plan-price-note">
          No prices are shown because there is no checkout in this build. The allowances above are
          configurable defaults, not a quote.
        </p>
      </Card>

      <Card
        title="Plan history"
        actions={
          overview.events.length > 0 ? (
            <Button variant="ghost" onClick={() => setShowEvents((shown) => !shown)}>
              {showEvents ? 'Hide' : 'Show'}
            </Button>
          ) : undefined
        }
      >
        {overview.events.length === 0 ? (
          <EmptyState
            title="Nothing has happened yet"
            description="Assignments, renewals and suspensions appear here as they happen."
          />
        ) : showEvents ? (
          <ol className="plan-events">
            {overview.events.map((event: PlanEventView) => (
              <li key={event.id} className="plan-event">
                <span className="plan-event__when">{dateText(event.occurredAt)}</span>
                <span className="plan-event__what">{event.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="plan-events__latest">Latest: {overview.events[0]?.message}</p>
        )}
      </Card>

      {!overview.durable && (
        <p className="plan-page__footnote">
          This deployment has no database attached, so the plan is remembered only for as long as
          the service runs.
        </p>
      )}
    </section>
  );
}
