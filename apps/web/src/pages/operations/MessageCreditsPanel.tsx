import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Spinner } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  getMessageCreditIntegrity,
  getMessageCreditPolicy,
  getMessageCreditSummary,
  getMessageUsage,
  listMessageCharges,
  type MessageChargeView,
  type MessageCreditIntegrity,
  type MessageCreditPolicyView,
  type MessageCreditSummary,
  type UsageGroupView,
} from '../../api/message-credits';

/**
 * Message credits (Step 54).
 *
 * The panel answers three questions and refuses to blur them:
 *
 *  - what a message costs. The rates shown are the deployed table, labelled as
 *    configurable defaults when they are the shipped ones, never as prices;
 *  - what has been charged. Every row names its model, its conversation and what
 *    could not be measured, because a charge without its measurement is a number
 *    nobody can check;
 *  - what is being held right now. A hold is credit the owner cannot spend yet,
 *    so it is shown beside the balance rather than folded into it.
 *
 * Nothing here decides a charge. The server does, during the request.
 */

const CHECKS: readonly { dimension: 'model' | 'project' | 'conversation'; label: string }[] = [
  { dimension: 'model', label: 'By model' },
  { dimension: 'project', label: 'By project' },
  { dimension: 'conversation', label: 'By conversation' },
];

function credits(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not measured';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${rounded === 1 ? 'credit' : 'credits'}`;
}

function tokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not measured';
  return value.toLocaleString('en-GB');
}

function stateTone(state: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (state === 'committed') return 'success';
  if (state === 'reserved') return 'warning';
  if (state === 'failed') return 'error';
  if (state === 'refunded') return 'error';
  return 'neutral';
}

function groupLabel(key: string): string {
  return key.trim() === '' || key === 'none' ? 'Unassigned' : key;
}

export function MessageCreditsPanel() {
  const [summary, setSummary] = useState<MessageCreditSummary | null>(null);
  const [policy, setPolicy] = useState<MessageCreditPolicyView | null>(null);
  const [charges, setCharges] = useState<readonly MessageChargeView[]>([]);
  const [groups, setGroups] = useState<readonly UsageGroupView[]>([]);
  const [dimension, setDimension] = useState<'model' | 'project' | 'conversation'>('model');
  const [integrity, setIntegrity] = useState<MessageCreditIntegrity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, nextPolicy, page, usage, check] = await Promise.all([
        getMessageCreditSummary(),
        getMessageCreditPolicy(),
        listMessageCharges({ limit: 25 }),
        getMessageUsage(dimension),
        getMessageCreditIntegrity(),
      ]);
      setSummary(nextSummary);
      setPolicy(nextPolicy);
      setCharges(page.charges);
      setGroups(usage.groups);
      setIntegrity(check);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Message credits could not be loaded. Nothing has been charged by this screen.',
      );
    } finally {
      setLoading(false);
    }
  }, [dimension]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && summary === null) {
    return (
      <section className="v-msgcredit" aria-busy="true">
        <header className="v-msgcredit__head">
          <h2>Message credits</h2>
        </header>
        <p className="v-ops__muted">
          <Spinner /> Reading your message-credit balance.
        </p>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section className="v-msgcredit">
        <header className="v-msgcredit__head">
          <h2>Message credits</h2>
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
  const settings = summary?.settings;
  const short = wallet !== undefined && wallet.spendable <= 0;

  return (
    <section className="v-msgcredit">
      <header className="v-msgcredit__head">
        <h2>Message credits</h2>
        <p className="v-ops__muted">
          One charge per billable interaction, settled from what was measured. Rates are the
          deployment&apos;s configuration, not a market price.
        </p>
      </header>

      {wallet === undefined ? null : (
        <div className="v-msgcredit__balances">
          <div className="v-msgcredit__balance">
            <span className="v-msgcredit__label">Available</span>
            <strong>{credits(wallet.available)}</strong>
          </div>
          <div className="v-msgcredit__balance">
            <span className="v-msgcredit__label">Held for work in flight</span>
            <strong>{credits(wallet.reserved)}</strong>
          </div>
          <div className="v-msgcredit__balance">
            <span className="v-msgcredit__label">Spent</span>
            <strong>{credits(wallet.spent)}</strong>
          </div>
          <div className="v-msgcredit__balance">
            <span className="v-msgcredit__label">This month</span>
            <strong>{credits(month?.credits)}</strong>
            <span className="v-ops__muted">
              {month?.charges ?? 0} charges
              {month !== undefined && month.refunded > 0
                ? `, ${credits(month.refunded)} refunded`
                : ''}
            </span>
          </div>
        </div>
      )}

      {month === undefined ? null : (
        <div className="v-msgcredit__tokens" data-testid="credit-tokens">
          <h3>Tokens this month</h3>
          <div className="v-msgcredit__balances">
            <div className="v-msgcredit__balance">
              <span className="v-msgcredit__label">Input, uncached</span>
              <strong>{tokens(month.tokens.uncached)}</strong>
            </div>
            <div className="v-msgcredit__balance">
              <span className="v-msgcredit__label">Input, cached</span>
              <strong>{tokens(month.tokens.cached)}</strong>
              <span className="v-ops__muted">billed at the cache rate</span>
            </div>
            <div className="v-msgcredit__balance">
              <span className="v-msgcredit__label">Output</span>
              <strong>{tokens(month.tokens.output)}</strong>
            </div>
            <div className="v-msgcredit__balance">
              <span className="v-msgcredit__label">Credit held, not yet settled</span>
              <strong>{credits(month.openCredits)}</strong>
              <span className="v-ops__muted">
                {month.open === 0
                  ? 'nothing open'
                  : `${month.open} charge${month.open === 1 ? '' : 's'} not yet settled`}
              </span>
            </div>
          </div>
          {month.tokens.input === 0 && month.tokens.output === 0 ? (
            <p className="v-ops__muted">
              No tokens have been measured this month. A charge carrying no measurement says so
              rather than counting as zero usage, so this can stay empty while credits are spent.
            </p>
          ) : null}
        </div>
      )}

      {short ? (
        <div className="v-msgcredit__warning" role="status">
          No message credits are available. New AI requests are refused before they reach a
          provider, and nothing you typed is discarded: the estimate and the exact shortfall come
          back with the refusal so you can add credit and resend.
        </div>
      ) : null}

      <div className="v-msgcredit__limits">
        <span>
          Per-request limit:{' '}
          <strong>
            {settings?.perRequestLimit === null ? 'none set' : credits(settings?.perRequestLimit)}
          </strong>
        </span>
        <span>
          Monthly limit:{' '}
          <strong>
            {settings?.monthlyLimit === null ? 'none set' : credits(settings?.monthlyLimit)}
          </strong>
        </span>
      </div>

      {policy === null ? null : (
        <div className="v-msgcredit__policy">
          <h3>What a message costs</h3>
          {policy.defaultsOnly ? (
            <p className="v-ops__muted">
              These are the shipped defaults (table {policy.version}), not prices. They are
              configurable per deployment.
            </p>
          ) : (
            <p className="v-ops__muted">
              These rates come from this deployment&apos;s configuration (table {policy.version}).
            </p>
          )}
          <table className="v-ops__table v-msgcredit__rates">
            <thead>
              <tr>
                <th scope="col">Interaction</th>
                <th scope="col">Flat</th>
                <th scope="col">Per 1k input</th>
                <th scope="col">Per 1k output</th>
                <th scope="col">Per 1k cached</th>
                <th scope="col">Per tool call</th>
              </tr>
            </thead>
            <tbody>
              {(policy.plans.find((plan) => plan.billable)?.interactions ?? []).map((rate) => (
                <tr key={rate.policyId}>
                  <td>{rate.kind}</td>
                  <td>{rate.flatCredits}</td>
                  <td>{rate.per1kInput}</td>
                  <td>{rate.per1kOutput}</td>
                  <td>{rate.per1kCached}</td>
                  <td>{rate.perToolCall}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary !== null && summary.openReservations.length > 0 ? (
        <div className="v-msgcredit__holds">
          <h3>Held now</h3>
          <ul>
            {summary.openReservations.map((hold) => (
              <li key={hold.chargeId}>
                {hold.kind} · {credits(hold.estimatedCredits)} held
                {hold.conversationId === null ? '' : ` · ${hold.conversationId}`}
              </li>
            ))}
          </ul>
          <p className="v-ops__muted">
            A hold is unsettled credit. It comes back if the work fails, is cancelled or never
            reports.
          </p>
        </div>
      ) : null}

      <div className="v-msgcredit__usage">
        <div className="v-msgcredit__tabs" role="tablist" aria-label="Usage grouping">
          {CHECKS.map((check) => (
            <Button
              key={check.dimension}
              variant={dimension === check.dimension ? 'primary' : 'ghost'}
              aria-pressed={dimension === check.dimension}
              onClick={() => setDimension(check.dimension)}
            >
              {check.label}
            </Button>
          ))}
        </div>
        {groups.length === 0 ? (
          <p className="v-ops__muted">Nothing charged in this dimension yet.</p>
        ) : (
          <table className="v-ops__table">
            <thead>
              <tr>
                <th scope="col">{dimension}</th>
                <th scope="col">Charges</th>
                <th scope="col">Credits</th>
                <th scope="col">Input tokens</th>
                <th scope="col">Output tokens</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.key}>
                  <td>{groupLabel(group.key)}</td>
                  <td>{group.charges}</td>
                  <td>{credits(group.credits)}</td>
                  <td>{group.inputTokens}</td>
                  <td>{group.outputTokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="v-msgcredit__charges">
        <h3>Recent message charges</h3>
        {charges.length === 0 ? (
          <p className="v-ops__muted">No message has been charged yet.</p>
        ) : (
          <table className="v-ops__table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Interaction</th>
                <th scope="col">Model</th>
                <th scope="col">Credits</th>
                <th scope="col">State</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((charge) => (
                <tr key={charge.id}>
                  <td>{new Date(charge.createdAt).toLocaleString()}</td>
                  <td>{charge.kind}</td>
                  <td>{charge.modelId ?? 'not recorded'}</td>
                  <td>{credits(charge.credits)}</td>
                  <td>
                    <Badge tone={stateTone(charge.state)}>{charge.state}</Badge>
                  </td>
                  <td>
                    {charge.limitations.length === 0
                      ? charge.basis
                      : `${charge.basis}; ${charge.limitations.join(', ')}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {integrity === null ? null : (
        <p className={integrity.consistent ? 'v-ops__muted' : 'v-ops__error'}>
          {integrity.consistent
            ? 'The wallet ledger agrees with every message charge on record.'
            : `Ledger disagreement: ${[...integrity.walletDiscrepancies, ...integrity.chargesWithoutEntry].join(', ')}`}
        </p>
      )}
    </section>
  );
}
