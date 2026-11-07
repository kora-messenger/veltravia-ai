/**
 * Path scope, shared by the toolbox and the final report.
 *
 * A worker's authority is a set of paths in its assignment: anything inside a
 * scope entry and outside every exclusion. Prefix matching is on segments so
 * `src/app` never matches `src/apple`.
 */

import { assertSafePath } from '@veltravia/worker-core';

export interface PathAuthority {
  readonly scope: readonly string[];
  readonly exclusions: readonly string[];
}

export function pathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function isAuthorisedPath(authority: PathAuthority, path: string): boolean {
  const inside = authority.scope.some((entry) => pathWithin(path, entry));
  if (!inside) return false;
  return !authority.exclusions.some((entry) => pathWithin(path, entry));
}

/** Validates and authorises a path argument; throws a worker error when refused. */
export function assertAuthorisedPath(
  authority: PathAuthority,
  value: unknown,
  field: string,
): string {
  const path = assertSafePath(typeof value === 'string' ? value : '', field);
  if (!isAuthorisedPath(authority, path)) {
    throw new Error(`${field} is outside the assignment: ${path}`);
  }
  return path;
}
