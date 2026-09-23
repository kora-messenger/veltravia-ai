import { createHash, randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import { FileAuthorizationError, FileIntelligenceError, UnsafePathError } from '../errors/index.js';
import type { FileLimits, FilePrincipal, FileScope, FileStatus } from '../types/index.js';

export const HARD_FILE_LIMIT_CEILINGS: FileLimits = Object.freeze({
  maxSingleFileBytes: 100 * 1024 * 1024,
  maxArchiveUncompressedBytes: 500 * 1024 * 1024,
  maxArchiveEntries: 5000,
  maxPathLength: 512,
  maxNestingDepth: 20,
  maxArtifactBytesPerOperation: 500 * 1024 * 1024,
  maxTextExtractionCharacters: 2_000_000,
  maxCompressionRatio: 200,
  maxPreviewCharacters: 20_000,
});
export const DEFAULT_FILE_LIMITS: FileLimits = Object.freeze({
  maxSingleFileBytes: 25 * 1024 * 1024,
  maxArchiveUncompressedBytes: 100 * 1024 * 1024,
  maxArchiveEntries: 1000,
  maxPathLength: 240,
  maxNestingDepth: 12,
  maxArtifactBytesPerOperation: 100 * 1024 * 1024,
  maxTextExtractionCharacters: 250_000,
  maxCompressionRatio: 100,
  maxPreviewCharacters: 8_000,
});
export function resolveFileLimits(input: Partial<FileLimits> = {}): FileLimits {
  const out = { ...DEFAULT_FILE_LIMITS, ...input };
  for (const key of Object.keys(HARD_FILE_LIMIT_CEILINGS) as (keyof FileLimits)[]) {
    if (!Number.isFinite(out[key]) || out[key] <= 0 || out[key] > HARD_FILE_LIMIT_CEILINGS[key]) {
      throw new FileIntelligenceError(
        'FILE_LIMIT_EXCEEDED',
        `Limit ${key} is outside the safe range.`,
        { limit: key, ceiling: HARD_FILE_LIMIT_CEILINGS[key] },
      );
    }
  }
  return Object.freeze(out);
}
export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;
const CONFUSABLE_SEPARATORS = /[\u2215\u2044\u29F8\uFF0F\uFF3C]/g;
export function normalizeSafePath(
  raw: string,
  maxLength = DEFAULT_FILE_LIMITS.maxPathLength,
): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new UnsafePathError('empty');
  if (raw.includes('\0')) throw new UnsafePathError('null-byte');
  const unicode = raw.normalize('NFKC').replace(CONFUSABLE_SEPARATORS, '/').replaceAll('\\', '/');
  const decoded = (() => {
    try {
      return decodeURIComponent(unicode);
    } catch {
      throw new UnsafePathError('malformed-encoding');
    }
  })();
  if (/^[A-Za-z]:\//.test(decoded)) throw new UnsafePathError('windows-drive');
  if (decoded.startsWith('/') || decoded.startsWith('//')) throw new UnsafePathError('absolute');
  if (decoded.includes('%') && /%(?:2e|2f|5c|00)/i.test(decoded))
    throw new UnsafePathError('double-encoding');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded) || decoded.includes(':'))
    throw new UnsafePathError('control-or-colon');
  const segments = decoded.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..'))
    throw new UnsafePathError('traversal-or-empty-segment');
  const normalized = posix.normalize(decoded);
  if (normalized.startsWith('../') || normalized === '..' || normalized.length > maxLength)
    throw new UnsafePathError(normalized.length > maxLength ? 'too-long' : 'traversal');
  if (/^[.~]$/.test(basename(normalized))) throw new UnsafePathError('reserved');
  return normalized;
}
export function normalizeFilename(
  raw: string,
  maxLength = DEFAULT_FILE_LIMITS.maxPathLength,
): string {
  const path = normalizeSafePath(raw, maxLength);
  if (path.includes('/')) throw new UnsafePathError('filename-must-not-contain-directory');
  return path;
}
export function authorizeScope(principal: FilePrincipal, scope: FileScope): void {
  if (principal.ownerRef !== scope.ownerRef) throw new FileAuthorizationError();
  if (
    scope.projectId &&
    principal.allowedProjectIds &&
    !principal.allowedProjectIds.includes(scope.projectId)
  )
    throw new FileAuthorizationError();
  if (
    scope.workspaceId &&
    principal.allowedWorkspaceIds &&
    !principal.allowedWorkspaceIds.includes(scope.workspaceId)
  )
    throw new FileAuthorizationError();
}
const TRANSITIONS: Record<FileStatus, readonly FileStatus[]> = {
  received: ['validating', 'deleted'],
  validating: ['validated', 'rejected', 'corrupted'],
  validated: ['extracting', 'ready', 'processing', 'expired', 'deleted'],
  extracting: ['ready', 'derived', 'rejected', 'corrupted'],
  ready: ['extracting', 'processing', 'derived', 'expired', 'deleted', 'corrupted'],
  processing: ['ready', 'derived', 'rejected', 'corrupted'],
  derived: ['extracting', 'processing', 'expired', 'deleted', 'corrupted'],
  expired: ['deleted'],
  deleted: [],
  rejected: ['deleted'],
  corrupted: ['deleted'],
};
export function assertFileTransition(from: FileStatus, to: FileStatus): void {
  if (!TRANSITIONS[from].includes(to))
    throw new FileIntelligenceError(
      'FILE_INVALID_TRANSITION',
      `File cannot transition from ${from} to ${to}.`,
      { from, to },
    );
}
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /AIzaSy[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
export function scrubSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((v, p) => v.replace(p, '[redacted]'), value);
}
export function safeDownloadFilename(value: string): string {
  return normalizeFilename(value).replace(/["\r\n]/g, '_');
}
