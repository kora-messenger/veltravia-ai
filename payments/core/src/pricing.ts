/**
 * The price book.
 *
 * Prices are **rows**, not constants: an operator changes what a plan costs
 * without touching source, and every invoice keeps the amount it was issued
 * with. Three rules make that safe:
 *
 *  1. **One price per (plan, interval, currency).** A second row for the same
 *     combination is a configuration mistake, not a choice the server can make
 *     at checkout time, so the store keeps them unique and a quote refuses an
 *     ambiguous book.
 *  2. **The quote is arithmetic on rows.** `buildQuote` reads a price row, a
 *     discount row and one effective tax row and returns the exact number to
 *     charge. It takes no amount from a caller, so a browser cannot name a
 *     price.
 *  3. **Nothing here is a market price.** `DEFAULT_PRICE_NOTE` says so, and the
 *     seed book is deliberately empty: this build ships no commercial price and
 *     cannot charge until an operator publishes one.
 */

import { applyPercent, applyRateBps, assertMinorAmount, normalizeCurrency } from './money.js';
import { PaymentError } from './types.js';

export const BILLING_INTERVALS = ['monthly', 'yearly'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export function isBillingInterval(value: unknown): value is BillingInterval {
  return typeof value === 'string' && (BILLING_INTERVALS as readonly string[]).includes(value);
}

/** Published beside every price so no screen can present a default as a market rate. */
export const DEFAULT_PRICE_NOTE =
  'Prices are configuration for this deployment. They are not a market rate and no checkout is possible until an operator publishes one.';

export interface PriceRecord {
  readonly id: string;
  readonly planId: string;
  readonly interval: BillingInterval;
  readonly currency: string;
  /** Minor units. `0` is legal and means "free", not "unset". */
  readonly amountMinor: number;
  readonly active: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface DiscountRecord {
  /** Upper-case code the customer types. Stored upper-case so matching is exact. */
  readonly code: string;
  readonly description: string;
  /** Whole percent off. `0` when the discount is a fixed amount instead. */
  readonly percentOff: number;
  /** Fixed reduction in minor units, or null for a percentage discount. */
  readonly amountOffMinor: number | null;
  /** A fixed-amount discount only applies to this currency. */
  readonly currency: string | null;
  readonly active: boolean;
  readonly startsAt: string | null;
  readonly expiresAt: string | null;
  readonly maxRedemptions: number | null;
  readonly redemptions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * A configured tax. `rateBps` is basis points, and a deployment starts with no
 * tax rows at all: this build does not invent a jurisdiction's rate, and
 * `docs/payments.md` says plainly that configuring one is the operator's
 * responsibility, not a compliance claim.
 */
export interface TaxRecord {
  readonly id: string;
  readonly name: string;
  /** ISO country the rate applies to, or null for the deployment default. */
  readonly country: string | null;
  readonly rateBps: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface EffectiveTax {
  readonly name: string;
  readonly rateBps: number;
}

/** Every number a checkout and an invoice need, decided here and only here. */
export interface PurchaseQuote {
  readonly planId: string;
  readonly interval: BillingInterval;
  readonly currency: string;
  readonly unitAmountMinor: number;
  readonly discountCode: string | null;
  readonly discountMinor: number;
  /** Price after the discount, before tax. */
  readonly subtotalMinor: number;
  readonly taxName: string | null;
  readonly taxRateBps: number;
  readonly taxMinor: number;
  /** The one amount the provider is asked for and the one a verification checks. */
  readonly totalMinor: number;
}

/** A price row reduced to what a plan screen needs, with the interval contrast. */
export interface PlanPriceView {
  readonly planId: string;
  readonly currency: string;
  readonly monthly: number | null;
  readonly yearly: number | null;
  /** Whole-percent saving of the yearly price against twelve monthly ones. */
  readonly yearlySavingPercent: number | null;
}

export function normalizePriceDraft(input: unknown): {
  planId: string;
  interval: BillingInterval;
  currency: string;
  amountMinor: number;
  active: boolean;
} {
  const draft = (input ?? {}) as Record<string, unknown>;
  const planId = typeof draft.planId === 'string' ? draft.planId.trim() : '';
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(planId)) {
    throw new PaymentError('PRICE_INVALID', 'A price needs the id of an existing plan.');
  }
  if (!isBillingInterval(draft.interval)) {
    throw new PaymentError('PRICE_INVALID', 'A price is either monthly or yearly.');
  }
  const currency = normalizeCurrency(draft.currency);
  const amountMinor = assertMinorAmount(draft.amountMinor, 'price');
  return {
    planId,
    interval: draft.interval,
    currency,
    amountMinor,
    active: draft.active !== false,
  };
}

export function normalizeDiscountDraft(input: unknown): {
  code: string;
  description: string;
  percentOff: number;
  amountOffMinor: number | null;
  currency: string | null;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  maxRedemptions: number | null;
} {
  const draft = (input ?? {}) as Record<string, unknown>;
  const code = typeof draft.code === 'string' ? draft.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
    throw new PaymentError(
      'DISCOUNT_INVALID',
      'A discount code is 3 to 32 characters: letters, digits, dash or underscore.',
    );
  }
  const percentRaw = draft.percentOff;
  const amountRaw = draft.amountOffMinor;
  const hasPercent = percentRaw !== undefined && percentRaw !== null;
  const hasAmount = amountRaw !== undefined && amountRaw !== null;
  if (hasPercent === hasAmount) {
    throw new PaymentError(
      'DISCOUNT_INVALID',
      'A discount is either a percentage or a fixed amount, not both and not neither.',
    );
  }
  const percentOff = hasPercent ? Number(percentRaw) : 0;
  if (hasPercent && (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100)) {
    throw new PaymentError(
      'DISCOUNT_INVALID',
      'A percentage discount is a whole number, 1 to 100.',
    );
  }
  const amountOffMinor = hasAmount ? assertMinorAmount(amountRaw, 'discount') : null;
  if (amountOffMinor !== null && amountOffMinor === 0) {
    throw new PaymentError('DISCOUNT_INVALID', 'A fixed discount of zero is not a discount.');
  }
  const currency = amountOffMinor === null ? null : normalizeCurrency(draft.currency);
  const startsAt = isoOrNull(draft.startsAt, 'startsAt');
  const expiresAt = isoOrNull(draft.expiresAt, 'expiresAt');
  if (startsAt !== null && expiresAt !== null && Date.parse(expiresAt) <= Date.parse(startsAt)) {
    throw new PaymentError('DISCOUNT_INVALID', 'A discount has to end after it starts.');
  }
  const maxRaw = draft.maxRedemptions;
  let maxRedemptions: number | null = null;
  if (maxRaw !== undefined && maxRaw !== null) {
    const parsed = Number(maxRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new PaymentError('DISCOUNT_INVALID', 'A redemption cap is a whole number, 1 or more.');
    }
    maxRedemptions = parsed;
  }
  return {
    code,
    description:
      typeof draft.description === 'string' ? draft.description.trim().slice(0, 280) : '',
    percentOff,
    amountOffMinor,
    currency,
    active: draft.active !== false,
    startsAt,
    expiresAt,
    maxRedemptions,
  };
}

export function normalizeTaxDraft(input: unknown): {
  name: string;
  country: string | null;
  rateBps: number;
  active: boolean;
} {
  const draft = (input ?? {}) as Record<string, unknown>;
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (name.length < 2 || name.length > 64) {
    throw new PaymentError('TAX_INVALID', 'A tax needs a name of 2 to 64 characters.');
  }
  const rateBps = Number(draft.rateBps);
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new PaymentError('TAX_INVALID', 'A tax rate is 0 to 10,000 basis points.');
  }
  const countryRaw = draft.country;
  const country =
    typeof countryRaw === 'string' && countryRaw.trim() !== ''
      ? countryRaw.trim().toUpperCase()
      : null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) {
    throw new PaymentError('TAX_INVALID', 'A tax country is a two-letter code, or left blank.');
  }
  return { name, country, rateBps, active: draft.active !== false };
}

function isoOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new PaymentError('DISCOUNT_INVALID', `The ${field} date is not a date.`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new PaymentError('DISCOUNT_INVALID', `The ${field} date is not a date.`);
  }
  return new Date(parsed).toISOString();
}

/** The price row for one plan, interval and currency. Ambiguity is a refusal. */
export function resolvePrice(
  prices: readonly PriceRecord[],
  planId: string,
  interval: BillingInterval,
  currency: string,
): PriceRecord {
  const wanted = normalizeCurrency(currency);
  const active = prices.filter(
    (price) =>
      price.active &&
      price.planId === planId &&
      price.interval === interval &&
      price.currency === wanted,
  );
  if (active.length === 0) {
    throw new PaymentError(
      'PRICE_UNAVAILABLE',
      `There is no ${interval} price for this plan in ${wanted} yet.`,
      409,
      { planId, interval, currency: wanted },
    );
  }
  if (active.length > 1) {
    throw new PaymentError(
      'PRICE_AMBIGUOUS',
      `More than one ${interval} price is configured for this plan in ${wanted}.`,
      409,
      { planId, interval, currency: wanted },
    );
  }
  return active[0] as PriceRecord;
}

/** One number per currency, for the plan comparison screen. */
export function priceView(
  prices: readonly PriceRecord[],
  planId: string,
): readonly PlanPriceView[] {
  const currencies = [
    ...new Set(
      prices.filter((price) => price.planId === planId && price.active).map((p) => p.currency),
    ),
  ].sort();
  return currencies.map((currency) => {
    const monthly = prices.find(
      (p) => p.active && p.planId === planId && p.currency === currency && p.interval === 'monthly',
    );
    const yearly = prices.find(
      (p) => p.active && p.planId === planId && p.currency === currency && p.interval === 'yearly',
    );
    const monthlyAmount = monthly?.amountMinor ?? null;
    const yearlyAmount = yearly?.amountMinor ?? null;
    let saving: number | null = null;
    if (monthlyAmount !== null && monthlyAmount > 0 && yearlyAmount !== null) {
      const full = monthlyAmount * 12;
      saving = Math.max(0, Math.round(((full - yearlyAmount) / full) * 100));
    }
    return {
      planId,
      currency,
      monthly: monthlyAmount,
      yearly: yearlyAmount,
      yearlySavingPercent: saving,
    };
  });
}

/**
 * Why a discount cannot be used, or `null` when it can. Kept separate from the
 * arithmetic so the refusal can say which rule failed.
 */
export function discountRefusal(
  discount: DiscountRecord | null,
  input: { currency: string; now: string; amountMinor: number },
): string | null {
  if (discount === null) return 'That discount code is not recognised.';
  if (!discount.active) return 'That discount code is no longer available.';
  const now = Date.parse(input.now);
  if (discount.startsAt !== null && now < Date.parse(discount.startsAt)) {
    return 'That discount code is not active yet.';
  }
  if (discount.expiresAt !== null && now >= Date.parse(discount.expiresAt)) {
    return 'That discount code has expired.';
  }
  if (discount.maxRedemptions !== null && discount.redemptions >= discount.maxRedemptions) {
    return 'That discount code has been used up.';
  }
  if (discount.amountOffMinor !== null) {
    if (discount.currency !== null && discount.currency !== input.currency) {
      return `That discount code only applies in ${discount.currency}.`;
    }
    if (discount.amountOffMinor >= input.amountMinor) {
      return 'That discount code is worth more than this plan costs, so it cannot be used here.';
    }
  }
  return null;
}

export interface BuildQuoteInput {
  readonly planId: string;
  readonly interval: BillingInterval;
  readonly currency: string;
  readonly prices: readonly PriceRecord[];
  readonly discount: DiscountRecord | null;
  readonly discountCode: string | null;
  /** The single effective tax for this purchase, or null when none is configured. */
  readonly tax: EffectiveTax | null;
  readonly now: string;
}

/**
 * The quote: price, then discount, then tax on what is left.
 *
 * The order is fixed and stated on the invoice, because "tax before discount"
 * and "tax after discount" are different totals and an invoice has to be
 * reproducible by whoever reads it later.
 */
export function buildQuote(input: BuildQuoteInput): PurchaseQuote {
  const currency = normalizeCurrency(input.currency);
  const price = resolvePrice(input.prices, input.planId, input.interval, currency);
  const unitAmountMinor = assertMinorAmount(price.amountMinor, 'price');

  let discountMinor = 0;
  let appliedCode: string | null = null;
  if (input.discountCode !== null && input.discountCode.trim() !== '') {
    const code = input.discountCode.trim().toUpperCase();
    // A discount whose code does not match the one asked for is not that code.
    const discount =
      input.discount !== null && input.discount.code === code ? input.discount : null;
    const refusal = discountRefusal(discount, {
      currency,
      now: input.now,
      amountMinor: unitAmountMinor,
    });
    if (refusal !== null) {
      throw new PaymentError('DISCOUNT_REFUSED', refusal, 409, { code });
    }
    // `discount` is non-null past this point: `discountRefusal` returns a message
    // for null, so a refusal was thrown above.
    const usable = discount as DiscountRecord;
    discountMinor =
      usable.amountOffMinor !== null
        ? Math.min(usable.amountOffMinor, unitAmountMinor)
        : applyPercent(unitAmountMinor, usable.percentOff);
    appliedCode = usable.code;
  }

  const subtotalMinor = Math.max(0, unitAmountMinor - discountMinor);
  const tax = input.tax;
  const taxMinor = tax === null ? 0 : applyRateBps(subtotalMinor, tax.rateBps);
  const totalMinor = subtotalMinor + taxMinor;

  return {
    planId: input.planId,
    interval: input.interval,
    currency,
    unitAmountMinor,
    discountCode: appliedCode,
    discountMinor,
    subtotalMinor,
    taxName: tax?.name ?? null,
    taxRateBps: tax?.rateBps ?? 0,
    taxMinor,
    totalMinor,
  };
}

/** The tax that applies to a purchase: the buyer's country, else the default row. */
export function effectiveTax(
  taxes: readonly TaxRecord[],
  country: string | null,
): EffectiveTax | null {
  const active = taxes.filter((tax) => tax.active);
  if (active.length === 0) return null;
  const code = country === null ? null : country.trim().toUpperCase();
  const specific = code === null ? undefined : active.find((tax) => tax.country === code);
  const chosen = specific ?? active.find((tax) => tax.country === null);
  if (chosen === undefined) return null;
  return { name: chosen.name, rateBps: chosen.rateBps };
}
