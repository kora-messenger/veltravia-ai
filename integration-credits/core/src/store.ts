/**
 * Where integration charges are kept (Step 56).
 *
 * The charge row is the audit of one external operation: who, where, which
 * integration, connector and operation, what was measured, what was charged and
 * what could not be measured. The wallet ledger stays the authority on money;
 * this table is the story behind each ledger entry and the source of the
 * dashboard's groupings.
 *
 * `saveCharge` is compare-and-set on the state, so two settlements arriving at
 * once cannot both win: the loser re-reads and sees the winner's state.
 */

import type {
  ChargeFilter,
  IntegrationCharge,
  IntegrationChargeDraft,
  UsageGroup,
} from './types.js';

export interface ChargePage {
  readonly charges: readonly IntegrationCharge[];
  readonly total: number;
}

export interface IntegrationSpendingSettings {
  readonly ownerRef: string;
  readonly workspaceId: string | null;
  /** Credits allowed per calendar month across integration charges. Null = no limit. */
  readonly monthlyLimit: number | null;
  /**
   * Where that ceiling came from: set by the account itself, or taken from the
   * plan it is on. Absent on a stored row, which is always the account's own.
   */
  readonly monthlyLimitSource?: 'owner' | 'plan';
  /** Credits allowed for one operation. Null = no limit. */
  readonly perOperationLimit: number | null;
  readonly updatedAt: string;
}

export type UsageDimension = 'integration' | 'connector' | 'operation' | 'project' | 'billingClass';

/** Usage inside one spent window (Step 59), grouped by operation kind. */
export interface LimitUsageGroup {
  readonly key: string;
  readonly committed: number;
  readonly reserved: number;
  readonly refunded: number;
  readonly charges: number;
}

export interface LimitUsageOptions {
  readonly since: string;
  readonly until: string;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
}

export interface IntegrationCreditStore {
  readonly kind: 'memory' | 'postgres';
  /**
   * Writes the charge once. A second insert with the same idempotency key
   * returns the first row with `created: false`, which is what makes a retried
   * operation free.
   */
  insertCharge(
    charge: IntegrationCharge,
  ): Promise<{ readonly charge: IntegrationCharge; readonly created: boolean }>;
  findByKey(ownerRef: string, idempotencyKey: string): Promise<IntegrationCharge | null>;
  findById(ownerRef: string, chargeId: string): Promise<IntegrationCharge | null>;
  /** Compare-and-set: false means the row moved on and the caller must re-read. */
  saveCharge(
    charge: IntegrationCharge,
    expectedState: IntegrationCharge['state'],
  ): Promise<boolean>;
  listCharges(ownerRef: string, filter: ChargeFilter): Promise<ChargePage>;
  /** Credit per operation kind inside a window, holds included. */
  limitUsage(ownerRef: string, options: LimitUsageOptions): Promise<readonly LimitUsageGroup[]>;
  /** Credit held right now by work in flight (Step 59). */
  heldCredits(ownerRef: string): Promise<number>;
  /** Credits and requests grouped by one dimension. */
  aggregate(
    ownerRef: string,
    dimension: UsageDimension,
    options?: { readonly since?: string; readonly workspaceId?: string | null },
  ): Promise<readonly UsageGroup[]>;
  readSettings(
    ownerRef: string,
    workspaceId: string | null,
  ): Promise<IntegrationSpendingSettings | null>;
  saveSettings(settings: IntegrationSpendingSettings): Promise<IntegrationSpendingSettings>;
  /** Charges still holding credit, for the sweep and the dashboard. */
  listOpen(ownerRef: string, limit: number): Promise<readonly IntegrationCharge[]>;
  /**
   * The accounts that still hold credit, oldest hold first.
   *
   * A scheduled sweep has no request owner, so it cannot ask "my open charges"
   * the way a route does. It asks this instead, then releases each account's
   * expired holds inside that account's own scope. Only the keys are returned:
   * the sweep never reads another owner's charge rows across owners.
   */
  listOpenOwners(limit: number): Promise<readonly string[]>; /**
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
export type { IntegrationCharge, IntegrationChargeDraft };
