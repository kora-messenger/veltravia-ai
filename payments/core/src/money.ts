/**
 * Money, in integers.
 *
 * Every amount in this package is a whole number of **minor units** (kobo,
 * cents, pesewas). A float amount is not stored, not compared and not sent over
 * the wire, because `0.1 + 0.2` is not a price and a provider that rounds
 * differently would turn a comparison into a guess.
 *
 * The three providers this build ships disagree on the unit their API expects:
 * Paystack takes minor units, Flutterwave and Monnify take major units as a
 * decimal. That difference is a property of the adapter and is converted in
 * exactly one place (`providers.ts`), never at a call site.
 */

/** Currencies whose minor unit is 1/100. Every currency this build quotes today. */
const TWO_DECIMAL = new Set([
  'NGN',
  'USD',
  'EUR',
  'GBP',
  'GHS',
  'KES',
  'ZAR',
  'CAD',
  'AUD',
  'INR',
  'AED',
  'EGP',
  'XOF',
]);

/** Currencies with no minor unit at all. Listed rather than assumed to be 100. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'XAF', 'CLP', 'VND']);

export function isSupportedCurrency(code: string): boolean {
  return TWO_DECIMAL.has(code) || ZERO_DECIMAL.has(code);
}

/** How many minor units make one major unit. 100 for kobo, 1 for yen. */
export function minorUnitFactor(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 1;
  return 100;
}

export class MoneyError extends Error {
  readonly code = 'MONEY_INVALID';
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** A currency code as ISO 4217 writes it: three upper-case letters. */
export function normalizeCurrency(input: unknown): string {
  if (typeof input !== 'string') {
    throw new MoneyError('A currency code is required.');
  }
  const code = input.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new MoneyError('A currency code is three letters, such as NGN.');
  }
  return code;
}

/** An amount in minor units: a non-negative safe integer. */
export function assertMinorAmount(value: unknown, label = 'amount'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MoneyError(`The ${label} must be a whole number of minor units, 0 or more.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`The ${label} is too large to charge safely.`);
  }
  return value;
}

/**
 * The decimal string a major-unit provider expects, for example `2500` minor
 * units of NGN becomes `"25.00"`. A zero-decimal currency stays a whole number.
 */
export function toMajorUnitsString(minor: number, currency: string): string {
  assertMinorAmount(minor, 'amount');
  const factor = minorUnitFactor(currency);
  if (factor === 1) return String(minor);
  const whole = Math.floor(minor / factor);
  const fraction = minor % factor;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Reads a provider's major-unit value (a string or a number) back into minor
 * units. Refuses anything with more precision than the currency has, rather than
 * rounding: a provider quoting `25.005` is not a price this build can verify.
 */
export function fromMajorUnits(value: unknown, currency: string): number {
  const factor = minorUnitFactor(currency);
  const raw =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? String(value)
        : ''
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (raw === '') throw new MoneyError('The provider did not state an amount.');
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new MoneyError('The provider stated an amount this build cannot read.');
  }
  const [wholePart, fractionPart = ''] = raw.split('.');
  if (factor === 1 && fractionPart.replace(/0/g, '') !== '') {
    throw new MoneyError(`The provider stated a fractional amount in ${currency}.`);
  }
  const digits = factor === 1 ? 0 : 2;
  if (fractionPart.length > digits && fractionPart.slice(digits).replace(/0/g, '') !== '') {
    throw new MoneyError(`The provider stated more decimal places than ${currency} has.`);
  }
  const whole = Number(wholePart ?? '0');
  const fraction = Number((fractionPart.slice(0, digits) || '').padEnd(digits, '0') || '0');
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) {
    throw new MoneyError('The provider stated an amount this build cannot read.');
  }
  return whole * factor + fraction;
}

/**
 * A charge amount as a person reads it. Used by invoices, receipts and the
 * billing screen; never used to decide anything.
 */
export function formatAmount(minor: number, currency: string): string {
  const factor = minorUnitFactor(currency);
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / factor);
  const fraction = absolute % factor;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (factor === 1) return `${sign}${grouped} ${currency}`;
  return `${sign}${grouped}.${String(fraction).padStart(2, '0')} ${currency}`;
}

/** Basis points (1 / 100th of a percent) applied to an amount, rounded half up. */
export function applyRateBps(amountMinor: number, rateBps: number): number {
  assertMinorAmount(amountMinor, 'amount');
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new MoneyError('A tax rate is between 0 and 10,000 basis points.');
  }
  // Integer arithmetic on purpose: no float ever touches a charge.
  return Math.floor((amountMinor * rateBps + 5_000) / 10_000);
}

/** A percentage discount, rounded down so a discount never exceeds its share. */
export function applyPercent(amountMinor: number, percent: number): number {
  assertMinorAmount(amountMinor, 'amount');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new MoneyError('A percentage discount is between 0 and 100.');
  }
  return Math.floor((amountMinor * percent) / 100);
}
