/**
 * Resource claims and conflicts.
 *
 * Two workers writing under `src/` and `src/api/` are not two independent
 * streams; they are one contested directory. The scheduler refuses that
 * instead of hoping the merge works later.
 */

import type { ResourceClaim } from './types.js';

function normalise(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

export function pathWithin(child: string, parent: string): boolean {
  const a = normalise(child);
  const b = normalise(parent);
  if (a === b) return true;
  return a.startsWith(`${b}/`);
}

/** True when the two claims cannot both be held. */
export function claimsConflict(left: ResourceClaim, right: ResourceClaim): boolean {
  if (left.kind === 'directory' && right.kind === 'directory') {
    return pathWithin(left.path, right.path) || pathWithin(right.path, left.path);
  }
  if (left.kind === 'file' && right.kind === 'file') {
    return normalise(left.path) === normalise(right.path);
  }
  // One file, one directory: conflicted when the file sits inside the directory.
  const file = left.kind === 'file' ? left : right;
  const directory = left.kind === 'file' ? right : left;
  return pathWithin(file.path, directory.path);
}

export function conflictBetween(
  left: readonly ResourceClaim[],
  right: readonly ResourceClaim[],
): ResourceClaim | null {
  for (const a of left) {
    for (const b of right) {
      if (claimsConflict(a, b)) return a;
    }
  }
  return null;
}

/** True when any claim in `mine` overlaps any claim already held. */
export function findConflict(
  mine: readonly ResourceClaim[],
  held: readonly { readonly workerId: string; readonly claims: readonly ResourceClaim[] }[],
): { readonly workerId: string; readonly claim: ResourceClaim } | null {
  for (const holder of held) {
    const claim = conflictBetween(mine, holder.claims);
    if (claim !== null) return { workerId: holder.workerId, claim };
  }
  return null;
}
