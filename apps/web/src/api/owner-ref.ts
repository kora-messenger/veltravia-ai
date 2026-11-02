/**
 * Per-browser owner reference.
 *
 * Every API surface in this build scopes data by an owner reference, which in a
 * real deployment comes from an authenticated session. Until authentication
 * exists, the agent profile uses a stable id generated in THIS browser: two
 * people using the same server then name their own agents instead of sharing
 * one name. That is a development stand-in and is described as one everywhere
 * it is shown; it identifies a browser, not a person.
 */

const KEY = 'veltravia.owner-ref';

function generate(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function browserOwnerRef(): string {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored !== null && stored.trim() !== '') return stored.trim();
    const created = generate();
    window.localStorage.setItem(KEY, created);
    return created;
  } catch {
    // Storage blocked (private mode, disabled cookies): fall back to a value
    // that is at least stable for this page, and never claim to be durable.
    return 'veltravia-browser-anonymous';
  }
}
