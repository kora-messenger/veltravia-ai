/**
 * Leases.
 *
 * A lease is a durable claim on one resource (an execution, a task) held by one
 * holder for a bounded time. Claim, renewal and release are single atomic store
 * operations, so two API instances cannot both advance the same execution even
 * though neither can see the other's memory.
 *
 * A lease is not a lock with a promise attached: it can expire while its holder
 * is alive but paused. That is deliberate, because the alternative is a crash
 * that blocks the resource forever. Every operation that takes a lease re-reads
 * the authoritative record before it writes, so losing a lease costs work, not
 * correctness.
 */

import { RELIABILITY_LIMITS, type LeaseRecord } from './types.js';

export interface LeaseStore {
  /** One atomic statement: insert, or take over an expired/released claim. */
  claim(input: {
    readonly ownerRef: string;
    readonly resource: string;
    readonly holder: string;
    readonly ttlMs: number;
    readonly note: string | null;
    readonly now: string;
  }): Promise<LeaseRecord | null>;
  renew(
    ownerRef: string,
    resource: string,
    holder: string,
    ttlMs: number,
    now: string,
  ): Promise<LeaseRecord | null>;
  /** Returns true only when this holder released a lease it actually held. */
  release(ownerRef: string, resource: string, holder: string, now: string): Promise<boolean>;
  get(ownerRef: string, resource: string): Promise<LeaseRecord | null>;
  list(
    ownerRef: string,
    filter: { readonly activeOnly?: boolean; readonly limit?: number },
  ): Promise<readonly LeaseRecord[]>;
}

export class LeaseCoordinator {
  constructor(
    private readonly store: LeaseStore,
    private readonly options: {
      readonly now: () => Date;
      readonly ttlMs?: number;
      readonly holder: string;
    },
  ) {}

  get ttlMs(): number {
    return this.options.ttlMs ?? RELIABILITY_LIMITS.leaseTtlMs;
  }

  get holder(): string {
    return this.options.holder;
  }

  claim(
    ownerRef: string,
    resource: string,
    options: { readonly note?: string | null; readonly ttlMs?: number } = {},
  ): Promise<LeaseRecord | null> {
    return this.store.claim({
      ownerRef,
      resource,
      holder: this.options.holder,
      ttlMs: options.ttlMs ?? this.ttlMs,
      note: options.note ?? null,
      now: this.options.now().toISOString(),
    });
  }

  renew(ownerRef: string, resource: string): Promise<LeaseRecord | null> {
    return this.store.renew(
      ownerRef,
      resource,
      this.options.holder,
      this.ttlMs,
      this.options.now().toISOString(),
    );
  }

  release(ownerRef: string, resource: string): Promise<boolean> {
    return this.store.release(ownerRef, resource, this.options.holder, this.options.now().toISOString());
  }

  /**
   * Run `work` while holding the lease. A lease that cannot be claimed means
   * another holder owns the resource right now, and the caller is told so
   * instead of doing the work twice.
   */
  async withLease<T>(
    ownerRef: string,
    resource: string,
    work: () => Promise<T>,
    options: { readonly note?: string | null } = {},
  ): Promise<{ readonly held: true; readonly value: T } | { readonly held: false }> {
    const claim = await this.claim(ownerRef, resource, options);
    if (claim === null) return { held: false };
    try {
      return { held: true, value: await work() };
    } finally {
      await this.release(ownerRef, resource).catch(() => false);
    }
  }
}

/** True when a lease can no longer be renewed because its time has passed. */
export function leaseExpired(lease: LeaseRecord, at: string): boolean {
  return lease.expiresAt <= at;
}
