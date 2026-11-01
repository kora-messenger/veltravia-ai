/**
 * Multiple keys per connection (Step 36).
 *
 * A provider key is a bucket of quota, not a switch. Free tiers meter per key
 * per model, so one exhausted key should hand the next request to another key
 * instead of failing the run - which is exactly what a single `credentialRef`
 * could not do.
 *
 * This module is pure bookkeeping over a connection's key list: no vault, no
 * transport, no I/O. The gateway reads a key's plaintext only for the attempt
 * that uses it, so a rotation never widens the window in which a secret exists.
 *
 * Rules that matter:
 *   - a key that hit a rate limit COOLS for the wait the provider asked for
 *     (or a conservative minute when it did not), then returns on its own;
 *   - a key the provider rejects as unauthenticated is retired (`invalid`) and
 *     never spent again until an operator re-validates it;
 *   - selection prefers the key used least recently, so one key does not carry
 *     the whole load while another stays idle;
 *   - when every key is cooling, selection still returns them, soonest-to-reset
 *     first: the caller then waits honestly instead of pretending there is none.
 */

export type KeyStatus = 'active' | 'cooling' | 'invalid';

/** One key on a connection. Contains no secret - only a mask and a reference. */
export interface ConnectionKey {
  readonly id: string;
  /** Vault reference to the encrypted secret. Not the secret. */
  readonly ref: string;
  /** Masked hint (last 4 characters), safe to display. */
  readonly hint: string;
  /** Owner-scoped digest, used only to refuse the same key twice. */
  readonly fingerprint: string;
  readonly label?: string;
  readonly status: KeyStatus;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  /** When a cooling key becomes usable again. */
  readonly cooldownUntil?: string;
  /** Normalized category of the last failure, never raw provider text. */
  readonly lastErrorCategory?: string;
}

/** Default cooldown when a provider refused a key without saying how long. */
export const DEFAULT_KEY_COOLDOWN_MS = 60_000;

/** A status a caller may safely see. */
export interface KeyView {
  readonly id: string;
  readonly hint: string;
  readonly label: string | null;
  readonly status: KeyStatus;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly cooldownUntil: string | null;
  readonly lastErrorCategory: string | null;
}

export function keyView(key: ConnectionKey): KeyView {
  return {
    id: key.id,
    hint: key.hint,
    label: key.label ?? null,
    status: key.status,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt ?? null,
    cooldownUntil: key.cooldownUntil ?? null,
    lastErrorCategory: key.lastErrorCategory ?? null,
  };
}

function timeOf(value: string | undefined): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** A cooling key whose wait has passed is usable again. */
export function isUsable(key: ConnectionKey, now: Date): boolean {
  if (key.status === 'invalid') return false;
  if (key.status === 'active') return true;
  const until = timeOf(key.cooldownUntil);
  return Number.isFinite(until) ? until <= now.getTime() : true;
}

/**
 * Keys to try, in the order to try them.
 *
 * Usable keys first, least-recently-used ahead of the rest, so load spreads.
 * Then cooling keys by soonest reset, so a caller that has no usable key still
 * knows which one to wait for. Invalid keys are never returned.
 */
export function selectKeyOrder(keys: readonly ConnectionKey[], now: Date): ConnectionKey[] {
  const usable: ConnectionKey[] = [];
  const cooling: ConnectionKey[] = [];
  for (const key of keys) {
    if (key.status === 'invalid') continue;
    if (isUsable(key, now)) usable.push(key);
    else cooling.push(key);
  }
  // A key that has never been spent ranks as the oldest possible use, so a
  // fresh key is tried before one that has already carried traffic.
  const lastUseRank = (item: ConnectionKey): number => {
    const at = timeOf(item.lastUsedAt);
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
  };
  usable.sort((a, b) => {
    const aAt = lastUseRank(a);
    const bAt = lastUseRank(b);
    if (aAt !== bAt) return aAt - bAt;
    return keys.indexOf(a) - keys.indexOf(b);
  });
  cooling.sort((a, b) => {
    const aAt = timeOf(a.cooldownUntil);
    const bAt = timeOf(b.cooldownUntil);
    const aRank = Number.isFinite(aAt) ? aAt : Number.POSITIVE_INFINITY;
    const bRank = Number.isFinite(bAt) ? bAt : Number.POSITIVE_INFINITY;
    return aRank - bRank;
  });
  return [...usable, ...cooling];
}

/** Every key usable right now, in try order. Empty means: nothing to spend. */
export function usableKeys(keys: readonly ConnectionKey[], now: Date): ConnectionKey[] {
  return selectKeyOrder(keys, now).filter((key) => isUsable(key, now));
}

export function markKeyUsed(key: ConnectionKey, now: Date): ConnectionKey {
  return { ...key, lastUsedAt: now.toISOString() };
}

/**
 * Records a rate limit. The provider's own wait wins; without one, a
 * conservative minute, because a metered key that just refused will refuse
 * again a second later.
 */
export function markKeyCooling(
  key: ConnectionKey,
  now: Date,
  options: { retryAfterMs?: number | null; errorCategory?: string } = {},
): ConnectionKey {
  const wait =
    typeof options.retryAfterMs === 'number' &&
    Number.isFinite(options.retryAfterMs) &&
    options.retryAfterMs > 0
      ? options.retryAfterMs
      : DEFAULT_KEY_COOLDOWN_MS;
  return {
    ...key,
    status: 'cooling',
    cooldownUntil: new Date(now.getTime() + wait).toISOString(),
    ...(options.errorCategory ? { lastErrorCategory: options.errorCategory } : {}),
  };
}

/** Records a rejection that no amount of waiting fixes. */
export function markKeyInvalid(key: ConnectionKey, errorCategory?: string): ConnectionKey {
  return {
    ...key,
    status: 'invalid',
    ...(errorCategory ? { lastErrorCategory: errorCategory } : {}),
  };
}

/** Clears a cooldown after a successful call, so the pool self-heals. */
export function markKeyHealthy(key: ConnectionKey, now: Date): ConnectionKey {
  return {
    id: key.id,
    ref: key.ref,
    hint: key.hint,
    fingerprint: key.fingerprint,
    ...(key.label ? { label: key.label } : {}),
    status: 'active',
    createdAt: key.createdAt,
    lastUsedAt: now.toISOString(),
  };
}

/** Replaces one key in a list, leaving order intact. */
export function replaceKey(
  keys: readonly ConnectionKey[],
  next: ConnectionKey,
): readonly ConnectionKey[] {
  return keys.map((key) => (key.id === next.id ? next : key));
}

export function findKey(keys: readonly ConnectionKey[], id: string): ConnectionKey | undefined {
  return keys.find((key) => key.id === id);
}
