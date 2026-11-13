/**
 * Windows (Step 59).
 *
 * A limit without a window is not a limit. Every window is computed in UTC, on
 * calendar boundaries where a calendar exists:
 *
 *  - `daily` is the UTC calendar day, midnight to midnight;
 *  - `weekly` is the UTC calendar week starting Monday;
 *  - `monthly` is the UTC calendar month;
 *  - `custom` is a fixed number of days aligned to an anchor instant, for a
 *    billing cycle that is not a calendar month.
 *
 * The window is half-open (`start <= t < end`) so a charge written at exactly
 * midnight belongs to one day and not both. `key` is the start instant: it is
 * what a warning is filed under, so "80% of the daily limit" fires once per day
 * and not once per request.
 */

import type { LimitPeriod, SpendWindow } from './types.js';

const DAY_MS = 86_400_000;

const PERIOD_LABEL: Record<LimitPeriod, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  custom: 'period',
};

function startOfUtcDay(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

function startOfUtcWeek(at: Date): number {
  const day = startOfUtcDay(at);
  // getUTCDay: 0 = Sunday. A week starts on Monday, so Sunday is day 6 of the
  // week that began six days earlier.
  const weekday = (at.getUTCDay() + 6) % 7;
  return day - weekday * DAY_MS;
}

function startOfUtcMonth(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

export interface WindowInput {
  readonly period: LimitPeriod;
  /** Required for `custom`; ignored otherwise. */
  readonly periodDays?: number | null;
  /** Alignment instant for `custom`; defaults to the Unix epoch. */
  readonly periodAnchor?: string | null;
}

/**
 * The window a moment falls in. `now` is an argument and never read from the
 * clock inside, so a test can walk a month, a week and a custom cycle exactly.
 */
export function windowFor(input: WindowInput, now: Date): SpendWindow {
  const at = now.getTime();
  if (!Number.isFinite(at)) {
    throw new RangeError('A spending window needs a real instant to sit in.');
  }

  if (input.period === 'daily') {
    const start = startOfUtcDay(now);
    return build(start, start + DAY_MS, 'daily');
  }
  if (input.period === 'weekly') {
    const start = startOfUtcWeek(now);
    return build(start, start + 7 * DAY_MS, 'weekly');
  }
  if (input.period === 'monthly') {
    const start = startOfUtcMonth(now);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    return build(start, end, 'monthly');
  }

  const days = input.periodDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new RangeError('A custom spending period must be 1 to 366 whole days.');
  }
  const anchor =
    input.periodAnchor === null || input.periodAnchor === undefined
      ? 0
      : Date.parse(input.periodAnchor);
  if (!Number.isFinite(anchor)) {
    throw new RangeError('A custom spending period needs a valid anchor instant.');
  }
  const span = days * DAY_MS;
  // Windows repeat forward and backward from the anchor, so a custom cycle that
  // began before the anchor still has a well-defined current window.
  const index = Math.floor((at - anchor) / span);
  const start = anchor + index * span;
  return build(start, start + span, 'custom', days);
}

function build(start: number, end: number, period: LimitPeriod, days?: number): SpendWindow {
  const startIso = new Date(start).toISOString();
  return {
    start: startIso,
    end: new Date(end).toISOString(),
    key: startIso,
    label: days === undefined ? PERIOD_LABEL[period] : `${days}-day period`,
  };
}

/** The window immediately before this one, for comparing two periods. */
export function previousWindow(window: SpendWindow, input: WindowInput): SpendWindow {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  return windowFor(input, new Date(start - (end - start)));
}

/** Milliseconds until the window closes; a UI says "resets in ...". */
export function millisUntilReset(window: SpendWindow, now: Date): number {
  return Math.max(0, Date.parse(window.end) - now.getTime());
}
