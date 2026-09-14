/**
 * Maps validated GitHub API payloads into stable Veltravia views. Only the
 * declared fields survive; everything else GitHub returns (private metadata,
 * URLs, permissions blocks, owner objects) is DROPPED here, never passed
 * upward to tools, agents, or API responses.
 */

import { GitHubError } from './errors.js';
import type {
  GitHubBranch,
  GitHubCommit,
  GitHubDirectoryEntry,
  GitHubFile,
  GitHubRepository,
} from './types.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Content size cap applied to file reads before they enter any tool result. */
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024;

/** Maps one /repos entry into the stable GitHubRepository view. */
export function mapRepository(raw: unknown): GitHubRepository {
  if (raw === null || typeof raw !== 'object') {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'malformed repository payload');
  }
  const record = raw as Record<string, unknown>;
  const owner = asString((record.owner as { login?: unknown } | null)?.login);
  const repository = asString(record.name);
  if (owner.length === 0 || repository.length === 0) {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'repository payload is missing its identity');
  }
  const visibilityRaw = asString(record.visibility).toLowerCase();
  const visibility: GitHubRepository['visibility'] =
    typeof record.private === 'boolean' && record.private
      ? 'private'
      : visibilityRaw === 'public'
        ? 'public'
        : visibilityRaw === 'private'
          ? 'private'
          : 'unknown';
  return {
    owner,
    repository,
    description: asString(record.description),
    visibility,
    defaultBranch: asString(record.default_branch),
    updatedAt: asNullableString(record.updated_at),
  };
}

/** Maps one branch entry into the stable GitHubBranch view. */
export function mapBranch(raw: unknown): GitHubBranch {
  if (raw === null || typeof raw !== 'object') {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'malformed branch payload');
  }
  const record = raw as Record<string, unknown>;
  const name = asString(record.name);
  const sha = asString((record.commit as { sha?: unknown } | null)?.sha);
  if (name.length === 0 || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'branch payload is missing name or sha');
  }
  return { name, sha };
}

/** Maps one contents entry (file) into the stable GitHubFile view. */
export function mapFile(raw: unknown): GitHubFile {
  if (raw === null || typeof raw !== 'object') {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'malformed file payload');
  }
  const record = raw as Record<string, unknown>;
  const path = asString(record.path);
  const sha = asString(record.sha);
  if (path.length === 0 || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'file payload is missing path or sha');
  }
  const size = typeof record.size === 'number' ? record.size : 0;
  if (size > MAX_FILE_CONTENT_BYTES) {
    throw new GitHubError(
      'GITHUB_INVALID_RESPONSE',
      `file "${path.slice(0, 80)}" exceeds the readable size cap`,
    );
  }
  const encoding = asString(record.encoding);
  if (encoding === 'base64') {
    const encoded = asString(record.content);
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      return { path, sha, size, content: decoded, encoding: 'utf-8' };
    } catch {
      throw new GitHubError('GITHUB_INVALID_RESPONSE', 'file payload could not be decoded');
    }
  }
  // Binary content is returned as a listing marker only - never as data.
  return { path, sha, size, content: null, encoding: 'none' };
}

/** Maps one directory entry into the stable GitHubDirectoryEntry view. */
export function mapDirectoryEntry(raw: unknown): GitHubDirectoryEntry {
  if (raw === null || typeof raw !== 'object') {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'malformed directory entry');
  }
  const record = raw as Record<string, unknown>;
  const name = asString(record.name);
  const path = asString(record.path);
  const typeRaw = asString(record.type);
  const type: GitHubDirectoryEntry['type'] = typeRaw === 'dir' ? 'dir' : 'file';
  if (name.length === 0 || path.length === 0) {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'directory entry is missing name or path');
  }
  return { name, path, type, size: typeof record.size === 'number' ? record.size : 0 };
}

/** Maps one commit payload into the stable GitHubCommit view. */
export function mapCommit(
  raw: unknown,
  path: string,
  branch: string,
  fallbackMessage: string,
): GitHubCommit {
  if (raw === null || typeof raw !== 'object') {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'malformed commit payload');
  }
  const record = raw as Record<string, unknown>;
  const sha = asString(record.sha);
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    throw new GitHubError('GITHUB_INVALID_RESPONSE', 'commit payload is missing its sha');
  }
  const message =
    asString((record.commit as { message?: unknown } | null)?.message) || fallbackMessage;
  return { sha, message, path, branch };
}
