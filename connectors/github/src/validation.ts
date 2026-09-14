/**
 * Untrusted-input validation for every GitHub Connector surface.
 *
 * owner/repository/branch/path/message fields are attacker-controllable
 * model output. They are validated BEFORE any URL is constructed, BEFORE any
 * transport request is shaped, and BEFORE anything is echoed into an error
 * message. A GitHub path is a REPOSITORY path, never a local filesystem
 * path - it is never handed to the host filesystem anywhere in this package.
 */
import { GitHubError } from './errors.js';

export const GITHUB_IDENTIFIER_LIMITS = {
  owner: 100,
  repository: 150,
  branch: 250,
  path: 1000,
  message: 65536,
  content: 1024 * 1024,
  sha: 64,
} as const;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,150}$/;
/* eslint-disable no-control-regex -- rejecting control characters is the entire point. */
const BRANCH_PATTERN =
  /^(?!\/)(?:(?!\/\.)(?!.*\.\.)(?!.*\.$)(?!.*\/\/)(?!.*\{)[^\x00-\x1f\x7f ^~:?*[\]\\]){1,250}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
/* eslint-enable no-control-regex */

/**
 * Input validation failure. Typed as a GitHubError so EVERY failure the
 * connector surfaces to the Tool System carries a machine-readable code -
 * a plain Error would break the typed error contract.
 */
export class GitHubValidationError extends GitHubError {
  constructor(field: string, reason: string) {
    super('GITHUB_INVALID_INPUT', `${field}: ${reason}`);
    this.name = 'GitHubValidationError';
  }
}

function assertString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubValidationError(field, 'must be a non-empty string');
  }
  if (value.length > maxLength) {
    throw new GitHubValidationError(field, `exceeds the maximum length of ${maxLength}`);
  }
  return value;
}

/** Rejects null bytes, control characters, CRLF - URL/HTTP injection guards. */
function assertNoInjection(value: string, field: string): void {
  if (CONTROL_PATTERN.test(value)) {
    throw new GitHubValidationError(field, 'contains forbidden control characters');
  }
  if (value.includes('\r') || value.includes('\n')) {
    throw new GitHubValidationError(field, 'contains line breaks');
  }
}

/** GitHub account/organization owner name. */
export function validateOwner(value: unknown): string {
  const owner = assertString(value, 'owner', GITHUB_IDENTIFIER_LIMITS.owner);
  assertNoInjection(owner, 'owner');
  if (!OWNER_PATTERN.test(owner)) {
    throw new GitHubValidationError('owner', 'is not a valid GitHub owner name');
  }
  return owner;
}

/** GitHub repository name. */
export function validateRepository(value: unknown): string {
  const repository = assertString(value, 'repository', GITHUB_IDENTIFIER_LIMITS.repository);
  assertNoInjection(repository, 'repository');
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new GitHubValidationError('repository', 'is not a valid repository name');
  }
  return repository;
}

/** Git branch/tag reference (e.g. "main", "feature/x-2"). */
export function validateBranch(value: unknown): string {
  const branch = assertString(value, 'branch', GITHUB_IDENTIFIER_LIMITS.branch);
  if (CONTROL_PATTERN.test(branch)) {
    throw new GitHubValidationError('branch', 'contains forbidden control characters');
  }
  if (branch.startsWith('-') || branch.endsWith('.lock')) {
    throw new GitHubValidationError('branch', 'is not a valid git reference');
  }
  if (!BRANCH_PATTERN.test(branch)) {
    throw new GitHubValidationError('branch', 'is not a valid git reference');
  }
  return branch;
}

/**
 * A REPOSITORY path (NOT a local filesystem path). Rejects traversal
 * ("../"), absolute paths, null bytes, control characters, and backslashes
 * before any URL is ever constructed from it.
 */
export function validateGitHubPath(value: unknown): string {
  const path = assertString(value, 'path', GITHUB_IDENTIFIER_LIMITS.path);
  if (CONTROL_PATTERN.test(path)) {
    throw new GitHubValidationError('path', 'contains forbidden control characters');
  }
  if (path.includes('\\')) {
    throw new GitHubValidationError('path', 'contains backslashes');
  }
  if (path.startsWith('/') || path.startsWith('~')) {
    throw new GitHubValidationError('path', 'must be repository-relative, not absolute');
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new GitHubValidationError('path', 'contains traversal or empty segments');
  }
  if (path.endsWith('/')) {
    throw new GitHubValidationError('path', 'must not end with a separator');
  }
  return path;
}

/** A repository directory path (may be '' for the repository root). */
export function validateGitHubDirectory(value: unknown): string {
  if (value === '' || value === undefined || value === null) return '';
  return validateGitHubPath(value);
}

/** Commit message. Untrusted model output - bounded and injection-checked. */
export function validateCommitMessage(value: unknown): string {
  const message = assertString(value, 'message', GITHUB_IDENTIFIER_LIMITS.message);
  if (CONTROL_PATTERN.test(message.replace(/[\r\n\t]/g, ''))) {
    throw new GitHubValidationError('message', 'contains forbidden control characters');
  }
  return message;
}

/** File content (UTF-8 text). Bounded to keep requests and results sane. */
export function validateFileContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new GitHubValidationError('content', 'must be a string');
  }
  if (value.length > GITHUB_IDENTIFIER_LIMITS.content) {
    throw new GitHubValidationError('content', 'exceeds the maximum size of 1 MiB');
  }
  return value;
}

/** Blob/commit SHA - the remote version token for revision protection. */
export function validateSha(value: unknown): string {
  const sha = assertString(value, 'sha', GITHUB_IDENTIFIER_LIMITS.sha);
  if (!SHA_PATTERN.test(sha)) {
    throw new GitHubValidationError('sha', 'is not a valid git object sha');
  }
  return sha;
}

/** Branch name for creation. The "refs/heads/" prefix is internal only. */
export function validateNewBranchName(value: unknown): string {
  const name = validateBranch(value);
  if (name === 'HEAD') {
    throw new GitHubValidationError('branch', 'HEAD is not a valid branch name');
  }
  return name;
}
