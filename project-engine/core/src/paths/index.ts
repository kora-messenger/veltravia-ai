/**
 * Path validation and normalization for the virtual file tree.
 *
 * Paths are workspace-relative POSIX-style strings (`src/App.tsx`). Everything
 * else is rejected: traversal (`../`), absolute host paths (`/etc/passwd`),
 * Windows paths (`C:\Windows\System32`), null bytes, control characters, and
 * malformed segments. The engine never converts these to host paths - the
 * future sandbox system owns that mapping.
 */

import { InvalidPathError } from '../errors/index.js';

export const MAX_PATH_LENGTH = 512;
export const MAX_PATH_DEPTH = 64;
export const MAX_SEGMENT_LENGTH = 255;

/** Reason codes used by InvalidPathError (stable for tests). */
export const PATH_REJECTION_REASONS = [
  'not-a-string',
  'empty',
  'null-byte',
  'control-character',
  'backslash-separator',
  'absolute-path',
  'windows-drive-path',
  'traversal-segment',
  'dot-segment',
  'empty-segment',
  'trailing-slash',
  'segment-too-long',
  'path-too-long',
  'path-too-deep',
] as const;

export type PathRejectionReason = (typeof PATH_REJECTION_REASONS)[number];

const NULL_BYTE = '\0';
/* eslint-disable no-control-regex -- rejecting control characters is the entire
   point of this pattern. */
const CONTROL_PATTERN = /[\x00-\x1f\u007f]/;
/* eslint-enable no-control-regex */
const DRIVE_LETTER_PATTERN = /^[a-zA-Z]:/;

/**
 * Validates a raw workspace-relative path and returns the normalized form.
 * Throws a scrubbed `InvalidPathError` on any violation.
 *
 * Normal form: no leading or trailing slash, no `.`/`..` segments, single `/`
 * separators, POSIX separators only.
 */
export function normalizePath(raw: string): string {
  const reason = rejectReason(raw);
  if (reason !== null) {
    throw new InvalidPathError(raw, reason);
  }
  return raw;
}

/** Non-throwing variant: returns the rejection reason or `null` when valid. */
export function rejectReason(raw: string): PathRejectionReason | null {
  if (typeof raw !== 'string') return 'not-a-string';
  if (raw.length === 0) return 'empty';
  if (raw.includes(NULL_BYTE)) return 'null-byte';
  if (CONTROL_PATTERN.test(raw)) return 'control-character';
  if (raw.includes('\\')) return 'backslash-separator';
  if (raw.startsWith('/')) return 'absolute-path';
  if (DRIVE_LETTER_PATTERN.test(raw)) return 'windows-drive-path';
  if (raw.endsWith('/')) return 'trailing-slash';

  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '..') return 'traversal-segment';
    if (segment === '.') return 'dot-segment';
    if (segment.length === 0) return 'empty-segment';
    if (segment.length > MAX_SEGMENT_LENGTH) return 'segment-too-long';
  }
  if (raw.length > MAX_PATH_LENGTH) return 'path-too-long';
  if (segments.length > MAX_PATH_DEPTH) return 'path-too-deep';
  return null;
}

/** True when the path is valid and normalized. */
export function isValidPath(raw: string): boolean {
  return rejectReason(raw) === null;
}

/** The tree root path constant (empty string). */
export const ROOT_PATH = '';

/** True if `path` refers to the tree root. */
export function isRootPath(path: string): boolean {
  return path === ROOT_PATH;
}

/** Parent path of a normalized path; the root's parent is `null`. */
export function parentPath(path: string): string | null {
  if (isRootPath(path)) return null;
  const index = path.lastIndexOf('/');
  return index === -1 ? ROOT_PATH : path.slice(0, index);
}

/** Final segment (name) of a normalized path. */
export function baseName(path: string): string {
  if (isRootPath(path)) return '';
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** Splits a normalized path into its segments. */
export function pathSegments(path: string): string[] {
  return isRootPath(path) ? [] : path.split('/');
}

/**
 * True if `candidate` equals or lies inside `ancestor`.
 * Both paths must already be normalized.
 */
export function isDescendantOrSelf(ancestor: string, candidate: string): boolean {
  if (ancestor === candidate) return true;
  if (ancestor === ROOT_PATH) return true;
  return candidate.startsWith(`${ancestor}/`);
}
