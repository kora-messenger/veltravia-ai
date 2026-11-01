/**
 * Snapshot comparison (Step 31).
 *
 * Pure functions over two manifests. Comparison never touches storage, so it
 * answers the same way whether the snapshots sit in memory or in object
 * storage.
 */

import type { SnapshotComparison } from '../types/index.js';

export interface ManifestEntry {
  readonly path: string;
  readonly contentHash: string;
  readonly size: number;
}

/**
 * Compare two manifests by path and content hash.
 *
 * A size-only change is still a modification (same length, different bytes is
 * possible), so the hash decides and size is reported for context.
 */
export function compareManifests(
  fromLabel: string,
  from: readonly ManifestEntry[],
  toLabel: string,
  to: readonly ManifestEntry[],
): SnapshotComparison {
  const fromMap = new Map(from.map((entry) => [entry.path, entry]));
  const toMap = new Map(to.map((entry) => [entry.path, entry]));

  const added: { path: string; size: number }[] = [];
  const removed: { path: string; size: number }[] = [];
  const modified: { path: string; fromSize: number; toSize: number }[] = [];
  let unchanged = 0;

  for (const [path, entry] of toMap) {
    const previous = fromMap.get(path);
    if (previous === undefined) {
      added.push({ path, size: entry.size });
      continue;
    }
    if (previous.contentHash !== entry.contentHash) {
      modified.push({ path, fromSize: previous.size, toSize: entry.size });
      continue;
    }
    unchanged += 1;
  }

  for (const [path, entry] of fromMap) {
    if (!toMap.has(path)) removed.push({ path, size: entry.size });
  }

  const sort = <T extends { path: string }>(items: T[]): T[] =>
    items.sort((left, right) => left.path.localeCompare(right.path));

  const summary =
    added.length === 0 && removed.length === 0 && modified.length === 0
      ? `${fromLabel} and ${toLabel} hold the same files.`
      : `${fromLabel} → ${toLabel}: ${added.length} added, ${modified.length} modified, ${removed.length} removed, ${unchanged} unchanged.`;

  return {
    from: fromLabel,
    to: toLabel,
    added: sort(added),
    removed: sort(removed),
    modified: sort(modified),
    unchanged,
    summary,
  };
}
