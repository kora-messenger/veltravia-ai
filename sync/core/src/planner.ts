import { assertSafeExportPath } from '@veltravia/export-core';

import { detectRenames, threeWay, type PathOutcome } from './diff.js';
import { contentSha } from './hash.js';
import type { LocalFile, RemoteFile } from './ports.js';
import { screenFile } from './screen.js';
import {
  SYNC_LIMITS,
  type ApprovalReason,
  type BaseSnapshot,
  type Conflict,
  type IncomingChange,
  type PlannedChange,
  type SkippedFile,
} from './types.js';

/**
 * Turns "the project", "the branch" and "what we last agreed" into a plan.
 *
 * The planner is pure: files in, a plan out. It decides nothing about GitHub
 * and writes nothing. Its three jobs, each a place a sync can lose data:
 *
 *   1. Screen both sides, so a secret never crosses in either direction.
 *   2. Make sure a file that is merely NOT PARTICIPATING (screened out, or a
 *      remote binary) is never mistaken for a file that was DELETED.
 *   3. Work out why a person must approve before anything remote changes.
 */

export interface PlanInput {
  readonly local: readonly LocalFile[];
  readonly remote: readonly RemoteFile[];
  /** null before the first sync. */
  readonly base: BaseSnapshot | null;
  readonly branchIsDefault: boolean;
  /** Files the remote has that we did not understand (symlinks, submodules). */
  readonly remoteSkippedCount: number;
}

export interface PlanBody {
  readonly mode: 'initial' | 'update';
  readonly push: PlannedChange[];
  readonly pull: IncomingChange[];
  readonly conflicts: Omit<Conflict, 'id' | 'resolution'>[];
  readonly skipped: SkippedFile[];
  readonly unchanged: number;
  readonly approvalReasons: ApprovalReason[];
  /** The hash-and-size of every local file that took part, for committing. */
  readonly localHashes: ReadonlyMap<string, string>;
  /** Paths that were screened out or are not text: not participating. */
  readonly nonParticipating: ReadonlySet<string>;
}

export function buildPlan(input: PlanInput): PlanBody {
  const skipped: SkippedFile[] = [];
  const nonParticipating = new Set<string>();

  // -- local side ---------------------------------------------------------
  const localHashes = new Map<string, string>();
  const localSizes = new Map<string, number>();
  const seenLocalLower = new Map<string, string>();
  for (const file of input.local) {
    if (!isSafePath(file.path)) {
      skipped.push(unsafe('local', file.path));
      nonParticipating.add(file.path);
      continue;
    }
    const lower = file.path.toLowerCase();
    const clash = seenLocalLower.get(lower);
    if (clash !== undefined) {
      skipped.push(collision('local', file.path));
      nonParticipating.add(file.path);
      continue;
    }
    seenLocalLower.set(lower, file.path);
    const screened = screenFile({ side: 'local', path: file.path, content: file.content });
    if (!screened.ok && screened.skip !== undefined) {
      skipped.push(screened.skip);
      nonParticipating.add(file.path);
      continue;
    }
    localHashes.set(file.path, contentSha(file.content));
    localSizes.set(file.path, Buffer.byteLength(file.content, 'utf8'));
  }

  // -- remote side --------------------------------------------------------
  const remoteHashes = new Map<string, string>();
  const remoteSizes = new Map<string, number>();
  const seenRemoteLower = new Map<string, string>();
  for (const file of input.remote) {
    if (!isSafePath(file.path)) {
      // Remote paths are untrusted. An unsafe one is named by a fixed phrase,
      // not echoed back, and never written anywhere.
      skipped.push(unsafe('remote', file.path));
      nonParticipating.add(file.path);
      continue;
    }
    const lower = file.path.toLowerCase();
    if (seenRemoteLower.has(lower)) {
      skipped.push(collision('remote', file.path));
      nonParticipating.add(file.path);
      continue;
    }
    seenRemoteLower.set(lower, file.path);
    if (file.notText !== null || file.hashOfText === null) {
      skipped.push({
        path: file.path,
        side: 'remote',
        reason:
          file.notText === 'too-large'
            ? 'too-large'
            : file.notText === 'unreadable'
              ? 'unreadable'
              : 'not-text',
        detail:
          'This remote file is not a text file the project can hold, so it is left exactly as it is.',
      });
      nonParticipating.add(file.path);
      continue;
    }
    remoteHashes.set(file.path, file.hashOfText);
    remoteSizes.set(file.path, file.size);
  }
  if (input.remoteSkippedCount > 0) {
    skipped.push({
      path: '(symbolic links and submodules)',
      side: 'remote',
      reason: 'not-a-file',
      detail: `${input.remoteSkippedCount} remote entries are links or submodules and are left alone.`,
    });
  }

  // Credential files on the remote must be screened by NAME too, even though
  // their content is not read here: they are never pulled.
  for (const path of [...remoteHashes.keys()]) {
    const screened = screenFile({ side: 'remote', path, content: '' });
    if (!screened.ok && screened.skip !== undefined) {
      skipped.push(screened.skip);
      nonParticipating.add(path);
      remoteHashes.delete(path);
    }
  }

  // -- compare ------------------------------------------------------------
  const base: BaseSnapshot = input.base ?? new Map();
  // A path that is not participating must not read as "deleted" on its side.
  // Remove it from the base too, so its absence is not a change.
  const effectiveBase = new Map([...base].filter(([path]) => !nonParticipating.has(path)));
  const outcomes = threeWay(effectiveBase, localHashes, remoteHashes);

  const push: PlannedChange[] = [];
  const pull: IncomingChange[] = [];
  const conflicts: PlanBody['conflicts'] = [];
  let unchanged = 0;

  const addedForRename: { path: string; hash: string }[] = [];
  const deletedForRename: { path: string; hash: string }[] = [];

  for (const outcome of outcomes) {
    sort(outcome);
  }
  function sort(outcome: PathOutcome): void {
    switch (outcome.kind) {
      case 'unchanged':
      case 'converged':
        unchanged += 1;
        return;
      case 'push-add':
        push.push({
          kind: 'add',
          path: outcome.path,
          hash: outcome.hash,
          size: localSizes.get(outcome.path) ?? 0,
        });
        addedForRename.push({ path: outcome.path, hash: outcome.hash });
        return;
      case 'push-modify':
        push.push({
          kind: 'modify',
          path: outcome.path,
          hash: outcome.hash,
          size: localSizes.get(outcome.path) ?? 0,
        });
        return;
      case 'push-delete': {
        const was = effectiveBase.get(outcome.path) ?? '';
        push.push({ kind: 'delete', path: outcome.path, hash: null, size: 0 });
        deletedForRename.push({ path: outcome.path, hash: was });
        return;
      }
      case 'pull-add':
        pull.push({
          kind: 'add',
          path: outcome.path,
          hash: outcome.hash,
          size: remoteSizes.get(outcome.path) ?? 0,
        });
        return;
      case 'pull-modify':
        pull.push({
          kind: 'modify',
          path: outcome.path,
          hash: outcome.hash,
          size: remoteSizes.get(outcome.path) ?? 0,
        });
        return;
      case 'pull-delete':
        pull.push({ kind: 'delete', path: outcome.path, hash: null, size: 0 });
        return;
      case 'conflict':
        conflicts.push({
          path: outcome.path,
          kind: outcome.conflict,
          localHash: outcome.localHash,
          remoteHash: outcome.remoteHash,
          baseHash: outcome.baseHash,
          summary: describeConflict(outcome.conflict),
        });
        return;
    }
  }

  // -- renames (pushed side only; GitHub records none, so this is inferred) --
  const renames = detectRenames(deletedForRename, addedForRename);
  for (const rename of renames) {
    const added = push.findIndex((c) => c.kind === 'add' && c.path === rename.toPath);
    const deleted = push.findIndex((c) => c.kind === 'delete' && c.path === rename.fromPath);
    if (added === -1 || deleted === -1) continue;
    const entry = push[added] as PlannedChange;
    push[added] = {
      kind: 'rename',
      path: rename.toPath,
      fromPath: rename.fromPath,
      hash: entry.hash,
      size: entry.size,
    };
    push.splice(deleted, 1);
  }
  push.sort((a, b) => a.path.localeCompare(b.path));
  pull.sort((a, b) => a.path.localeCompare(b.path));
  conflicts.sort((a, b) => a.path.localeCompare(b.path));

  // -- approval -----------------------------------------------------------
  const mode: PlanBody['mode'] = input.base === null ? 'initial' : 'update';
  const approvalReasons: ApprovalReason[] = [];
  if (push.length > 0 || conflicts.length > 0) {
    if (mode === 'initial') approvalReasons.push('first-sync');
    if (mode === 'initial' && remoteHashes.size > 0) approvalReasons.push('remote-has-content');
    if (push.some((c) => c.kind === 'delete' || c.kind === 'rename')) {
      approvalReasons.push('deletes-remote-files');
    }
    if (input.branchIsDefault) approvalReasons.push('default-branch');
  }

  return {
    mode,
    push,
    pull,
    conflicts,
    skipped,
    unchanged,
    approvalReasons,
    localHashes,
    nonParticipating,
  };
}

function isSafePath(path: string): boolean {
  try {
    assertSafeExportPath(path);
    return true;
  } catch {
    return false;
  }
}

const unsafe = (side: 'local' | 'remote', path: string): SkippedFile => ({
  // The raw path is untrusted, so only a safe label is recorded.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  path: path.length <= 80 && !/[\u0000-\u001f]/.test(path) ? path : '(unsafe path)',
  side,
  reason: 'unreadable',
  detail: 'The path is not safe to use inside a project (traversal, absolute or malformed).',
});

const collision = (side: 'local' | 'remote', path: string): SkippedFile => ({
  path,
  side,
  reason: 'unreadable',
  detail:
    'Another file differs from this one only by letter case, which would collide on many systems.',
});

function describeConflict(kind: Conflict['kind']): string {
  switch (kind) {
    case 'both-modified':
      return 'This file was changed on both sides since the last sync, in different ways.';
    case 'both-added':
      return 'This file was added on both sides with different content.';
    case 'local-deleted-remote-modified':
      return 'You deleted this file in the project, but it was changed on GitHub.';
    case 'remote-deleted-local-modified':
      return 'It was deleted on GitHub, but you changed it in the project.';
    case 'rename-conflict':
      return 'This file was renamed on one side and changed on the other.';
  }
}

export { SYNC_LIMITS };
