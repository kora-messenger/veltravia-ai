/**
 * The in-memory store.
 *
 * Same guarantees as the database one, for a deployment with no database and for
 * tests: compare-and-set on the version, one record per period, one event per
 * dedupe key. The check and the write happen in the same synchronous section -
 * no `await` between reading a version and writing it - because an in-memory
 * store that yields in the middle of a compare-and-set will happily let two
 * concurrent changes both win (this is exactly the class of bug Step 53 hit).
 */

import { seedPlans } from './plans.js';
import {
  SubscriptionConflictError,
  type AuditFilter,
  type EventFilter,
  type ListSubscriptionsOptions,
  type SubscriptionPeriodRecord,
  type SubscriptionStore,
} from './store.js';
import type {
  SubscriptionAuditRecord,
  SubscriptionEvent,
  SubscriptionPlanDefinition,
  SubscriptionRecord,
} from './types.js';

export interface InMemorySubscriptionStoreOptions {
  /** Seed the shipped catalogue. Defaults to true. */
  readonly seed?: boolean;
  readonly now?: () => string;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly plans = new Map<string, SubscriptionPlanDefinition>();
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly events: SubscriptionEvent[] = [];
  private readonly eventKeys = new Set<string>();
  private readonly periods = new Map<string, SubscriptionPeriodRecord>();
  private readonly audit: SubscriptionAuditRecord[] = [];
  /** Audit ids written at platform scope, kept out of an account's own history. */
  private readonly platformAuditIds = new Set<string>();

  constructor(options: InMemorySubscriptionStoreOptions = {}) {
    if (options.seed !== false) {
      for (const plan of seedPlans(options.now)) this.plans.set(plan.id, plan);
    }
  }

  async listPlans(): Promise<readonly SubscriptionPlanDefinition[]> {
    return [...this.plans.values()];
  }

  async readPlan(planId: string): Promise<SubscriptionPlanDefinition | null> {
    return this.plans.get(planId) ?? null;
  }

  async savePlan(plan: SubscriptionPlanDefinition): Promise<SubscriptionPlanDefinition> {
    const existing = this.plans.get(plan.id);
    const next: SubscriptionPlanDefinition = {
      ...plan,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? plan.createdAt,
    };
    this.plans.set(next.id, next);
    return next;
  }

  async readSubscription(ownerRef: string): Promise<SubscriptionRecord | null> {
    return this.subscriptions.get(ownerRef) ?? null;
  }

  async listSubscriptions(
    options: ListSubscriptionsOptions = {},
  ): Promise<readonly SubscriptionRecord[]> {
    const all = [...this.subscriptions.values()]
      .filter((record) => (options.planId === undefined ? true : record.planId === options.planId))
      .filter((record) => (options.status === undefined ? true : record.status === options.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const skip = Math.max(options.skip ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return all.slice(skip, skip + limit);
  }

  async saveSubscription(
    record: SubscriptionRecord,
    expectedVersion: number | null,
  ): Promise<SubscriptionRecord> {
    // No await between the read and the write: this section is the lock.
    const existing = this.subscriptions.get(record.ownerRef) ?? null;
    const currentVersion = existing?.version ?? null;
    if (currentVersion !== expectedVersion) throw new SubscriptionConflictError();
    if (
      existing !== null &&
      existing.planId !== record.planId &&
      record.version <= existing.version
    ) {
      throw new SubscriptionConflictError();
    }
    const stored: SubscriptionRecord = {
      ...record,
      id: existing?.id ?? record.id,
      createdAt: existing?.createdAt ?? record.createdAt,
    };
    this.subscriptions.set(stored.ownerRef, stored);
    return stored;
  }

  async appendEvent(event: SubscriptionEvent): Promise<{ readonly created: boolean }> {
    const key = `${event.ownerRef}|${event.dedupeKey}`;
    if (this.eventKeys.has(key)) return { created: false };
    this.eventKeys.add(key);
    this.events.push(event);
    return { created: true };
  }

  async listEvents(
    ownerRef: string,
    filter: EventFilter = {},
  ): Promise<readonly SubscriptionEvent[]> {
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    return this.events
      .filter((event) => event.ownerRef === ownerRef)
      .filter((event) => (filter.kind === undefined ? true : event.kind === filter.kind))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  async recordPeriod(entry: SubscriptionPeriodRecord): Promise<{ readonly created: boolean }> {
    const key = `${entry.ownerRef}|${entry.periodStart}`;
    if (this.periods.has(key)) return { created: false };
    this.periods.set(key, entry);
    return { created: true };
  }

  async listPeriods(ownerRef: string, limit = 24): Promise<readonly SubscriptionPeriodRecord[]> {
    return [...this.periods.values()]
      .filter((entry) => entry.ownerRef === ownerRef)
      .sort((a, b) => b.periodStart.localeCompare(a.periodStart))
      .slice(0, Math.min(Math.max(limit, 1), 100));
  }

  async appendAudit(
    record: SubscriptionAuditRecord,
    scope: 'owner' | 'platform' = 'owner',
  ): Promise<void> {
    if (scope === 'platform') this.platformAuditIds.add(record.id);
    this.audit.push(record);
  }

  async listAudit(
    ownerRef: string,
    filter: AuditFilter = {},
  ): Promise<readonly SubscriptionAuditRecord[]> {
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    return this.audit
      .filter((entry) => !this.platformAuditIds.has(entry.id))
      .filter((entry) => entry.ownerRef === ownerRef)
      .filter((entry) => (filter.action === undefined ? true : entry.action === filter.action))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  /** Catalogue change history, for the operator screen. */
  async listPlatformAudit(limit = 50): Promise<readonly SubscriptionAuditRecord[]> {
    return this.audit
      .filter((entry) => this.platformAuditIds.has(entry.id))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, Math.min(Math.max(limit, 1), 200));
  }
}
