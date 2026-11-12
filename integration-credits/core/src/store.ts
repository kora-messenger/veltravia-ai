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
  /** Credits allowed for one operation. Null = no limit. */
  readonly perOperationLimit: number | null;
  readonly updatedAt: string;
}

export type UsageDimension = 'integration' | 'connector' | 'operation' | 'project' | 'billingClass';

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
  listOpenOwners(limit: number): Promise<readonly string[]>;
}

/** The id is derived once by the caller; this keeps drafts impossible to mistake. */
export type { IntegrationCharge, IntegrationChargeDraft };
