/**
 * In-memory implementations of the three reliability stores.
 *
 * They exist so the same code runs in tests and in a deployment without a
 * database, and so the API can say plainly that its coordination is
 * per-process. They are not a production coordination mechanism: two API
 * instances each have their own.
 */

import type { IdempotencyStore } from './idempotency.js';
import type { EventInboxStore } from './inbox.js';
import type { LeaseStore } from './leases.js';
import type { IdempotencyRecord, InboxEvent, LeaseRecord } from './types.js';

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  private id(owner: string, scope: string, key: string): string {
    return `${owner}\u0000${scope}\u0000${key}`;
  }

  async insert(record: IdempotencyRecord): Promise<boolean> {
    const id = this.id(record.ownerRef, record.scope, record.key);
    if (this.records.has(id)) return false;
    this.records.set(id, record);
    return true;
  }

  async reclaim(
    record: IdempotencyRecord,
    options: { readonly now: string; readonly staleMs: number },
  ): Promise<boolean> {
    const id = this.id(record.ownerRef, record.scope, record.key);
    const existing = this.records.get(id);
    if (existing === undefined) return false;
    const stale =
      existing.status === 'in_progress' &&
      Date.parse(existing.updatedAt) <= Date.parse(options.now) - options.staleMs;
    const claimable = existing.expiresAt <= options.now || existing.status === 'failed' || stale;
    if (!claimable) return false;
    this.records.set(id, record);
    return true;
  }

  async get(ownerRef: string, scope: string, key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(this.id(ownerRef, scope, key)) ?? null;
  }

  private async settle(
    ownerRef: string,
    scope: string,
    key: string,
    operationId: string,
    patch: Partial<IdempotencyRecord>,
    at: string,
  ): Promise<boolean> {
    const id = this.id(ownerRef, scope, key);
    const existing = this.records.get(id);
    // Only the attempt that still owns the key may write its outcome; a
    // reclaimed key belongs to a newer operation.
    if (existing === undefined || existing.operationId !== operationId) return false;
    this.records.set(id, { ...existing, ...patch, updatedAt: at });
    return true;
  }

  complete(
    ownerRef: string,
    scope: string,
    key: string,
    operationId: string,
    response: { readonly status: number; readonly body: unknown },
    at: string,
  ): Promise<boolean> {
    return this.settle(ownerRef, scope, key, operationId, { status: 'completed', response }, at);
  }

  fail(
    ownerRef: string,
    scope: string,
    key: string,
    operationId: string,
    failure: { readonly code: string; readonly message: string },
    at: string,
  ): Promise<boolean> {
    return this.settle(ownerRef, scope, key, operationId, { status: 'failed', failure }, at);
  }

  async list(
    ownerRef: string,
    filter: {
      readonly scope?: string;
      readonly status?: readonly IdempotencyRecord['status'][];
      readonly limit?: number;
    },
  ): Promise<readonly IdempotencyRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.ownerRef === ownerRef)
      .filter((record) => filter.scope === undefined || record.scope === filter.scope)
      .filter((record) => filter.status === undefined || filter.status.includes(record.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.min(Math.max(filter.limit ?? 100, 1), 500));
  }
}

export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, LeaseRecord>();

  private id(owner: string, resource: string): string {
    return `${owner}\u0000${resource}`;
  }

  async claim(input: {
    readonly ownerRef: string;
    readonly resource: string;
    readonly holder: string;
    readonly ttlMs: number;
    readonly note: string | null;
    readonly now: string;
  }): Promise<LeaseRecord | null> {
    const id = this.id(input.ownerRef, input.resource);
    const existing = this.leases.get(id);
    const free =
      existing === undefined || existing.releasedAt !== null || existing.expiresAt <= input.now;
    if (!free) return null;
    const record: LeaseRecord = {
      ownerRef: input.ownerRef,
      resource: input.resource,
      holder: input.holder,
      acquiredAt: input.now,
      renewedAt: input.now,
      expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
      releasedAt: null,
      note: input.note,
    };
    this.leases.set(id, record);
    return record;
  }

  async renew(
    ownerRef: string,
    resource: string,
    holder: string,
    ttlMs: number,
    now: string,
  ): Promise<LeaseRecord | null> {
    const id = this.id(ownerRef, resource);
    const existing = this.leases.get(id);
    if (existing === undefined || existing.holder !== holder || existing.releasedAt !== null) {
      return null;
    }
    const renewed: LeaseRecord = {
      ...existing,
      renewedAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    this.leases.set(id, renewed);
    return renewed;
  }

  async release(ownerRef: string, resource: string, holder: string, now: string): Promise<boolean> {
    const id = this.id(ownerRef, resource);
    const existing = this.leases.get(id);
    if (existing === undefined || existing.holder !== holder || existing.releasedAt !== null) {
      return false;
    }
    this.leases.set(id, { ...existing, releasedAt: now });
    return true;
  }

  async get(ownerRef: string, resource: string): Promise<LeaseRecord | null> {
    return this.leases.get(this.id(ownerRef, resource)) ?? null;
  }

  async list(
    ownerRef: string,
    filter: { readonly activeOnly?: boolean; readonly limit?: number },
  ): Promise<readonly LeaseRecord[]> {
    return [...this.leases.values()]
      .filter((lease) => lease.ownerRef === ownerRef)
      .filter((lease) => filter.activeOnly !== true || lease.releasedAt === null)
      .sort((left, right) => right.renewedAt.localeCompare(left.renewedAt))
      .slice(0, Math.min(Math.max(filter.limit ?? 100, 1), 500));
  }
}

export class InMemoryEventInbox implements EventInboxStore {
  private readonly events = new Map<string, InboxEvent>();

  private id(owner: string, key: string): string {
    return `${owner}\u0000${key}`;
  }

  async receive(event: InboxEvent): Promise<boolean> {
    const id = this.id(event.ownerRef, event.eventKey);
    // Insert-only, like the database. Whether a failed event may run again is
    // decided by its retry time and attempt count, not by taking the key twice.
    if (this.events.has(id)) return false;
    this.events.set(id, event);
    return true;
  }

  async markProcessed(ownerRef: string, eventKey: string, at: string): Promise<void> {
    const id = this.id(ownerRef, eventKey);
    const existing = this.events.get(id);
    if (existing === undefined) return;
    this.events.set(id, {
      ...existing,
      status: 'processed',
      processedAt: at,
      attempts: existing.attempts + 1,
      availableAt: at,
    });
  }

  async markFailed(
    ownerRef: string,
    eventKey: string,
    error: string,
    availableAt: string,
    _at: string,
  ): Promise<void> {
    const id = this.id(ownerRef, eventKey);
    const existing = this.events.get(id);
    if (existing === undefined) return;
    this.events.set(id, {
      ...existing,
      status: 'failed',
      lastError: error,
      attempts: existing.attempts + 1,
      availableAt,
      processedAt: null,
    });
  }

  async get(ownerRef: string, eventKey: string): Promise<InboxEvent | null> {
    return this.events.get(this.id(ownerRef, eventKey)) ?? null;
  }

  async due(
    ownerRef: string,
    options: { readonly at: string; readonly limit?: number },
  ): Promise<readonly InboxEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.ownerRef === ownerRef)
      .filter((event) => event.status === 'failed')
      .filter((event) => event.availableAt <= options.at)
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt))
      .slice(0, Math.min(Math.max(options.limit ?? 20, 1), 100));
  }

  async list(
    ownerRef: string,
    filter: {
      readonly status?: readonly InboxEvent['status'][];
      readonly topic?: string;
      readonly limit?: number;
    },
  ): Promise<readonly InboxEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.ownerRef === ownerRef)
      .filter((event) => filter.status === undefined || filter.status.includes(event.status))
      .filter((event) => filter.topic === undefined || event.topic === filter.topic)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, Math.min(Math.max(filter.limit ?? 100, 1), 500));
  }
}
