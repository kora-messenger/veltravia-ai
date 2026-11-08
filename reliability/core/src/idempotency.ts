/**
 * Idempotency.
 *
 * A request that names a key gets exactly one operation per (owner, scope, key).
 * The rules, in the order they apply:
 *
 *  - a key the owner has never used, or one whose retention has passed, claims a
 *    new operation;
 *  - the same key with a different request body is a conflict, never a silent
 *    replay of the other request's result;
 *  - the same key with the same body whose operation finished replays the stored
 *    response and status;
 *  - the same key while the first attempt is still running is a refusal: the
 *    caller must not guess whether the work happened;
 *  - an attempt that recorded a failure, or an in-flight record older than the
 *    stale window, may be reclaimed, and the new attempt is a new operation id.
 *
 * The key is scoped to the owner as well as the route, so one owner's key can
 * never address another owner's operation.
 */

import { createHash } from 'node:crypto';

import { RELIABILITY_LIMITS, type IdempotencyRecord } from './types.js';

export interface IdempotencyClaim {
  readonly ownerRef: string;
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly operationId: string;
  readonly at: string;
  readonly expiresAt: string;
}

export interface IdempotencyStore {
  /** Insert-only: a second insert of the same (owner, scope, key) is refused. */
  insert(record: IdempotencyRecord): Promise<boolean>;
  /**
   * Atomically take over a record that is expired, failed, or abandoned
   * in-flight. Returns false when none of those hold, which is the case that
   * must stay a refusal.
   */
  reclaim(record: IdempotencyRecord, options: { readonly now: string; readonly staleMs: number }): Promise<boolean>;
  get(ownerRef: string, scope: string, key: string): Promise<IdempotencyRecord | null>;
  complete(
    ownerRef: string,
    scope: string,
    key: string,
    operationId: string,
    response: { readonly status: number; readonly body: unknown },
    at: string,
  ): Promise<boolean>;
  fail(
    ownerRef: string,
    scope: string,
    key: string,
    operationId: string,
    failure: { readonly code: string; readonly message: string },
    at: string,
  ): Promise<boolean>;
  list(
    ownerRef: string,
    filter: { readonly scope?: string; readonly status?: readonly IdempotencyRecord['status'][]; readonly limit?: number },
  ): Promise<readonly IdempotencyRecord[]>;
}

export type IdempotencyOutcome =
  | { readonly outcome: 'claimed'; readonly record: IdempotencyRecord }
  | { readonly outcome: 'replay'; readonly record: IdempotencyRecord }
  | { readonly outcome: 'conflict'; readonly record: IdempotencyRecord }
  | { readonly outcome: 'in_flight'; readonly record: IdempotencyRecord };

/**
 * A stable fingerprint of a request body. Key order must not change it, or the
 * same request retried by a client that serialises differently would look like a
 * different request and be refused.
 */
export function fingerprintRequest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

/** Keys are opaque but not unbounded: a long key would be a storage abuse vector. */
export function normaliseKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > 200) return null;
  return key;
}

export class IdempotencyGuard {
  constructor(
    private readonly store: IdempotencyStore,
    private readonly options: {
      readonly now: () => Date;
      readonly retentionMs?: number;
      readonly inFlightMs?: number;
      readonly newOperationId: () => string;
    },
  ) {}

  private get retentionMs(): number {
    return this.options.retentionMs ?? RELIABILITY_LIMITS.idempotencyRetentionMs;
  }

  private get inFlightMs(): number {
    return this.options.inFlightMs ?? RELIABILITY_LIMITS.idempotencyInFlightMs;
  }

  /** Decide what a keyed request is allowed to do. */
  async begin(input: {
    readonly ownerRef: string;
    readonly scope: string;
    readonly key: string;
    readonly fingerprint: string;
  }): Promise<IdempotencyOutcome> {
    const now = this.options.now();
    const at = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.retentionMs).toISOString();
    const record: IdempotencyRecord = {
      ownerRef: input.ownerRef,
      scope: input.scope,
      key: input.key,
      fingerprint: input.fingerprint,
      status: 'in_progress',
      operationId: this.options.newOperationId(),
      response: null,
      failure: null,
      createdAt: at,
      updatedAt: at,
      expiresAt,
    };
    if (await this.store.insert(record)) return { outcome: 'claimed', record };

    const existing = await this.store.get(input.ownerRef, input.scope, input.key);
    if (existing === null) {
      // Insert lost the race and the row is already gone (expired retention
      // sweep). One more attempt, then the caller gets the refusal.
      if (await this.store.insert(record)) return { outcome: 'claimed', record };
      return { outcome: 'in_flight', record };
    }

    const expired = existing.expiresAt <= at;
    if (existing.fingerprint !== input.fingerprint) {
      // A different request under the same key is always a refusal, even if the
      // old record has expired: reusing a key for other work hides a bug.
      return { outcome: 'conflict', record: existing };
    }
    if (existing.status === 'completed' && !expired) {
      return { outcome: 'replay', record: existing };
    }
    const reclaimable =
      expired ||
      existing.status === 'failed' ||
      (existing.status === 'in_progress' &&
        Date.parse(existing.updatedAt) <= now.getTime() - this.inFlightMs);
    if (!reclaimable) return { outcome: 'in_flight', record: existing };

    const reclaimed = await this.store.reclaim(record, {
      now: at,
      staleMs: this.inFlightMs,
    });
    if (reclaimed) return { outcome: 'claimed', record };
    const current = await this.store.get(input.ownerRef, input.scope, input.key);
    if (current === null) return { outcome: 'in_flight', record };
    return current.status === 'completed' && current.expiresAt > at
      ? { outcome: 'replay', record: current }
      : { outcome: 'in_flight', record: current };
  }

  /** Store what the operation answered, so a retry gets the same answer. */
  async complete(
    claim: IdempotencyRecord,
    response: { readonly status: number; readonly body: unknown },
  ): Promise<void> {
    await this.store.complete(
      claim.ownerRef,
      claim.scope,
      claim.key,
      claim.operationId,
      response,
      this.options.now().toISOString(),
    );
  }

  /**
   * Record a failure so the same key may be retried. The operation's own guards
   * decide whether anything was in fact applied; this only stops the key from
   * blocking a client that has no way to move forward.
   */
  async fail(
    claim: IdempotencyRecord,
    failure: { readonly code: string; readonly message: string },
  ): Promise<void> {
    await this.store.fail(
      claim.ownerRef,
      claim.scope,
      claim.key,
      claim.operationId,
      failure,
      this.options.now().toISOString(),
    );
  }
}
