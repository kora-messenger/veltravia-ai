/**
 * Change-set validation (Step 46, section 4).
 *
 * Everything is checked against the state the integrator is about to write to,
 * not against what the worker believed. A set that cannot be proved to sit on
 * the current project is stale, and a stale set is never applied.
 */

import { byteLength, contentHash, isContentHash } from './hash.js';
import { looksLikeCredential } from './secrets.js';
import { duplicatePaths, matchesAny, normalizeChangePath } from './paths.js';
import {
  CHANGE_INTEGRATION_LIMITS,
  type ChangeFile,
  type ChangeProblem,
  type ChangeValidation,
  type ProjectPathState,
  type WorkerChangeSet,
} from './types.js';

export interface ValidateChangeSetInput {
  readonly changeSet: WorkerChangeSet;
  /** Proposed content per path, from the artifact store. */
  readonly contents: ReadonlyMap<string, string>;
  /** The project tree as it is right now. */
  readonly current: {
    readonly revision: number;
    readonly files: readonly ProjectPathState[];
  };
  /** When true, base-hash mismatches are reported as stale instead of failing. */
  readonly allowStale?: boolean;
}

function problem(code: ChangeProblem['code'], path: string | null, message: string): ChangeProblem {
  return { code, path, message };
}

/**
 * Validates one change set.
 *
 * `ok: false` means it must not be integrated at all. `stale` entries mean the
 * project moved underneath it and the set needs re-basing by its author.
 */
export function validateChangeSet(input: ValidateChangeSetInput): ChangeValidation {
  const { changeSet, contents, current } = input;
  const problems: ChangeProblem[] = [];
  const stale: { path: string; reason: string }[] = [];
  const byPath = new Map(current.files.map((file) => [file.path, file]));

  if (changeSet.files.length === 0) {
    problems.push(problem('CHANGE_SET_EMPTY', null, 'The change set proposes no changes.'));
  }
  if (changeSet.files.length > CHANGE_INTEGRATION_LIMITS.maxFilesPerChangeSet) {
    problems.push(
      problem(
        'CHANGE_SET_TOO_LARGE',
        null,
        `A change set may propose at most ${CHANGE_INTEGRATION_LIMITS.maxFilesPerChangeSet} files.`,
      ),
    );
  }

  const normalized: string[] = [];
  let totalBytes = 0;

  for (const file of changeSet.files) {
    const safe = normalizeChangePath(file.path);
    if (safe === null) {
      problems.push(
        problem('CHANGE_SET_PATH_UNSAFE', file.path, `"${file.path}" is not an acceptable path.`),
      );
      continue;
    }
    normalized.push(safe);

    const allowed = changeSet.authorization.allowedPaths;
    if (allowed.length === 0 || !matchesAny(safe, allowed)) {
      problems.push(
        problem(
          'CHANGE_SET_UNAUTHORIZED_PATH',
          safe,
          `${safe} is outside the paths this assignment was given (${allowed.join(', ') || 'none'}).`,
        ),
      );
    }
    if (matchesAny(safe, changeSet.authorization.excludedPaths)) {
      problems.push(
        problem('CHANGE_SET_EXCLUDED_PATH', safe, `${safe} is excluded by this assignment.`),
      );
    }

    const content = contents.get(file.path) ?? contents.get(safe) ?? null;
    const currentFile = byPath.get(safe) ?? null;

    if (file.op === 'delete') {
      if (content !== null) {
        problems.push(
          problem('CHANGE_SET_DELETE_WITH_CONTENT', safe, 'A deletion must not carry content.'),
        );
      }
      if (file.proposedHash !== null) {
        problems.push(
          problem(
            'CHANGE_SET_OPERATION_INVALID',
            safe,
            'A deletion must not propose a content hash.',
          ),
        );
      }
      if (file.baseHash === null) {
        problems.push(
          problem('CHANGE_SET_HASH_MISSING', safe, 'A deletion must say which content it deletes.'),
        );
      }
      if (currentFile === null) {
        stale.push({ path: safe, reason: 'The file this set deletes no longer exists.' });
      } else if (file.baseHash !== null && currentFile.contentHash !== file.baseHash) {
        stale.push({ path: safe, reason: 'The file changed after this set was drafted.' });
      }
      continue;
    }

    if (content === null) {
      problems.push(
        problem(
          'CHANGE_SET_HASH_MISSING',
          safe,
          'The proposed content for this file could not be found.',
        ),
      );
      continue;
    }

    const bytes = byteLength(content);
    totalBytes += bytes;
    if (file.proposedHash === null || !isContentHash(file.proposedHash)) {
      problems.push(
        problem(
          'CHANGE_SET_HASH_INVALID',
          safe,
          'The proposed content hash is missing or malformed.',
        ),
      );
    } else if (contentHash(content) !== file.proposedHash) {
      problems.push(
        problem(
          'CHANGE_SET_HASH_INVALID',
          safe,
          'The proposed content does not match the hash the worker reported.',
        ),
      );
    }

    if (looksLikeCredential(content)) {
      problems.push(
        problem(
          'CHANGE_SET_SECRET_REJECTED',
          safe,
          'That file looks like it contains a credential, so it was refused.',
        ),
      );
    }

    if (file.op === 'create') {
      if (file.baseHash !== null) {
        problems.push(
          problem('CHANGE_SET_OPERATION_INVALID', safe, 'A new file must not claim a base hash.'),
        );
      }
      if (currentFile !== null) {
        stale.push({ path: safe, reason: 'The file this set creates already exists.' });
      }
    } else {
      if (file.baseHash === null) {
        problems.push(
          problem(
            'CHANGE_SET_UPDATE_WITHOUT_BASE',
            safe,
            'An update must say which content it started from.',
          ),
        );
      }
      if (currentFile === null) {
        stale.push({ path: safe, reason: 'The file this set updates no longer exists.' });
      } else if (file.baseHash !== null && currentFile.contentHash !== file.baseHash) {
        stale.push({ path: safe, reason: 'The file changed after this set was drafted.' });
      }
    }
  }

  for (const duplicate of duplicatePaths(normalized)) {
    problems.push(
      problem('CHANGE_SET_PATH_DUPLICATE', duplicate, `${duplicate} appears more than once.`),
    );
  }

  if (totalBytes > CHANGE_INTEGRATION_LIMITS.maxBytesPerChangeSet) {
    problems.push(
      problem(
        'CHANGE_SET_TOO_LARGE',
        null,
        'The change set carries more content than one integration may apply.',
      ),
    );
  }

  if (changeSet.baseRevision > current.revision) {
    problems.push(
      problem(
        'CHANGE_SET_PROJECT_MISMATCH',
        null,
        'The change set was drafted against a revision this project has never had.',
      ),
    );
  }

  // A whole-project drift is only interesting when it makes a file stale, so it
  // is reported as a note on the set rather than as a problem of its own.
  if (changeSet.baseRevision < current.revision && stale.length === 0 && !input.allowStale) {
    // Nothing this set touches changed; it can still be applied.
  }

  return { ok: problems.length === 0, problems, stale };
}

/** Convenience: the files of a set whose proposed hash differs from the base. */
export function changedFiles(changeSet: WorkerChangeSet): readonly ChangeFile[] {
  return changeSet.files.filter((file) => file.proposedHash !== file.baseHash);
}
