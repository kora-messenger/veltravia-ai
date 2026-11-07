/**
 * Conflict detection (Step 46, section 5).
 *
 * The rule that matters: a newer project revision is NOT a conflict by itself.
 * A set is in conflict when something it actually touches moved, or when two
 * sets want different things from one path. Everything else is independent and
 * may be integrated.
 */

import { matchesAny } from './paths.js';
import {
  CHANGE_INTEGRATION_LIMITS,
  type ChangeConflict,
  type ConflictKind,
  type ConflictReport,
  type ProjectPathState,
  type WorkerChangeSet,
} from './types.js';

export interface ConflictCandidate {
  readonly changeSet: WorkerChangeSet;
  /** Proposed content per path, needed for region comparison. */
  readonly contents: ReadonlyMap<string, string>;
}

export interface DetectConflictsInput {
  readonly candidates: readonly ConflictCandidate[];
  readonly current: {
    readonly revision: number;
    readonly files: readonly ProjectPathState[];
  };
  /**
   * The content each touched path holds right now.
   *
   * Overlap is measured against this, not against the proposal: the base line
   * range is what two proposals have in common.
   */
  readonly baseContents?: ReadonlyMap<string, string>;
}

/** Paths a set touches, with what it wants to do. */
interface Touched {
  readonly path: string;
  readonly op: 'create' | 'update' | 'delete';
  readonly baseHash: string | null;
  readonly proposedHash: string | null;
}

function touchOf(candidate: ConflictCandidate): Map<string, Touched> {
  const map = new Map<string, Touched>();
  for (const file of candidate.changeSet.files) {
    map.set(file.path, {
      path: file.path,
      op: file.op,
      baseHash: file.baseHash,
      proposedHash: file.proposedHash,
    });
  }
  return map;
}

const CONFIG_PATTERNS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'tsconfig.base.json',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.json',
  'prettier.config.js',
  'vite.config.ts',
  'vitest.config.ts',
  'next.config.js',
  'next.config.mjs',
  'Dockerfile',
  'docker-compose.yml',
  'render.yaml',
];

const DEPENDENCY_PATTERNS = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

const SCHEMA_PATTERNS = [
  'schema.prisma',
  'migrations',
  'prisma/migrations',
  'db/migrations',
  'drizzle',
  'knex/migrations',
];

function isConfigPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return CONFIG_PATTERNS.includes(name) || path.startsWith('.github/');
}

function isDependencyPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return DEPENDENCY_PATTERNS.includes(name);
}

function isSchemaPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  if (name === 'schema.prisma') return true;
  if (/\.sql$/i.test(name) && /migrat/i.test(path)) return true;
  return SCHEMA_PATTERNS.some((pattern) => path === pattern || path.startsWith(`${pattern}/`));
}

/** The line range a proposal changed, or null when it changed nothing. */
export function changedLineRange(
  base: string,
  proposed: string,
): { readonly start: number; readonly end: number } | null {
  if (base === proposed) return null;
  const baseLines = base.split('\n');
  const proposedLines = proposed.split('\n');
  let prefix = 0;
  while (
    prefix < baseLines.length &&
    prefix < proposedLines.length &&
    baseLines[prefix] === proposedLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < baseLines.length - prefix &&
    suffix < proposedLines.length - prefix &&
    baseLines[baseLines.length - 1 - suffix] === proposedLines[proposedLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { start: prefix, end: Math.max(prefix, baseLines.length - suffix) };
}

function rangesOverlap(
  a: { readonly start: number; readonly end: number },
  b: { readonly start: number; readonly end: number },
): boolean {
  // Touching ends count as overlap: an insert at the boundary can break either.
  return a.start <= b.end && b.start <= a.end;
}

function conflict(
  kind: ConflictKind,
  paths: readonly string[],
  changeSetIds: readonly string[],
  message: string,
  suggestion: string,
  convergent = false,
): ChangeConflict {
  return { kind, paths, changeSetIds, convergent, message, suggestion };
}

/** Renames inside one set: a deletion plus a creation with the same basename. */
function renamePairs(candidate: ConflictCandidate): readonly { from: string; to: string }[] {
  const deletes = candidate.changeSet.files.filter((file) => file.op === 'delete');
  const creates = candidate.changeSet.files.filter((file) => file.op === 'create');
  const pairs: { from: string; to: string }[] = [];
  for (const deleted of deletes) {
    const base = deleted.path.split('/').pop() ?? deleted.path;
    const match = creates.find((created) => (created.path.split('/').pop() ?? '') === base);
    if (match !== undefined) pairs.push({ from: deleted.path, to: match.path });
  }
  return pairs;
}

/**
 * Compares every candidate against the project and against its peers.
 *
 * Returns one report per set. `blocked` is true when anything at all stands in
 * the way of integrating that set as it stands.
 */
export function detectConflicts(input: DetectConflictsInput): readonly ConflictReport[] {
  const byPath = new Map(input.current.files.map((file) => [file.path, file]));
  const touched = input.candidates.map((candidate) => touchOf(candidate));
  const reports: ConflictReport[] = [];

  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index]!;
    const mine = touched[index]!;
    const conflicts: ChangeConflict[] = [];
    const independent: string[] = [];

    for (const [path, touch] of mine) {
      const currentFile = byPath.get(path) ?? null;

      // 1. Did the project move under this file? Only then is it stale.
      if (touch.op === 'delete') {
        if (
          currentFile === null ||
          (touch.baseHash !== null && currentFile.contentHash !== touch.baseHash)
        ) {
          conflicts.push(
            conflict(
              'stale-file',
              [path],
              [candidate.changeSet.id],
              `${path} is not in the state this set started from.`,
              'Ask the worker to re-base its change set on the current revision.',
            ),
          );
          continue;
        }
      } else if (touch.op === 'update') {
        if (
          currentFile === null ||
          (touch.baseHash !== null && currentFile.contentHash !== touch.baseHash)
        ) {
          conflicts.push(
            conflict(
              'stale-file',
              [path],
              [candidate.changeSet.id],
              `${path} changed after this set was drafted.`,
              'Ask the worker to re-base its change set on the current revision.',
            ),
          );
          continue;
        }
      } else if (currentFile !== null && currentFile.contentHash !== (touch.proposedHash ?? '')) {
        conflicts.push(
          conflict(
            'stale-file',
            [path],
            [candidate.changeSet.id],
            `${path} already exists with different content.`,
            'The worker must propose an update against the existing content instead.',
          ),
        );
        continue;
      }

      independent.push(path);

      // 2. Does a peer want something incompatible from the same path?
      for (let peer = 0; peer < input.candidates.length; peer += 1) {
        if (peer === index) continue;
        const other = touched[peer]!;
        const otherSet = input.candidates[peer]!.changeSet;
        const theirs = other.get(path);

        // 2a. A peer renames this path away while this set edits it there.
        const peerRename = renamePairs(input.candidates[peer]!).find(
          (pair) => pair.from === path && pair.to !== path,
        );
        if (peerRename !== undefined && touch.op !== 'delete') {
          conflicts.push(
            conflict(
              'rename-modify',
              [path, peerRename.to],
              [candidate.changeSet.id, otherSet.id],
              `${otherSet.id} renames ${path} to ${peerRename.to} while this set changes it.`,
              'Ask one worker to reconcile the rename with the change to the same file.',
            ),
          );
          continue;
        }

        if (theirs === undefined) continue;

        if (theirs.proposedHash === touch.proposedHash) {
          conflicts.push(
            conflict(
              'same-file',
              [path],
              [candidate.changeSet.id, otherSet.id],
              `Both sets propose identical content for ${path}.`,
              'Integrate either one; the result is the same.',
              true,
            ),
          );
          continue;
        }

        if (theirs.op === 'delete' && touch.op !== 'delete') {
          conflicts.push(
            conflict(
              'delete-modify',
              [path],
              [candidate.changeSet.id, otherSet.id],
              `${otherSet.id} deletes ${path} while this set modifies it.`,
              'Ask the worker that deletes it, or the one that needs it, to decide.',
            ),
          );
          continue;
        }
        if (touch.op === 'delete' && theirs.op !== 'delete') {
          conflicts.push(
            conflict(
              'delete-modify',
              [path],
              [candidate.changeSet.id, otherSet.id],
              `This set deletes ${path} while ${otherSet.id} modifies it.`,
              'Ask the worker that deletes it, or the one that needs it, to decide.',
            ),
          );
          continue;
        }

        // Both write different content. Overlap in line ranges is the sharper
        // diagnosis; either way one worker's edit would be lost if applied.
        const mineContent = candidate.contents.get(path) ?? '';
        const theirContent = input.candidates[peer]!.contents.get(path) ?? '';
        const baseContent = input.baseContents?.get(path) ?? '';
        const myRange = changedLineRange(baseContent, mineContent);
        const theirRange = changedLineRange(baseContent, theirContent);
        const overlapping =
          myRange !== null && theirRange !== null && rangesOverlap(myRange, theirRange);
        conflicts.push(
          conflict(
            overlapping ? 'overlapping-region' : 'same-file',
            [path],
            [candidate.changeSet.id, otherSet.id],
            overlapping
              ? `Both sets edit the same lines of ${path}.`
              : `Both sets propose different content for ${path}.`,
            'Ask one worker to produce a combined change set for this file.',
          ),
        );
      }

      if (isSchemaPath(path)) {
        const peerSchema = input.candidates
          .filter((_peer, peer) => peer !== index)
          .filter((peer) => peer.changeSet.files.some((file) => isSchemaPath(file.path)));
        if (peerSchema.length > 0) {
          conflicts.push(
            conflict(
              'schema',
              [path],
              [candidate.changeSet.id, ...peerSchema.map((peer) => peer.changeSet.id)],
              `More than one worker changes the database schema (${path}).`,
              'Ask a database worker to review the competing schema changes.',
            ),
          );
        }
      }

      if (isDependencyPath(path)) {
        const peerDependency = input.candidates
          .filter((_peer, peer) => peer !== index)
          .filter((peer) => peer.changeSet.files.some((file) => isDependencyPath(file.path)));
        if (peerDependency.length > 0) {
          conflicts.push(
            conflict(
              'dependency',
              [path],
              [candidate.changeSet.id, ...peerDependency.map((peer) => peer.changeSet.id)],
              `More than one worker changes dependency declarations (${path}).`,
              'Combine the dependency changes into one reviewed set.',
            ),
          );
        }
      } else if (isConfigPath(path)) {
        const peerConfig = input.candidates
          .filter((_peer, peer) => peer !== index)
          .filter((peer) => peer.changeSet.files.some((file) => isConfigPath(file.path)));
        if (peerConfig.length > 0) {
          conflicts.push(
            conflict(
              'config',
              [path],
              [candidate.changeSet.id, ...peerConfig.map((peer) => peer.changeSet.id)],
              `More than one worker changes configuration (${path}).`,
              'Ask one worker to own the configuration change.',
            ),
          );
        }
      }
    }

    // 3. Does another set remove a path this set calls its output?
    for (const deliverable of candidate.changeSet.deliverables) {
      for (let peer = 0; peer < input.candidates.length; peer += 1) {
        if (peer === index) continue;
        const otherSet = input.candidates[peer]!.changeSet;
        const removes = otherSet.files.some(
          (file) => file.op === 'delete' && matchesAny(deliverable, [file.path]),
        );
        if (removes) {
          conflicts.push(
            conflict(
              'invalidates-deliverable',
              [deliverable],
              [candidate.changeSet.id, otherSet.id],
              `${otherSet.id} removes ${deliverable}, which this set produced.`,
              'Decide which worker owns that path before integrating either set.',
            ),
          );
        }
      }
    }

    reports.push({
      changeSetId: candidate.changeSet.id,
      conflicts: conflicts.slice(0, CHANGE_INTEGRATION_LIMITS.maxConflicts),
      independentPaths: independent.filter(
        (path) =>
          !conflicts.some(
            (entry) => !entry.convergent && entry.paths.includes(path) && entry.paths.length === 1,
          ),
      ),
      blocked: conflicts.some((entry) => !entry.convergent),
    });
  }

  return reports;
}

/** Every conflict across a selection, de-duplicated by kind and paths. */
export function allConflicts(reports: readonly ConflictReport[]): readonly ChangeConflict[] {
  const seen = new Set<string>();
  const collected: ChangeConflict[] = [];
  for (const report of reports) {
    for (const entry of report.conflicts) {
      const key = `${entry.kind}|${[...entry.paths].sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }
  }
  return collected;
}
