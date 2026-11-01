import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_COOLDOWN_MS,
  type ConnectionKey,
  findKey,
  isUsable,
  keyView,
  markKeyCooling,
  markKeyHealthy,
  markKeyInvalid,
  markKeyUsed,
  replaceKey,
  selectKeyOrder,
  usableKeys,
} from './keypool.js';

const T0 = new Date('2026-11-01T12:00:00.000Z');

function key(id: string, overrides: Partial<ConnectionKey> = {}): ConnectionKey {
  return {
    id,
    ref: `cred_${id}`,
    hint: `...${id.slice(-4)}`,
    fingerprint: `fp_${id}`,
    status: 'active',
    createdAt: T0.toISOString(),
    ...overrides,
  };
}

describe('key pool', () => {
  it('contains no secret in a view', () => {
    const view = keyView(key('k1', { label: 'Work key' }));
    expect(view).toMatchObject({ id: 'k1', label: 'Work key', status: 'active' });
    expect(JSON.stringify(view)).not.toContain('cred_k1');
    expect(Object.keys(view)).not.toContain('ref');
  });

  it('prefers the least recently used usable key so one key does not carry everything', () => {
    const older = markKeyUsed(key('a'), new Date(T0.getTime() - 60_000));
    const newer = markKeyUsed(key('b'), T0);
    const idle = key('c');
    const order = selectKeyOrder([newer, older, idle], T0);
    expect(order.map((k) => k.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps insertion order when no key has been used yet', () => {
    expect(selectKeyOrder([key('a'), key('b'), key('c')], T0).map((k) => k.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('cools a rate-limited key for exactly the wait the provider asked for', () => {
    const cooled = markKeyCooling(key('a'), T0, { retryAfterMs: 17_000 });
    expect(cooled.status).toBe('cooling');
    expect(cooled.cooldownUntil).toBe(new Date(T0.getTime() + 17_000).toISOString());
    expect(isUsable(cooled, T0)).toBe(false);
    expect(usableKeys([cooled], T0)).toEqual([]);
    // And it returns by itself once the wait has passed: no manual reset.
    expect(isUsable(cooled, new Date(T0.getTime() + 17_001))).toBe(true);
  });

  it('falls back to a conservative cooldown when the provider states no wait', () => {
    const cooled = markKeyCooling(key('a'), T0);
    expect(cooled.cooldownUntil).toBe(
      new Date(T0.getTime() + DEFAULT_KEY_COOLDOWN_MS).toISOString(),
    );
    expect(DEFAULT_KEY_COOLDOWN_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('refuses a nonsense wait instead of trusting it', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cooled = markKeyCooling(key('a'), T0, { retryAfterMs: value });
      expect(cooled.cooldownUntil).toBe(
        new Date(T0.getTime() + DEFAULT_KEY_COOLDOWN_MS).toISOString(),
      );
    }
  });

  it('orders cooling keys by soonest reset when nothing is usable', () => {
    const soon = markKeyCooling(key('soon'), T0, { retryAfterMs: 5_000 });
    const late = markKeyCooling(key('late'), T0, { retryAfterMs: 90_000 });
    expect(usableKeys([late, soon], T0)).toEqual([]);
    expect(selectKeyOrder([late, soon], T0).map((k) => k.id)).toEqual(['soon', 'late']);
  });

  it('never spends an invalid key, even after its cooldown would have passed', () => {
    const dead = markKeyInvalid(key('a'), 'authentication');
    const future = new Date(T0.getTime() + 86_400_000);
    expect(usableKeys([dead], future)).toEqual([]);
    expect(selectKeyOrder([dead], future)).toEqual([]);
    expect(dead.lastErrorCategory).toBe('authentication');
  });

  it('heals a cooled key on success and drops stale error state', () => {
    const cooled = markKeyCooling(key('a'), T0, { retryAfterMs: 30_000, errorCategory: 'rate' });
    const healed = markKeyHealthy(cooled, new Date(T0.getTime() + 30_001));
    expect(healed.status).toBe('active');
    expect(healed.cooldownUntil).toBeUndefined();
    expect(healed.lastErrorCategory).toBeUndefined();
    expect(healed.lastUsedAt).toBe(new Date(T0.getTime() + 30_001).toISOString());
    expect(usableKeys([healed], T0)).toHaveLength(1);
  });

  it('rotates to the second key while the first is cooling', () => {
    const first = markKeyCooling(key('a'), T0, { retryAfterMs: 20_000 });
    const second = key('b');
    expect(usableKeys([first, second], T0).map((k) => k.id)).toEqual(['b']);
  });

  it('replaces a key in place and leaves the others untouched', () => {
    const keys = [key('a'), key('b'), key('c')];
    const next = replaceKey(keys, markKeyInvalid(keys[1] as ConnectionKey));
    expect(next.map((k) => k.id)).toEqual(['a', 'b', 'c']);
    expect(next[1]?.status).toBe('invalid');
    expect(next[0]?.status).toBe('active');
  });

  it('finds a key by id and reports nothing for an unknown one', () => {
    const keys = [key('a'), key('b')];
    expect(findKey(keys, 'b')?.id).toBe('b');
    expect(findKey(keys, 'zz')).toBeUndefined();
  });

  it('treats a broken cooldown timestamp as usable rather than wedging the key', () => {
    const broken = { ...key('a'), status: 'cooling' as const, cooldownUntil: 'not-a-date' };
    expect(isUsable(broken, T0)).toBe(true);
  });
});
