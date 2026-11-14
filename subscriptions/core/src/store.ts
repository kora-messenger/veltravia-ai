/**
 * Where subscriptions are kept.
 *
 * The port is small on purpose. It owns no money, no ledger and no usage: it
 * stores plans, the subscription on each account, the periods that have been
 * processed, and the event and audit history. Everything that decides *what a
 * plan means* is a pure function over what is read from here.
 *
 * Two write guarantees the implementations must honour, because the caller
 * cannot provide them:
 *
 *  - **Compare-and-set.** `saveSubscription` names the version it read. A stale
 *    version is refused (`SubscriptionConflictError`) rather than merged, so two
 *    simultaneous changes cannot both win.
 *  - **One record per period.** `recordPeriod` is unique per `(owner, period
 *    start)`, so a retried renewal job cannot advance a period twice. It reports
 *    whether it created the row, which is what decides whether to notify.
 */

import type {
  SubscriptionAuditAction,
  SubscriptionAuditRecord,
  SubscriptionEvent,
  SubscriptionEventKind,
  SubscriptionPlanDefinition,
  SubscriptionRecord,
} from './types.js';

/** One month that has been processed for an account. Never edited. */
export interface SubscriptionPeriodRecord {
  readonly ownerRef: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly planId: string;
  readonly messageCredits: number;
  readonly integrationCredits: number;
  /** `assignment` opens a subscription, `renewal` advances one. */
  readonly kind: 'assignment' | 'renewal';
  readonly processedAt: string;
  readonly actor: string;
}

export interface ListSubscriptionsOptions {
  readonly planId?: string;
  readonly status?: string;
  readonly limit?: number;
  readonly skip?: number;
}

export interface EventFilter {
  readonly kind?: SubscriptionEventKind;
  readonly limit?: number;
}

export interface AuditFilter {
  readonly action?: SubscriptionAuditAction;
  readonly limit?: number;
}

export interface SubscriptionStore {
  /** Every plan, active or not. Global configuration, not per-owner data. */
  listPlans(): Promise<readonly SubscriptionPlanDefinition[]>;
  readPlan(planId: string): Promise<SubscriptionPlanDefinition | null>;
  /** Inserts or replaces a plan row, bumped to `version + 1` by the store. */
  savePlan(plan: SubscriptionPlanDefinition): Promise<SubscriptionPlanDefinition>;

  readSubscription(ownerRef: string): Promise<SubscriptionRecord | null>;
  listSubscriptions(options?: ListSubscriptionsOptions): Promise<readonly SubscriptionRecord[]>;
  /**
   * Writes the record only when the stored version still equals
   * `expectedVersion`. `null` means "there must be no row yet".
   */
  saveSubscription(
    record: SubscriptionRecord,
    expectedVersion: number | null,
  ): Promise<SubscriptionRecord>;

  appendEvent(event: SubscriptionEvent): Promise<{ readonly created: boolean }>;
  listEvents(ownerRef: string, filter?: EventFilter): Promise<readonly SubscriptionEvent[]>;

  recordPeriod(entry: SubscriptionPeriodRecord): Promise<{ readonly created: boolean }>;
  listPeriods(ownerRef: string, limit?: number): Promise<readonly SubscriptionPeriodRecord[]>;

  /**
   * Append-only. `scope` separates the catalogue's own history (platform) from an
   * account's history (owner), so an operator reading a person's record does not
   * find catalogue edits mixed into it.
   */
  appendAudit(record: SubscriptionAuditRecord, scope?: 'owner' | 'platform'): Promise<void>;
  listAudit(ownerRef: string, filter?: AuditFilter): Promise<readonly SubscriptionAuditRecord[]>;
}

export class SubscriptionConflictError extends Error {
  readonly code = 'SUBSCRIPTION_CONFLICT';
  readonly status = 409;

  constructor(
    message = 'This subscription changed while you were editing it. Reload and try again.',
  ) {
    super(message);
    this.name = 'SubscriptionConflictError';
  }
}
