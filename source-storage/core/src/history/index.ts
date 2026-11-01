/**
 * Per-file revision history (Step 31).
 *
 * The project engine already rejects stale writes and bumps a per-file
 * revision. What it does not keep is a HISTORY: what changed, when, by whom and
 * with which content hash. This module records that, bounded, per repository.
 *
 * Entries are metadata only - path, hash, size, actor, summary - never content.
 */

import { SourceError } from '../errors/index.js';
import { SOURCE_LIMITS, type FileRevisionEntry, type RevisionActor } from '../types/index.js';

export interface KnownPathState {
  readonly revision: number;
  readonly size: number;
  readonly contentHash: string | null;
  readonly type: 'file' | 'directory';
}

export class FileHistory {
  private entries: FileRevisionEntry[] = [];
  /** Last observed state of every path, so external writes can be attributed. */
  private known = new Map<string, KnownPathState>();

  constructor(
    private readonly generateId: () => string,
    private readonly now: () => Date,
    private readonly limit: number = SOURCE_LIMITS.maxHistoryEntries,
  ) {}

  record(input: {
    readonly path: string;
    readonly changeKind: FileRevisionEntry['changeKind'];
    readonly revision: number;
    readonly size: number;
    readonly contentHash: string | null;
    readonly actor: RevisionActor;
    readonly summary: string;
  }): FileRevisionEntry {
    const entry: FileRevisionEntry = {
      id: this.generateId(),
      path: input.path,
      changeKind: input.changeKind,
      revision: input.revision,
      size: input.size,
      contentHash: input.contentHash,
      actor: input.actor,
      summary: input.summary,
      at: this.now().toISOString(),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit);
    return entry;
  }

  /** Replaces the remembered tree state after a successful observation. */
  remember(state: Map<string, KnownPathState>): void {
    this.known = state;
  }

  knownState(): Map<string, KnownPathState> {
    return this.known;
  }

  list(
    options: { readonly path?: string; readonly limit?: number } = {},
  ): readonly FileRevisionEntry[] {
    const filtered =
      options.path === undefined
        ? this.entries
        : this.entries.filter((e) => e.path === options.path);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return filtered.slice(-limit).reverse();
  }

  count(): number {
    return this.entries.length;
  }

  /** Change summary across a set of paths, used by snapshots and the API. */
  summary(paths?: readonly string[]): {
    readonly changed: number;
    readonly kinds: Record<string, number>;
  } {
    const scoped =
      paths === undefined
        ? this.entries
        : this.entries.filter((entry) => paths.includes(entry.path));
    const kinds: Record<string, number> = {};
    for (const entry of scoped) kinds[entry.changeKind] = (kinds[entry.changeKind] ?? 0) + 1;
    return { changed: scoped.length, kinds };
  }
}

/** Guards the history API against asking for something impossible. */
export function assertHistoryRequest(path: string | undefined): void {
  if (path !== undefined && path.length > 512) {
    throw new SourceError('SOURCE_INVALID_REQUEST', 'That path is too long to look up.', {
      length: path.length,
    });
  }
}
