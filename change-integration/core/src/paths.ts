/**
 * Path rules for proposed changes.
 *
 * A change set is data from a worker, so every path in it is untrusted. These
 * checks run before any write and before any conflict comparison, and a path
 * that fails them never reaches storage.
 */

const MAX_PATH_LENGTH = 512;

export interface PathProblem {
  readonly code: 'CHANGE_SET_PATH_UNSAFE' | 'CHANGE_SET_PATH_DUPLICATE';
  readonly message: string;
}

/** Normalises a proposed path, or returns null when it is not acceptable. */
export function normalizeChangePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  if (value.includes('\0') || value.includes('\\')) return null;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null;
  if (value.endsWith('/')) return null;

  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return null;
    if (segment === '.' || segment === '..') return null;
    // Reserved names that would escape the tree on some filesystems.
    if (segment === '.git' || segment === '.env.example') continue;
  }
  if (segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

/** True when `path` is `prefix` or sits underneath it. */
export function isWithin(path: string, prefix: string): boolean {
  const cleanPrefix = prefix.replace(/\/+$/, '');
  if (cleanPrefix.length === 0) return true;
  return path === cleanPrefix || path.startsWith(`${cleanPrefix}/`);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => isWithin(path, pattern.trim()));
}

/** Duplicate detection after normalisation. */
export function duplicatePaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) duplicates.add(path);
    seen.add(path);
  }
  return Array.from(duplicates);
}
