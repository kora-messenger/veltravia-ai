/**
 * Where charges are kept (Step 54).
 *
 * The charge row is the audit of one interaction: who, where, which model, what
 * was measured, what was charged, and what could not be measured. The wallet
 * ledger stays the authority on money; this table is the story behind each
 * ledger entry and the source of the dashboard's groupings.
 *
 * `saveCharge` is compare-and-set on the state, so two settlements arriving at
 * once cannot both win: the loser re-reads and sees the winner's state.
 */

import type { ChargeFilter, MessageCharge, MessageChargeDraft, UsageGroup } from './types.js';

export interface ChargePage {
  readonly charges: readonly MessageCharge[];
  readonly total: number;
}

export interface SpendingSettings {
  readonly ownerRef: string;
  readonly workspaceId: string | null;
  /** Credits allowed per calendar month across message charges. Null = no limit. */
  readonly monthlyLimit: number | null;
  /** Credits allowed for one interaction. Null = no limit. */
  readonly perRequestLimit: number | null;
  readonly updatedAt: string;
}

export type UsageDimension = 'model' | 'project' | 'conversation' | 'kind';

/**
 * Usage inside one spent window (Step 59), grouped by interaction kind.
 *
 * This is the read a spending limit needs and the dashboard's `aggregate` is
 * not: holds count here, because credit promised to work in flight must reduce
 * what the next operation may spend, and refunded credit is reported apart
 * instead of being folded back into `committed` where it could be counted
 * twice.
 */
export interface LimitUsageGroup {
  readonly key: string;
  /** Settled charges created in the window. Refunded rows are not in here. */
  readonly committed: number;
  /** Credit still held by charges created in the window. */
  readonly reserved: number;
  /** Credit refunded on charges created in the window. */
  readonly refunded: number;
  readonly charges: number;
}

export interface LimitUsageOptions {
  readonly since: string;
  readonly until: string;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
}

export interface MessageCreditStore {
  readonly kind: 'memory' | 'postgres';
  /**
   * Writes the charge once. A second insert with the same idempotency key
   * returns the first row with `created: false`, which is what makes a retried
   * request free.
   */
  insertCharge(
    charge: MessageCharge,
  ): Promise<{ readonly charge: MessageCharge; readonly created: boolean }>;
  findByKey(ownerRef: string, idempotencyKey: string): Promise<MessageCharge | null>;
  findById(ownerRef: string, chargeId: string): Promise<MessageCharge | null>;
  /** Compare-and-set: false means the row moved on and the caller must re-read. */
  saveCharge(charge: MessageCharge, expectedState: MessageCharge['state']): Promise<boolean>;
  listCharges(ownerRef: string, filter: ChargeFilter): Promise<ChargePage>;
  /** Credit per interaction kind inside a window, holds included. */
  limitUsage(ownerRef: string, options: LimitUsageOptions): Promise<readonly LimitUsageGroup[]>;
  /**
   * Credit held right now by work in flight (Step 59). One number, one query:
   * a reserved-credits ceiling must not depend on paging the whole month.
   */
  heldCredits(ownerRef: string): Promise<number>;
  /** Credits and tokens grouped by one dimension, newest month first. */
  aggregate(
    ownerRef: string,
    dimension: UsageDimension,
    options?: { readonly since?: string; readonly workspaceId?: string | null },
  ): Promise<readonly UsageGroup[]>;
  readSettings(ownerRef: string, workspaceId: string | null): Promise<SpendingSettings | null>;
  saveSettings(settings: SpendingSettings): Promise<SpendingSettings>;
  /** Charges still holding credit, for the reservation sweep and the dashboard. */
  listOpen(ownerRef: string, limit: number): Promise<readonly MessageCharge[]>; /**
   * Runs `fn` with this owner's spending decision serialised (Step 59).
   *
   * A limit is a read-then-write: read what has been spent, decide, then take a
   * hold. Without a guard, eight simultaneous requests all read the same
   * untouched allowance and all pass. This makes that section one at a time per
   * owner - an advisory lock in Postgres, a promise chain in memory - so the
   * check and the hold it authorises cannot interleave.
   */
  withOwnerGuard<T>(ownerRef: string, fn: () => Promise<T>): Promise<T>;
}

/** The id is derived once by the caller; this keeps drafts impossible to mistake. */
export type { MessageCharge, MessageChargeDraft };
