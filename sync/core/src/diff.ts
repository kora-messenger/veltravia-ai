import type { BaseSnapshot, ConflictKind } from './types.js';

/**
 * Three-way comparison. Pure: three maps of path -> content hash in, outcomes
 * out. No storage, no network, no content, so every row of the decision table
 * can be tested directly.
 *
 *   base   what both sides agreed on at the last sync (empty before the first)
 *   local  the project now
 *   remote the branch now
 */

export type PathOutcome =
  | { readonly kind: 'unchanged'; readonly path: string }
  | { readonly kind: 'push-add'; readonly path: string; readonly hash: string }
  | { readonly kind: 'push-modify'; readonly path: string; readonly hash: string }
  | { readonly kind: 'push-delete'; readonly path: string }
  | { readonly kind: 'pull-add'; readonly path: string; readonly hash: string }
  | { readonly kind: 'pull-modify'; readonly path: string; readonly hash: string }
  | { readonly kind: 'pull-delete'; readonly path: string }
  /** Both sides now hold identical content: only the base needs to move. */
  | { readonly kind: 'converged'; readonly path: string; readonly hash: string | null }
  | {
      readonly kind: 'conflict';
      readonly path: string;
      readonly conflict: ConflictKind;
      readonly localHash: string | null;
      readonly remoteHash: string | null;
      readonly baseHash: string | null;
    };

export function threeWay(
  base: BaseSnapshot,
  local: ReadonlyMap<string, string>,
  remote: ReadonlyMap<string, string>,
): PathOutcome[] {
  const paths = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys()]);
  const outcomes: PathOutcome[] = [];

  for (const path of [...paths].sort()) {
    const b = base.get(path) ?? null;
    const l = local.get(path) ?? null;
    const r = remote.get(path) ?? null;

    // Same content on both sides, whatever the base says.
    if (l === r) {
      if (l === null) continue; // gone everywhere
      outcomes.push(b === l ? { kind: 'unchanged', path } : { kind: 'converged', path, hash: l });
      continue;
    }

    const localChanged = l !== b;
    const remoteChanged = r !== b;

    if (!localChanged && remoteChanged) {
      // Only the remote moved.
      if (r === null) outcomes.push({ kind: 'pull-delete', path });
      else if (b === null) outcomes.push({ kind: 'pull-add', path, hash: r });
      else outcomes.push({ kind: 'pull-modify', path, hash: r });
      continue;
    }

    if (localChanged && !remoteChanged) {
      // Only the project moved.
      if (l === null) outcomes.push({ kind: 'push-delete', path });
      else if (b === null) outcomes.push({ kind: 'push-add', path, hash: l });
      else outcomes.push({ kind: 'push-modify', path, hash: l });
      continue;
    }

    // Both sides moved, and they disagree.
    let conflict: ConflictKind;
    if (l === null) conflict = 'local-deleted-remote-modified';
    else if (r === null) conflict = 'remote-deleted-local-modified';
    else if (b === null) conflict = 'both-added';
    else conflict = 'both-modified';
    outcomes.push({ kind: 'conflict', path, conflict, localHash: l, remoteHash: r, baseHash: b });
  }
  return outcomes;
}

export interface RenameMatch {
  readonly fromPath: string;
  readonly toPath: string;
  readonly hash: string;
}

/**
 * Finds renames among pushed deletions and additions. Git records no renames,
 * so a rename is inferred only when it is unambiguous: exactly one deleted path
 * and exactly one added path share a content hash. Anything murkier stays a
 * plain delete and add, which is always correct, just less tidy.
 */
export function detectRenames(
  deleted: readonly { path: string; hash: string }[],
  added: readonly { path: string; hash: string }[],
): RenameMatch[] {
  const byHash = (items: readonly { path: string; hash: string }[]) => {
    const groups = new Map<string, string[]>();
    for (const item of items) groups.set(item.hash, [...(groups.get(item.hash) ?? []), item.path]);
    return groups;
  };
  const gone = byHash(deleted);
  const fresh = byHash(added);
  const out: RenameMatch[] = [];
  for (const [hash, from] of gone) {
    const to = fresh.get(hash);
    if (from.length === 1 && to !== undefined && to.length === 1) {
      out.push({ fromPath: from[0] as string, toPath: to[0] as string, hash });
    }
  }
  return out.sort((a, b) => a.toPath.localeCompare(b.toPath));
}
