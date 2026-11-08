import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Spinner } from '../../components/ui';
import { ApiError } from '../../api/client';
import {
  getWalletCapabilities,
  getWalletOverview,
  listWalletTransactions,
  reconcileWallet,
  type WalletCapabilities,
  type WalletEntryKind,
  type WalletEntryView,
  type WalletOverviewView,
  type WalletReconciliation,
} from '../../api/wallet';

/**
 * Credit wallet (Step 53).
 *
 * Two display rules, both of them about not flattering the numbers:
 *
 *  - `reserved` is money already promised to work in flight, so the panel leads
 *    with what is spendable and shows the hold beside it. Showing `available`
 *    alone would read as "this is yours to spend" when part of it is committed.
 *  - every entry says what moved and why, in the words the ledger stored. A
 *    charge with no visible rate is a charge the user cannot check, so the rate
 *    table is one click away rather than hidden.
 *
 * Nothing here can add credit. Refunds and adjustments are operator work and
 * live behind an admin token, not behind a button a user can press.
 */

const KIND_LABELS: Record<WalletEntryKind, string> = {
  purchase: 'Credit added',
  grant: 'Credit granted',
  promotion: 'Promotion',
  usage_deduction: 'Usage charge',
  reservation: 'Held for work',
  reservation_commit: 'Hold settled',
  reservation_release: 'Hold released',
  refund: 'Refund',
  adjustment_credit: 'Adjustment (credit)',
  adjustment_debit: 'Adjustment (debit)',
  reversal: 'Reversal',
};

function credits(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function signed(entry: WalletEntryView): string {
  if (entry.availableDelta === 0 && entry.reservedDelta !== 0) return 'held';
  if (entry.kind === 'refund' || entry.availableDelta > 0) return `+${credits(entry.amount)}`;
  if (entry.spentDelta > 0) return `-${credits(entry.amount)}`;
  return credits(entry.amount);
}

export function WalletPanel() {
  const [overview, setOverview] = useState<WalletOverviewView | null>(null);
  const [capabilities, setCapabilities] = useState<WalletCapabilities | null>(null);
  const [entries, setEntries] = useState<readonly WalletEntryView[]>([]);
  const [report, setReport] = useState<WalletReconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRates, setShowRates] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [nextOverview, nextCapabilities, ledger] = await Promise.all([
        getWalletOverview(),
        getWalletCapabilities(),
        listWalletTransactions({ limit: 25 }),
      ]);
      setOverview(nextOverview);
      setCapabilities(nextCapabilities);
      setEntries(ledger.transactions);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The wallet could not be read just now.',
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await reconcileWallet());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Reconciliation did not run.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (overview === null) {
    return (
      <section className="v-wallet" aria-labelledby="v-wallet-title">
        <header className="v-wallet__head">
          <h2 id="v-wallet-title">Credit wallet</h2>
        </header>
        {error === null ? (
          <p className="v-wallet__empty">
            <Spinner /> Reading your wallet…
          </p>
        ) : (
          <p className="v-wallet__error" role="alert">
            {error}{' '}
            <Button variant="ghost" onClick={() => void load()}>
              Try again
            </Button>
          </p>
        )}
      </section>
    );
  }

  const { wallet, held, rates } = overview;
  const used = entries.filter((entry) => entry.kind === 'usage_deduction');

  return (
    <section className="v-wallet" aria-labelledby="v-wallet-title">
      <header className="v-wallet__head">
        <div>
          <h2 id="v-wallet-title">Credit wallet</h2>
          <p className="v-wallet__sub">
            {wallet.scope === 'workspace' ? 'Workspace wallet' : 'Personal wallet'} ·{' '}
            {credits(wallet.available)} credits available
          </p>
        </div>
        <div className="v-wallet__head-actions">
          {overview.durable ? (
            <Badge tone="neutral">Stored</Badge>
          ) : (
            <Badge tone="warning">In memory only</Badge>
          )}
          <Button variant="ghost" onClick={() => void load()} disabled={busy}>
            Refresh
          </Button>
        </div>
      </header>

      <div className="v-wallet__tiles">
        <div className="v-wallet__tile">
          <span className="v-wallet__label">Available</span>
          <strong className="v-wallet__value">{credits(wallet.available)}</strong>
          <span className="v-wallet__hint">Credits you can spend right now.</span>
        </div>
        <div className="v-wallet__tile">
          <span className="v-wallet__label">Held</span>
          <strong className="v-wallet__value">{credits(wallet.reserved)}</strong>
          <span className="v-wallet__hint">
            Promised to work that has started. Not spent, not spendable.
          </span>
        </div>
        <div className="v-wallet__tile">
          <span className="v-wallet__label">Spent</span>
          <strong className="v-wallet__value">{credits(wallet.spent)}</strong>
          <span className="v-wallet__hint">Consumed for good; refunds reduce this.</span>
        </div>
        <div className="v-wallet__tile">
          <span className="v-wallet__label">Spendable now</span>
          <strong className="v-wallet__value">{credits(wallet.spendable)}</strong>
          <span className="v-wallet__hint">Available minus what is held.</span>
        </div>
      </div>

      <p className="v-wallet__note">{overview.note}</p>
      {wallet.policy.allowNegative ? (
        <p className="v-wallet__note">
          This wallet may run to <strong>-{credits(wallet.policy.negativeFloor)}</strong> credits
          under an approved credit line.
        </p>
      ) : null}

      {held.length > 0 ? (
        <div className="v-wallet__block">
          <h3>Held for work in flight</h3>
          <ul className="v-wallet__holds">
            {held.map((hold) => (
              <li key={hold.id}>
                <span>{credits(hold.amount)} credits</span>
                <span className="v-wallet__muted">{hold.operationKey}</span>
                <span className="v-wallet__muted">expires {when(hold.expiresAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="v-wallet__block">
        <div className="v-wallet__block-head">
          <h3>Recent transactions</h3>
          <Button variant="ghost" onClick={() => setShowRates((open) => !open)}>
            {showRates ? 'Hide rates' : 'How credits are charged'}
          </Button>
        </div>

        {showRates && capabilities !== null ? (
          <div className="v-wallet__rates">
            <p className="v-wallet__muted">
              Rate table {capabilities.rateVersion}. {rates.note}
            </p>
            <ul>
              {capabilities.rates.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <ul className="v-wallet__rules">
              {capabilities.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {entries.length === 0 ? (
          <p className="v-wallet__empty">
            Nothing has moved in this wallet yet. Usage that is billable appears here once it has
            been metered.
          </p>
        ) : (
          <div className="v-wallet__table-wrap">
            <table className="v-wallet__table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Balance after</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{when(entry.occurredAt)}</td>
                    <td>{KIND_LABELS[entry.kind] ?? entry.kind}</td>
                    <td className={entry.spentDelta > 0 ? 'v-wallet__out' : 'v-wallet__in'}>
                      {signed(entry)}
                    </td>
                    <td>{credits(entry.balanceAfter)}</td>
                    <td className="v-wallet__muted">
                      {entry.reason}
                      {entry.actor ? ` · ${entry.actor}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {used.length > 0 ? (
          <p className="v-wallet__muted">
            {used.length} of these are usage charges: work that ran and was billed at the rate shown
            above.
          </p>
        ) : null}
      </div>

      <div className="v-wallet__block">
        <div className="v-wallet__block-head">
          <h3>Reconciliation</h3>
          <Button variant="ghost" onClick={() => void check()} disabled={busy}>
            Check balances against the ledger
          </Button>
        </div>
        {report === null ? (
          <p className="v-wallet__muted">
            The wallet is the running total of the ledger; this proves the two agree.
          </p>
        ) : (
          <div className={report.consistent ? 'v-wallet__ok' : 'v-wallet__error'} role="status">
            {report.consistent ? (
              <>
                Consistent across {report.entries} entries: {credits(report.ledger.available)}{' '}
                available, {credits(report.ledger.reserved)} held, {credits(report.ledger.spent)}{' '}
                spent.
              </>
            ) : (
              <>
                The stored balances do not match the ledger:
                <ul>
                  {report.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {error !== null ? (
        <p className="v-wallet__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
