/**
 * Totals, periods and breakdowns, computed from stored records.
 *
 * Every function here is pure and takes records that were already read from the
 * database. There is no counter that can drift away from its source, and nothing
 * is cached: a total the user sees is the sum of the rows that produce it, so a
 * reconciliation only has to fix rows.
 */

import type { UsageAdjustment, UsageCategory, UsageRecord } from './types.js';

export interface Window {
  /** Inclusive. */
  readonly from: string;
  /** Exclusive. */
  readonly to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function monthWindow(at: Date | string): Window {
  const date = typeof at === 'string' ? new Date(at) : at;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { from: start.toISOString(), to: end.toISOString() };
}

export function dayWindow(at: Date | string): Window {
  const date = typeof at === 'string' ? new Date(at) : at;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return { from: start.toISOString(), to: new Date(start.getTime() + DAY_MS).toISOString() };
}

export function lastNDays(at: Date | string, days: number): Window {
  const date = typeof at === 'string' ? new Date(at) : at;
  const end = new Date(date.getTime());
  return { from: new Date(end.getTime() - days * DAY_MS).toISOString(), to: end.toISOString() };
}

export function inWindow(record: { readonly occurredAt: string }, window: Window): boolean {
  return record.occurredAt >= window.from && record.occurredAt < window.to;
}

/** Records that never count toward a total, whatever the caller asked for. */
const EXCLUDED: ReadonlySet<UsageRecord['status']> = new Set(['excluded']);

export interface RecordFilter {
  readonly projectId?: string | null;
  readonly category?: UsageCategory;
  readonly window?: Window;
  /** `true` keeps only what is deducted from Veltravia allowances. */
  readonly allowanceOnly?: boolean;
  readonly environment?: UsageRecord['environment'];
}

export function selectRecords(
  records: readonly UsageRecord[],
  filter: RecordFilter = {},
): readonly UsageRecord[] {
  return records.filter((record) => {
    if (record.ownerRef === '') return false;
    if (EXCLUDED.has(record.status)) return false;
    if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
    if (filter.category !== undefined && record.category !== filter.category) return false;
    if (filter.environment !== undefined && record.environment !== filter.environment) return false;
    if (filter.window !== undefined && !inWindow(record, filter.window)) return false;
    // BYOK consumption belongs to the user's provider bill. It is shown, and it
    // is never taken out of an included Veltravia allowance.
    if (filter.allowanceOnly === true && record.costBearer === 'user_provider') return false;
    return true;
  });
}

export type CategoryTotals = Readonly<Record<UsageCategory, number>>;

export function emptyTotals(): CategoryTotals {
  return {
    database_storage: 0,
    backend_execution: 0,
    file_storage: 0,
    bandwidth: 0,
    hosting: 0,
    background_jobs: 0,
    realtime: 0,
    ai_provider: 0,
  };
}

export function totals(records: readonly UsageRecord[], filter: RecordFilter = {}): CategoryTotals {
  const out = { ...emptyTotals() } as Record<UsageCategory, number>;
  for (const record of selectRecords(records, filter)) {
    out[record.category] += record.quantity;
  }
  return out;
}

/** Adjustments are signed corrections, applied after the records they correct. */
export function applyAdjustments(
  base: CategoryTotals,
  adjustments: readonly UsageAdjustment[],
  filter: { readonly projectId?: string | null; readonly window?: Window } = {},
): CategoryTotals {
  const out = { ...base } as Record<UsageCategory, number>;
  for (const adjustment of adjustments) {
    if (filter.projectId !== undefined && adjustment.projectId !== filter.projectId) continue;
    if (
      filter.window !== undefined &&
      !inWindow({ occurredAt: adjustment.recordedAt }, filter.window)
    )
      continue;
    out[adjustment.category] += adjustment.quantity;
  }
  return out;
}

export interface Breakdown {
  readonly key: string;
  readonly totals: CategoryTotals;
  readonly records: number;
}

function groupBy(
  records: readonly UsageRecord[],
  keyOf: (record: UsageRecord) => string,
): readonly Breakdown[] {
  const groups = new Map<string, { totals: Record<UsageCategory, number>; records: number }>();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key) ?? {
      totals: { ...emptyTotals() } as Record<UsageCategory, number>,
      records: 0,
    };
    group.totals[record.category] += record.quantity;
    group.records += 1;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, value]) => ({
      key,
      totals: value.totals as CategoryTotals,
      records: value.records,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export const byProject = (records: readonly UsageRecord[]): readonly Breakdown[] =>
  groupBy(records, (record) => record.projectId ?? 'unattributed');

export const byOperation = (records: readonly UsageRecord[]): readonly Breakdown[] =>
  groupBy(records, (record) => `${record.category}:${record.operation}`);

export const byEnvironment = (records: readonly UsageRecord[]): readonly Breakdown[] =>
  groupBy(records, (record) => record.environment);

export const byCostBearer = (records: readonly UsageRecord[]): readonly Breakdown[] =>
  groupBy(records, (record) => record.costBearer);

/** One bucket per UTC day, oldest first, gaps included as zeros. */
export interface DailyPoint {
  readonly day: string;
  readonly totals: CategoryTotals;
  readonly records: number;
}

export function dailySeries(
  records: readonly UsageRecord[],
  window: Window,
): readonly DailyPoint[] {
  const start = new Date(window.from);
  const end = new Date(window.to);
  const points: DailyPoint[] = [];
  const index = new Map<string, number>();
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += DAY_MS) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    index.set(day, points.length);
    points.push({ day, totals: emptyTotals(), records: 0 });
  }
  for (const record of selectRecords(records, { window })) {
    const day = record.occurredAt.slice(0, 10);
    const at = index.get(day);
    if (at === undefined) continue;
    const point = points[at];
    if (point === undefined) continue;
    const mutable = point.totals as Record<UsageCategory, number>;
    mutable[record.category] += record.quantity;
    points[at] = { day: point.day, totals: point.totals, records: point.records + 1 };
  }
  return points;
}

/** Money is summed separately, and only where a cost is actually known. */
export interface CostTotals {
  readonly infrastructureUsd: number;
  readonly providerUsd: number;
  readonly byokProviderUsd: number;
  readonly recordsWithoutCost: number;
}

export function costTotals(records: readonly UsageRecord[]): CostTotals {
  let infrastructureUsd = 0;
  let providerUsd = 0;
  let byokProviderUsd = 0;
  let recordsWithoutCost = 0;
  for (const record of selectRecords(records)) {
    const cost = record.costUsd;
    if (cost === null) {
      // Only a provider record is expected to carry a cost at all; an
      // infrastructure record with no price table is not a zero, it is unknown.
      if (record.costClass === 'provider') recordsWithoutCost += 1;
      continue;
    }
    if (record.costClass === 'infrastructure') infrastructureUsd += cost;
    else if (record.costBearer === 'user_provider') byokProviderUsd += cost;
    else providerUsd += cost;
  }
  return { infrastructureUsd, providerUsd, byokProviderUsd, recordsWithoutCost };
}
