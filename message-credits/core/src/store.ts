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
  /** Credits and tokens grouped by one dimension, newest month first. */
  aggregate(
    ownerRef: string,
    dimension: UsageDimension,
    options?: { readonly since?: string; readonly workspaceId?: string | null },
  ): Promise<readonly UsageGroup[]>;
  readSettings(ownerRef: string, workspaceId: string | null): Promise<SpendingSettings | null>;
  saveSettings(settings: SpendingSettings): Promise<SpendingSettings>;
  /** Charges still holding credit, for the reservation sweep and the dashboard. */
  listOpen(ownerRef: string, limit: number): Promise<readonly MessageCharge[]>;
}

/** The id is derived once by the caller; this keeps drafts impossible to mistake. */
export type { MessageCharge, MessageChargeDraft };
