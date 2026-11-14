import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { Badge, Button, Card, EmptyState, ErrorState, Spinner } from '../../components/ui';
import { errorMessage, isOffline, TransportError } from '../../api/client';
import {
  confirmPayment,
  getBilling,
  invoicePdfUrl,
  quote as requestQuote,
  startCheckout,
  type BillingInterval,
  type BillingOverview,
  type CheckoutView,
  type PaymentProviderId,
  type QuoteView,
  type SettleView,
} from '../../api/payments';
import './billing.css';

/**
 * Billing (Step 61).
 *
 * What this screen is careful about:
 *
 *  1. **It never states an amount the server did not send.** Prices, tax and the
 *     total come from a quote; the checkout body names a plan, an interval and a
 *     provider and nothing else. There is no arithmetic here that could disagree
 *     with the charge.
 *  2. **A return from the provider is not a receipt.** The `?reference=` in the
 *     URL only triggers a verification request. Until the server says `paid`, the
 *     screen says the payment is being confirmed - and if the server says it
 *     failed or mismatched, the screen says that in words.
 *  3. **Credits are a ceiling, not a balance.** The plan states what it includes;
 *     nothing on this page can add to a balance, because no such route exists.
 *  4. **A history is the owner's own.** Every row shown came from the owner's own
 *     endpoint, so there is nothing to filter out here.
 *  5. **Missing configuration is said out loud**: no provider, no price and no tax
 *     each have their own sentence instead of a disabled button with no reason.
 */

export interface BillingPageDeps {
  readonly load?: () => Promise<BillingOverview>;
  readonly quote?: (input: {
    planId: string;
    interval: BillingInterval;
    discountCode?: string | null;
  }) => Promise<QuoteView>;
  readonly checkout?: (input: {
    planId: string;
    interval: BillingInterval;
    provider: PaymentProviderId;
    email: string;
    name?: string | null;
  }) => Promise<CheckoutView>;
  readonly confirm?: (reference: string) => Promise<SettleView>;
  /** Overridden in tests so nothing navigates away. */
  readonly redirect?: (url: string) => void;
  /** Reads `?reference=` from the address bar. */
  readonly readReference?: () => string | null;
  readonly invoiceUrl?: (invoiceId: string, kind: 'invoice' | 'receipt') => string;
}

type LoadState = 'loading' | 'ready' | 'error' | 'offline';

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'error' | 'info'> = {
  succeeded: 'success',
  paid: 'success',
  pending: 'warning',
  issued: 'info',
  requested: 'warning',
  failed: 'error',
  abandoned: 'neutral',
  refunded: 'info',
  partially_refunded: 'info',
  cancelled: 'neutral',
  draft: 'neutral',
};

function money(minor: number, currency: string): string {
  const digits = currency === 'JPY' ? 0 : 2;
  const value = minor / 10 ** digits;
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${currency}`;
}

function day(iso: string | null): string {
  if (iso === null) return 'Not stated';
  return iso.slice(0, 10);
}

function defaultReadReference(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  if (query === '') return null;
  const params = new URLSearchParams(query);
  return params.get('reference');
}

export function BillingPage(deps: BillingPageDeps = {}): JSX.Element {
  const load = deps.load ?? getBilling;
  const quoteFor = deps.quote ?? ((input) => requestQuote(input));
  const checkout = deps.checkout ?? ((input) => startCheckout(input));
  const confirm = deps.confirm ?? confirmPayment;
  const redirect = deps.redirect ?? ((url: string) => window.location.assign(url));
  const readReference = deps.readReference ?? defaultReadReference;
  const invoiceUrl = deps.invoiceUrl ?? invoicePdfUrl;

  const [state, setState] = useState<LoadState>('loading');
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [interval, setInterval] = useState<BillingInterval>('monthly');
  const [planId, setPlanId] = useState<string | null>(null);
  const [provider, setProvider] = useState<PaymentProviderId | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [discountCode, setDiscountCode] = useState('');
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settling, setSettling] = useState<string | null>(null);
  const [settled, setSettled] = useState<SettleView | null>(null);

  const refresh = useCallback(async () => {
    setState('loading');
    setMessage(null);
    try {
      const next = await load();
      setOverview(next);
      setEmail((current) => current || (next.customer?.email ?? ''));
      setName((current) => current || (next.customer?.name ?? ''));
      setState('ready');
    } catch (error) {
      // An offline device says so at once: waiting out a timeout to report a
      // connection that is already known to be missing is the slowest answer.
      if (isOffline() || (error instanceof TransportError && error.failure === 'offline')) {
        setState('offline');
        return;
      }
      setMessage(errorMessage(error));
      setState('error');
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* A provider sends the customer back with a reference. Verify it, once. */
  useEffect(() => {
    const reference = readReference();
    if (reference === null) return;
    let cancelled = false;
    setSettling(reference);
    void (async () => {
      try {
        const result = await confirm(reference);
        if (cancelled) return;
        setSettled(result);
        await refresh();
      } catch (error) {
        if (cancelled) return;
        setMessage(errorMessage(error));
      } finally {
        if (!cancelled) setSettling(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [confirm, readReference, refresh]);

  const buyable = useMemo(() => {
    if (overview === null) return [];
    return overview.prices.filter((price) => price.monthly !== null || price.yearly !== null);
  }, [overview]);

  const chosen = buyable.find((price) => price.planId === planId) ?? buyable[0] ?? null;
  const activePlanId = chosen?.planId ?? null;
  const amountOf = useCallback(
    (row: { monthly: number | null; yearly: number | null }): number | null =>
      interval === 'monthly' ? row.monthly : row.yearly,
    [interval],
  );

  /* The amount shown is the server's quote, re-requested when the choice moves. */
  useEffect(() => {
    if (activePlanId === null) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    void (async () => {
      try {
        const next = await quoteFor({
          planId: activePlanId,
          interval,
          discountCode: discountCode.trim() === '' ? null : discountCode.trim(),
        });
        if (!cancelled) setQuote(next);
      } catch (error) {
        if (!cancelled) {
          setQuote(null);
          setMessage(errorMessage(error));
        }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePlanId, interval, discountCode, quoteFor]);

  const providerChoices = quote?.providers ?? [];
  const chosenProvider =
    providerChoices.find((view) => view.provider === provider) ?? providerChoices[0] ?? null;

  const pay = async (): Promise<void> => {
    if (activePlanId === null || chosenProvider === null) return;
    if (email.trim() === '') {
      setMessage('A receipt needs an email address.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const session = await checkout({
        planId: activePlanId,
        interval,
        provider: chosenProvider.provider,
        email: email.trim(),
        name: name.trim() === '' ? null : name.trim(),
      });
      redirect(session.checkoutUrl);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading' && overview === null) {
    return (
      <div className="billing" aria-busy="true">
        <Spinner aria-label="Reading your billing" />
      </div>
    );
  }

  if (state === 'offline') {
    return (
      <div className="billing">
        <ErrorState
          title="You are offline"
          description="Billing needs a connection. Nothing was charged, and your plan is unchanged."
        />
      </div>
    );
  }

  if (state === 'error' || overview === null) {
    return (
      <div className="billing">
        <ErrorState
          title="Billing could not be read"
          description={message ?? 'The server did not answer. Try again in a moment.'}
        />
        <Button variant="secondary" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  const plan = overview.plan;
  const taxes = overview.policies.taxConfigured;

  return (
    <div className="billing">
      <header className="billing__head">
        <h1>Billing</h1>
        <p className="billing__lede">
          Pay for a plan, see what was charged, and download the paperwork. A plan&apos;s credits
          are a monthly ceiling, not a balance.
        </p>
      </header>

      {settling !== null && (
        <Card>
          <p className="billing__note" role="status">
            <Spinner aria-label="Checking with the provider" /> Confirming the payment with the
            provider. A return from the payment page is not proof on its own.
          </p>
        </Card>
      )}

      {settled !== null && (
        <Card>
          <h2>{settled.status === 'paid' ? 'Payment received' : 'Payment not completed'}</h2>
          {settled.status === 'paid' || settled.status === 'already-paid' ? (
            <p className="billing__note">
              {settled.planId ?? 'Your plan'} is active
              {settled.invoice === null ? '.' : `, and ${settled.invoice.number} is ready below.`}
            </p>
          ) : (
            <p className="billing__note">
              {settled.status === 'mismatch'
                ? 'The provider reported an amount that does not match this order, so no plan was activated. Support has the details.'
                : (settled.reason ??
                  'The provider did not confirm this payment. Nothing was charged.')}
            </p>
          )}
        </Card>
      )}

      {message !== null && (
        <p className="billing__error" role="alert">
          {message}
        </p>
      )}

      <Card>
        <h2>Current plan</h2>
        <div className="billing__plan">
          <div>
            <p className="billing__plan-name">{plan.name}</p>
            <Badge tone={STATUS_TONE[plan.status] ?? 'neutral'}>{plan.status}</Badge>
          </div>
          <dl className="billing__facts">
            <div>
              <dt>Billed</dt>
              <dd>{plan.interval === null ? 'Not recurring' : plan.interval}</dd>
            </div>
            <div>
              <dt>Renews</dt>
              <dd>
                {plan.cancelAtPeriodEnd
                  ? 'Stops at the end of this period'
                  : plan.renews
                    ? day(plan.currentPeriodEnd)
                    : 'Does not renew'}
              </dd>
            </div>
            <div>
              <dt>Days remaining</dt>
              <dd>{plan.daysRemaining}</dd>
            </div>
            <div>
              <dt>Included each month</dt>
              <dd>
                {overview.subscription.monthlyMessageCredits.toLocaleString()} AI credits,{' '}
                {overview.subscription.monthlyIntegrationCredits.toLocaleString()} integration
                credits
              </dd>
            </div>
          </dl>
          {overview.subscription.reason !== null && (
            <p className="billing__note">{overview.subscription.reason}</p>
          )}
        </div>
      </Card>

      <Card>
        <h2>Choose a plan</h2>
        {buyable.length === 0 ? (
          <EmptyState
            title="No plan is priced yet"
            description="An operator has not configured a price, so there is nothing to buy. Nothing on this screen can invent one."
          />
        ) : (
          <>
            <div className="billing__toggle" role="group" aria-label="Billing interval">
              <Button
                variant={interval === 'monthly' ? 'primary' : 'secondary'}
                onClick={() => setInterval('monthly')}
              >
                Monthly
              </Button>
              <Button
                variant={interval === 'yearly' ? 'primary' : 'secondary'}
                onClick={() => setInterval('yearly')}
              >
                Yearly
              </Button>
            </div>

            <ul className="billing__plans">
              {buyable.map((row) => {
                const amount = amountOf(row);
                const selected = row.planId === activePlanId;
                return (
                  <li key={`${row.planId}-${row.currency}`}>
                    <button
                      type="button"
                      className={`billing__plan-option${selected ? ' is-selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => setPlanId(row.planId)}
                      disabled={amount === null}
                    >
                      <span className="billing__plan-option-name">{row.planName}</span>
                      <span className="billing__plan-option-price">
                        {amount === null
                          ? 'Not sold on this interval'
                          : money(amount, row.currency)}
                      </span>
                      {row.yearlySavingPercent !== null && interval === 'yearly' && (
                        <span className="billing__plan-option-saving">
                          {row.yearlySavingPercent}% less than twelve monthly payments
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            <label className="billing__field">
              <span>Discount code</span>
              <input
                value={discountCode}
                onChange={(event) => setDiscountCode(event.target.value)}
                placeholder="Optional"
                autoComplete="off"
              />
            </label>

            <div className="billing__review">
              {quoting && <Spinner aria-label="Pricing that plan" />}
              {!quoting && quote !== null && (
                <>
                  <p className="billing__total">
                    {quote.planName} · {quote.interval} · <strong>{quote.formatted}</strong>
                  </p>
                  {quote.discountMinor > 0 && (
                    <p className="billing__note">
                      {money(quote.discountMinor, quote.currency)} off with {quote.discountCode}.
                    </p>
                  )}
                  {quote.taxMinor > 0 && (
                    <p className="billing__note">
                      {quote.taxName} ({quote.taxRateBps / 100}%):{' '}
                      {money(quote.taxMinor, quote.currency)}
                    </p>
                  )}
                  {quote.taxMinor === 0 && (
                    <p className="billing__note">
                      {taxes
                        ? 'No tax applies to this billing country.'
                        : 'No tax rate is configured for this deployment, so none is added. Nothing here claims to be tax compliant.'}
                    </p>
                  )}
                  <p className="billing__note">{quote.note}</p>
                </>
              )}
              {!quoting && quote === null && (
                <p className="billing__note">
                  That plan could not be priced just now, so it cannot be bought from here.
                </p>
              )}
            </div>

            {providerChoices.length === 0 ? (
              <p className="billing__note">
                No payment method is available for this currency yet. An operator has to enable a
                provider first.
              </p>
            ) : (
              <>
                <fieldset className="billing__providers">
                  <legend>Pay with</legend>
                  {providerChoices.map((view) => (
                    <label key={view.provider} className="billing__provider">
                      <input
                        type="radio"
                        name="provider"
                        value={view.provider}
                        checked={chosenProvider?.provider === view.provider}
                        onChange={() => setProvider(view.provider)}
                      />
                      <span>{view.displayName}</span>
                      <span className="billing__provider-note">
                        {view.capabilities.recurring
                          ? 'Card can be saved for renewals'
                          : 'Renewal is manual with this provider'}
                      </span>
                    </label>
                  ))}
                </fieldset>

                <label className="billing__field">
                  <span>Receipt email</span>
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    type="email"
                    autoComplete="email"
                    required
                  />
                </label>
                <label className="billing__field">
                  <span>Name on the invoice</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                  />
                </label>

                <Button
                  onClick={() => void pay()}
                  disabled={busy || quote === null || chosenProvider === null}
                >
                  {busy ? 'Opening the payment page' : 'Continue to payment'}
                </Button>
                <p className="billing__note">
                  You are sent to the provider to pay. Nothing is charged until you finish there,
                  and the plan is activated only after this server verifies the payment.
                </p>
              </>
            )}
          </>
        )}
      </Card>

      <Card>
        <h2>Payments</h2>
        {overview.transactions.length === 0 ? (
          <EmptyState
            title="No payments yet"
            description="Once a payment is verified it appears here with the amount and the reference."
          />
        ) : (
          <div className="billing__table-wrap">
            <table className="billing__table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Plan</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Method</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {overview.transactions.map((row) => (
                  <tr key={row.id}>
                    <td>{day(row.createdAt)}</td>
                    <td>
                      {row.planId} · {row.interval}
                    </td>
                    <td>{row.kind}</td>
                    <td>{money(row.amountMinor, row.currency)}</td>
                    <td>{row.provider}</td>
                    <td>
                      <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge>
                      {row.failureReason !== null && (
                        <span className="billing__why">{row.failureReason}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2>Invoices and receipts</h2>
        {overview.invoices.length === 0 ? (
          <EmptyState
            title="No invoices yet"
            description="An invoice is issued the moment a payment is verified."
          />
        ) : (
          <ul className="billing__invoices">
            {overview.invoices.map((invoice) => (
              <li key={invoice.id}>
                <div>
                  <p className="billing__invoice-number">{invoice.number}</p>
                  <p className="billing__note">
                    {day(invoice.issuedAt)} · {invoice.planName} ·{' '}
                    {money(invoice.totalMinor, invoice.currency)}
                  </p>
                </div>
                <div className="billing__invoice-actions">
                  <Badge tone={STATUS_TONE[invoice.status] ?? 'neutral'}>{invoice.status}</Badge>
                  <a href={invoiceUrl(invoice.id, 'invoice')} download>
                    Invoice PDF
                  </a>
                  <a href={invoiceUrl(invoice.id, 'receipt')} download>
                    Receipt PDF
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="billing__note">Refunds: {overview.policies.refund.note}</p>
      </Card>

      {overview.refunds.length > 0 && (
        <Card>
          <h2>Refunds</h2>
          <ul className="billing__invoices">
            {overview.refunds.map((refund) => (
              <li key={refund.id}>
                <div>
                  <p className="billing__invoice-number">
                    {money(refund.amountMinor, refund.currency)}
                  </p>
                  <p className="billing__note">
                    {day(refund.createdAt)} · {refund.reason}
                  </p>
                </div>
                <Badge tone={STATUS_TONE[refund.status] ?? 'neutral'}>{refund.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {overview.notifications.length > 0 && (
        <Card>
          <h2>Notices</h2>
          <ul className="billing__invoices">
            {overview.notifications.map((note) => (
              <li key={note.id}>
                <div>
                  <p className="billing__invoice-number">{note.title}</p>
                  <p className="billing__note">
                    {day(note.createdAt)} · {note.message}
                  </p>
                </div>
                {note.readAt === null && <Badge tone="info">new</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="billing__footnote">{overview.note}</p>
    </div>
  );
}

export default BillingPage;
