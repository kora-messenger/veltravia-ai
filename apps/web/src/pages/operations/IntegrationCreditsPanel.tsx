import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Spinner } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  getIntegrationCreditIntegrity,
  getIntegrationCreditPolicy,
  getIntegrationCreditSummary,
  getIntegrationUsage,
  listIntegrationCharges,
  refundIntegrationCharge,
  updateIntegrationCreditSettings,
  type IntegrationChargeView,
  type IntegrationCreditIntegrity,
  type IntegrationCreditPolicyView,
  type IntegrationCreditSummary,
  type IntegrationUsageDimension,
  type IntegrationUsageGroupView,
} from '../../api/integration-credits';

/**
 * Integration credits (Step 56).
 *
 * Third-party work is priced differently from model work, and the panel keeps the
 * difference visible in four ways:
 *
 *  - the billing class of every row. Free, paid by Veltravia, and billed to the
 *    user's own external account are not the same thing, and a single "credits"
 *    column would merge them;
 *  - the hold. Credit is reserved before an eligible operation and settled from
 *    what was measured, so a reserved row shows what is unavailable right now;
 *  - the measurement. A row nobody measured says so instead of counting as zero;
 *  - BYOK. A call paid for with the owner's own provider key is exempt, and the
 *    row says why rather than showing a charge of nothing.
 *
 * Nothing here decides a charge; the server does, before the operation runs.
 */

const DIMENSIONS: readonly { dimension: IntegrationUsageDimension; label: string }[] = [
  { dimension: 'integration', label: 'By integration' },
  { dimension: 'connector', label: 'By connector' },
  { dimension: 'operation', label: 'By operation' },
  { dimension: 'project', label: 'By project' },
  { dimension: 'billingClass', label: 'By billing class' },
];

function credits(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not measured';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${rounded === 1 ? 'credit' : 'credits'}`;
}

function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not measured';
  return value.toLocaleString('en-GB');
}

function stamp(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function stateTone(state: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (state === 'committed') return 'success';
  if (state === 'reserved') return 'warning';
  if (state === 'failed') return 'error';
  if (state === 'refunded') return 'error';
  return 'neutral';
}

function classLabel(billingClass: string): string {
  if (billingClass === 'free') return 'Free';
  if (billingClass === 'externally-billed') return 'Billed to your account';
  return 'Paid';
}

function groupLabel(key: string, dimension: IntegrationUsageDimension): string {
  const trimmed = key.trim();
  if (trimmed === '' || trimmed === 'none') {
    return dimension === 'project' ? 'No project' : 'Unassigned';
  }
  return trimmed;
}

function unitsText(units: Readonly<Record<string, number>>): string {
  const entries = Object.entries(units);
  if (entries.length === 0) return 'none reported';
  return entries.map(([unit, amount]) => `${amount} ${unit}${amount === 1 ? '' : 's'}`).join(', ');
}

export function IntegrationCreditsPanel() {
  const [summary, setSummary] = useState<IntegrationCreditSummary | null>(null);
  const [policy, setPolicy] = useState<IntegrationCreditPolicyView | null>(null);
  const [charges, setCharges] = useState<readonly IntegrationChargeView[]>([]);
  const [groups, setGroups] = useState<readonly IntegrationUsageGroupView[]>([]);
  const [dimension, setDimension] = useState<IntegrationUsageDimension>('integration');
  const [integrity, setIntegrity] = useState<IntegrationCreditIntegrity | null>(null);
  const [stateFilter, setStateFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [monthlyLimit, setMonthlyLimit] = useState<string>('');
  const [perOperationLimit, setPerOperationLimit] = useState<string>('');
  const [savingLimits, setSavingLimits] = useState(false);
  const [limitNotice, setLimitNotice] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [refundToken, setRefundToken] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refunding, setRefunding] = useState(false);
  const [refundNotice, setRefundNotice] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, nextPolicy, page, usage, check] = await Promise.all([
        getIntegrationCreditSummary(),
        getIntegrationCreditPolicy(),
        listIntegrationCharges({
          limit: 25,
          ...(stateFilter === '' ? {} : { state: stateFilter }),
        }),
        getIntegrationUsage(dimension),
        getIntegrationCreditIntegrity(),
      ]);
      setSummary(nextSummary);
      setPolicy(nextPolicy);
      setCharges(page.charges);
      setGroups(usage.groups);
      setIntegrity(check);
      setMonthlyLimit(
        nextSummary.settings.monthlyLimit === null ? '' : String(nextSummary.settings.monthlyLimit),
      );
      setPerOperationLimit(
        nextSummary.settings.perOperationLimit === null
          ? ''
          : String(nextSummary.settings.perOperationLimit),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Integration credits could not be loaded. Nothing has been charged by this screen.',
      );
    } finally {
      setLoading(false);
    }
  }, [dimension, stateFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveLimits = useCallback(async () => {
    setSavingLimits(true);
    setLimitError(null);
    setLimitNotice(null);
    const parse = (value: string): number | null => (value.trim() === '' ? null : Number(value));
    const monthly = parse(monthlyLimit);
    const perOperation = parse(perOperationLimit);
    if (
      (monthly !== null && (!Number.isFinite(monthly) || monthly < 0)) ||
      (perOperation !== null && (!Number.isFinite(perOperation) || perOperation < 0))
    ) {
      setSavingLimits(false);
      setLimitError('A limit has to be a number of credits, or empty for no limit.');
      return;
    }
    try {
      const saved = await updateIntegrationCreditSettings({
        monthlyLimit: monthly,
        perOperationLimit: perOperation,
      });
      setLimitNotice(
        `Saved. Monthly limit: ${saved.monthlyLimit === null ? 'none' : credits(saved.monthlyLimit)}. Per operation: ${
          saved.perOperationLimit === null ? 'none' : credits(saved.perOperationLimit)
        }.`,
      );
      await load();
    } catch (caught) {
      setLimitError(
        caught instanceof ApiError ? caught.message : 'The limits were not saved. Nothing changed.',
      );
    } finally {
      setSavingLimits(false);
    }
  }, [monthlyLimit, perOperationLimit, load]);

  /*
   * A refund puts credit back into the wallet it was taken from, and the server
   * only accepts one from an operator. The token is therefore asked for here, at
   * the moment of the refund, kept in component state only and cleared as soon as
   * the request finishes: this screen must never be a place a credential lives.
   */
  const openRefund = useCallback((chargeId: string) => {
    setRefundFor(chargeId);
    setRefundToken('');
    setRefundReason('');
    setRefundError(null);
    setRefundNotice(null);
  }, []);

  const closeRefund = useCallback(() => {
    setRefundFor(null);
    setRefundToken('');
    setRefundReason('');
    setRefundError(null);
  }, []);

  const submitRefund = useCallback(
    async (charge: IntegrationChargeView) => {
      const token = refundToken.trim();
      if (token === '') {
        setRefundError('Enter the operator token to refund this charge.');
        return;
      }
      setRefunding(true);
      setRefundError(null);
      setRefundNotice(null);
      try {
        const refunded = await refundIntegrationCharge(charge.id, {
          token,
          reason: refundReason,
        });
        setRefundNotice(
          `Refunded ${credits(refunded.credits)} to the wallet. The charge is now marked refunded.`,
        );
        setRefundFor(null);
        setRefundToken('');
        setRefundReason('');
        await load();
      } catch (caught) {
        // The token is cleared on failure: a rejected token should not sit in the
        // field inviting a second attempt with the same wrong value.
        setRefundToken('');
        setRefundError(
          caught instanceof ApiError
            ? caught.message
            : 'The refund did not go through. Nothing was changed.',
        );
      } finally {
        setRefunding(false);
      }
    },
    [refundToken, refundReason, load],
  );

  if (loading && summary === null) {
    return (
      <section className="v-intcredit" aria-busy="true">
        <header className="v-intcredit__head">
          <h2>Integration credits</h2>
        </header>
        <p className="v-ops__muted">
          <Spinner /> Reading your integration-credit balance.
        </p>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section className="v-intcredit">
        <header className="v-intcredit__head">
          <h2>Integration credits</h2>
        </header>
        <div className="v-ops__error" role="alert">
          {error}
        </div>
        <Button onClick={() => void load()}>Try again</Button>
      </section>
    );
  }

  const wallet = summary?.wallet;
  const month = summary?.month;
  const refundsOn = summary?.refunds.enabled === true;
  const paidPolicies = policy?.plans.find((plan) => plan.billable)?.policies ?? [];

  return (
    <section className="v-intcredit">
      <header className="v-intcredit__head">
        <h2>Integration credits</h2>
        <p className="v-ops__muted">
          Credit is held before a billable integration operation and settled from what was measured.
          Rates are the deployment&apos;s configuration, not a market price.
        </p>
      </header>

      {wallet === undefined ? null : (
        <div className="v-intcredit__balances">
          <div className="v-intcredit__balance">
            <span className="v-intcredit__label">Available</span>
            <strong>{credits(wallet.available)}</strong>
          </div>
          <div className="v-intcredit__balance">
            <span className="v-intcredit__label">Held for operations in flight</span>
            <strong>{credits(wallet.reserved)}</strong>
          </div>
          <div className="v-intcredit__balance">
            <span className="v-intcredit__label">Spent</span>
            <strong>{credits(wallet.spent)}</strong>
          </div>
          <div className="v-intcredit__balance">
            <span className="v-intcredit__label">This month</span>
            <strong>{credits(month?.credits)}</strong>
            <span className="v-ops__muted">
              {month?.charges ?? 0} charges
              {month !== undefined && month.exempt > 0 ? `, ${month.exempt} exempt` : ''}
              {month !== undefined && month.refunded > 0
                ? `, ${credits(month.refunded)} refunded`
                : ''}
            </span>
          </div>
        </div>
      )}

      {month === undefined ? null : (
        <div className="v-intcredit__measured" data-testid="integration-measured">
          <h3>Measured this month</h3>
          <div className="v-intcredit__balances">
            <div className="v-intcredit__balance">
              <span className="v-intcredit__label">Outbound requests</span>
              <strong>{count(month.requests)}</strong>
            </div>
            <div className="v-intcredit__balance">
              <span className="v-intcredit__label">Billable units</span>
              <strong>{count(month.units)}</strong>
            </div>
            <div className="v-intcredit__balance">
              <span className="v-intcredit__label">Held, not yet settled</span>
              <strong>{credits(month.openCredits)}</strong>
              <span className="v-ops__muted">
                {month.open === 0
                  ? 'nothing open'
                  : `${month.open} operation${month.open === 1 ? '' : 's'} in flight`}
              </span>
            </div>
            <div className="v-intcredit__balance">
              <span className="v-intcredit__label">Not charged</span>
              <strong>{count(month.exempt)}</strong>
              <span className="v-ops__muted">free, external or BYOK rows</span>
            </div>
          </div>
          {month.open !== 0 && summary !== null ? (
            <ul className="v-intcredit__holds">
              {summary.openHolds.slice(0, 5).map((hold) => (
                <li key={hold.chargeId}>
                  <span>
                    {hold.integrationId ?? 'integration'} · {hold.operationId ?? hold.chargeId}
                  </span>
                  <span className="v-ops__muted">
                    {credits(hold.estimatedCredits)} held {stamp(hold.createdAt)}
                    {hold.executionId === null ? '' : ` · ${hold.executionId}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {policy === null ? null : (
        <div className="v-intcredit__classes">
          <h3>Who pays for an operation</h3>
          <ul>
            {policy.classes.map((entry) => (
              <li key={entry.billingClass}>
                <Badge
                  tone={
                    entry.billingClass === 'free'
                      ? 'success'
                      : entry.billingClass === 'paid'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {entry.label}
                </Badge>
                <span>{entry.meaning}</span>
              </li>
            ))}
          </ul>
          <p className="v-ops__muted">
            {policy.note} A hold is released after {policy.holdTtlSeconds} seconds if nobody settles
            it.
          </p>
        </div>
      )}

      <form
        className="v-intcredit__limits"
        onSubmit={(event) => {
          event.preventDefault();
          void saveLimits();
        }}
      >
        <h3>Spending limits</h3>
        <label>
          Monthly limit
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={monthlyLimit}
            placeholder="no limit"
            onChange={(event) => setMonthlyLimit(event.target.value)}
          />
        </label>
        <label>
          Per operation
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={perOperationLimit}
            placeholder="no limit"
            onChange={(event) => setPerOperationLimit(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={savingLimits}>
          {savingLimits ? 'Saving' : 'Save limits'}
        </Button>
        {limitError === null ? null : (
          <p className="v-ops__error" role="alert">
            {limitError}
          </p>
        )}
        {limitNotice === null ? null : <p className="v-ops__muted">{limitNotice}</p>}
      </form>

      {policy === null ? null : (
        <div className="v-intcredit__policy">
          <h3>What an integration operation costs</h3>
          <p className="v-ops__muted">
            {policy.defaultsOnly
              ? `These are the shipped defaults (table ${policy.version}), not prices. They are configurable per deployment.`
              : `These rates come from this deployment's configuration (table ${policy.version}).`}
          </p>
          <table className="v-ops__table">
            <thead>
              <tr>
                <th scope="col">Integration</th>
                <th scope="col">Operation</th>
                <th scope="col">Class</th>
                <th scope="col">Flat</th>
                <th scope="col">Per request</th>
                <th scope="col">Per unit</th>
              </tr>
            </thead>
            <tbody>
              {paidPolicies.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.integrationId}</td>
                  <td>{entry.operationId}</td>
                  <td>{classLabel(entry.billingClass)}</td>
                  <td>{entry.perOperation}</td>
                  <td>{entry.perRequest}</td>
                  <td>
                    {entry.rates.length === 0
                      ? 'none'
                      : entry.rates
                          .map((rate) => `${rate.creditsPerUnit} / ${rate.unit}`)
                          .join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="v-ops__muted">
            A free integration and a service that bills your own account are never charged here, and
            a call made with your own provider key is exempt.
          </p>
        </div>
      )}

      <div className="v-intcredit__usage">
        <h3>Where the credit went</h3>
        <div className="v-intcredit__tabs" role="group" aria-label="Group integration usage by">
          {DIMENSIONS.map((entry) => (
            <button
              key={entry.dimension}
              type="button"
              aria-pressed={dimension === entry.dimension}
              onClick={() => setDimension(entry.dimension)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {groups.length === 0 ? (
          <p className="v-ops__muted">No integration operation has been charged this month yet.</p>
        ) : (
          <table className="v-ops__table">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Charges</th>
                <th scope="col">Credits</th>
                <th scope="col">Requests</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((row) => (
                <tr key={row.key}>
                  <td>{groupLabel(row.key, dimension)}</td>
                  <td>{row.charges}</td>
                  <td>{row.credits.toFixed(2)}</td>
                  <td>{count(row.requests)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="v-intcredit__charges">
        <h3>Charges and holds</h3>
        {refundNotice === null ? null : (
          <p className="v-intcredit__notice" role="status">
            {refundNotice}
          </p>
        )}
        <div className="v-intcredit__tabs" role="group" aria-label="Filter charges by state">
          {['', 'reserved', 'committed', 'released', 'refunded', 'exempt'].map((value) => (
            <button
              key={value === '' ? 'all' : value}
              type="button"
              aria-pressed={stateFilter === value}
              onClick={() => setStateFilter(value)}
            >
              {value === '' ? 'All' : value}
            </button>
          ))}
        </div>
        {charges.length === 0 ? (
          <p className="v-ops__muted">Nothing matches this filter.</p>
        ) : (
          <table className="v-ops__table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Operation</th>
                <th scope="col">State</th>
                <th scope="col">Credits</th>
                <th scope="col">Measured</th>
                <th scope="col">Notes</th>
                {refundsOn ? <th scope="col">Refund</th> : null}
              </tr>
            </thead>
            <tbody>
              {charges.map((charge) => (
                <tr key={charge.id}>
                  <td>{stamp(charge.createdAt)}</td>
                  <td>
                    {charge.integrationId ?? charge.kind}
                    {' · '}
                    {charge.operationId ?? 'unspecified'}
                    {charge.executionId === null ? null : (
                      <span className="v-ops__muted"> · {charge.executionId}</span>
                    )}
                  </td>
                  <td>
                    <Badge tone={stateTone(charge.state)}>{charge.state}</Badge>
                    <span className="v-ops__muted"> {classLabel(charge.billingClass)}</span>
                  </td>
                  <td>
                    {credits(charge.credits)}
                    <span className="v-ops__muted">
                      {' '}
                      of {credits(charge.estimatedCredits)} held
                    </span>
                  </td>
                  <td>
                    {charge.requests === null ? 'not reported' : `${charge.requests} requests`}
                    <span className="v-ops__muted"> · {unitsText(charge.units)}</span>
                  </td>
                  <td>
                    {charge.limitations.length === 0 ? (
                      <span className="v-ops__muted">nothing</span>
                    ) : (
                      <span className="v-ops__muted">{charge.limitations.join(', ')}</span>
                    )}
                    {charge.failureReason === null ? null : (
                      <div className="v-ops__muted">{charge.failureReason}</div>
                    )}
                  </td>
                  {refundsOn ? (
                    <td>
                      {charge.state !== 'committed' || charge.credits <= 0 ? (
                        <span className="v-ops__muted">
                          {charge.state === 'refunded' ? 'refunded' : 'n/a'}
                        </span>
                      ) : refundFor === charge.id ? (
                        <div className="v-intcredit__refund">
                          <label htmlFor={`refund-token-${charge.id}`}>Operator token</label>
                          <input
                            id={`refund-token-${charge.id}`}
                            type="password"
                            autoComplete="off"
                            value={refundToken}
                            onChange={(event) => setRefundToken(event.target.value)}
                          />
                          <label htmlFor={`refund-reason-${charge.id}`}>Reason (optional)</label>
                          <input
                            id={`refund-reason-${charge.id}`}
                            type="text"
                            value={refundReason}
                            onChange={(event) => setRefundReason(event.target.value)}
                          />
                          <p className="v-ops__muted">
                            Used for this refund only and never stored. Refunding returns{' '}
                            {credits(charge.credits)} to the wallet; it does not reverse a payment.
                          </p>
                          {refundError === null ? null : (
                            <p className="v-ops__error" role="alert">
                              {refundError}
                            </p>
                          )}
                          <div className="v-intcredit__refund-actions">
                            <Button onClick={() => void submitRefund(charge)} disabled={refunding}>
                              {refunding ? 'Refunding…' : 'Refund credits'}
                            </Button>
                            <Button onClick={closeRefund} disabled={refunding}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="v-intcredit__refund-open"
                          onClick={() => openRefund(charge.id)}
                        >
                          Refund
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {integrity === null ? null : (
        <p className="v-ops__muted">
          {integrity.consistent
            ? 'Every committed charge has its ledger entry.'
            : `${integrity.chargesWithoutEntry} committed charge(s) have no ledger entry. Do not spend against this balance until it is reconciled.`}
        </p>
      )}
    </section>
  );
}
