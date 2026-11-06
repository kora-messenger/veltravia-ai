/**
 * The owner scope every storage call runs inside.
 *
 * Ownership is not a parameter a route may forget: it travels on the async
 * context, and a repository that cannot read it refuses the operation. That
 * means a query written without an owner predicate cannot silently read
 * another user's rows - the repository never gets far enough to run it.
 *
 * The scope is set once per HTTP request (see `server.ts`) and once per test.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { OwnerScopeMissingError, OwnerScopeMismatchError } from './errors.js';

export interface OwnerScope {
  readonly ownerRef: string;
}

const storage = new AsyncLocalStorage<OwnerScope>();

/** Runs `fn` with the given owner bound to the async context. */
export function runWithOwner<T>(ownerRef: string, fn: () => T): T {
  const trimmed = ownerRef.trim();
  if (trimmed === '') throw new OwnerScopeMissingError();
  return storage.run({ ownerRef: trimmed }, fn);
}

/** The current owner, or null outside a scope. */
export function currentOwner(): string | null {
  return storage.getStore()?.ownerRef ?? null;
}

/** The current owner; throws when the call is unscoped. */
export function requireOwner(): string {
  const owner = currentOwner();
  if (owner === null) throw new OwnerScopeMissingError();
  return owner;
}

/**
 * Confirms a record being written carries the calling owner. A row may only
 * ever be created for the caller, so a spoofed `ownerRef` in a request body is
 * rejected before it reaches SQL.
 */
export function assertOwnerMatch(claimed: string): string {
  const owner = requireOwner();
  if (claimed !== owner) throw new OwnerScopeMismatchError();
  return owner;
}
