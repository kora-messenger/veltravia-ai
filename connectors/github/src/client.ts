/**
 * GitHubClient: the internal API surface of the GitHub Connector.
 *
 * Every capability is an explicitly declared METHOD with a FIXED endpoint and
 * a FIXED HTTP method. There is deliberately NO generic request() here - the
 * AI can only reach what these methods expose, through the Tool System, and
 * only for operations the connector declares. This is what prevents the
 * connector from becoming an unrestricted network proxy.
 *
 * Retry policy: GET requests retry ONCE on 429 (respecting a bounded
 * Retry-After). Write requests are NEVER retried automatically - a duplicated
 * write is worse than a visible failure.
 */

import { GitHubError } from './errors.js';
import type { GitHubTransport } from './transport.js';
import {
  validateBranch,
  validateCommitMessage,
  validateFileContent,
  validateGitHubPath,
  validateOwner,
  validateRepository,
  validateSha,
} from './validation.js';

/** Statuses for which a GET may safely retry once (rate limit). */
const RETRYABLE_GET_STATUS = 429;
const MAX_GET_RETRIES = 1;
/** Cap honoring a server-provided Retry-After header. */
const MAX_RETRY_AFTER_MS = 5_000;
/** Bounded fallback when the server sends no usable Retry-After. */
const DEFAULT_RETRY_AFTER_MS = 500;

/** Maps a transport response status + body onto a typed GitHubError. */
export function mapGitHubFailure(status: number, body: unknown, path: string): GitHubError {
  const message =
    typeof (body as { message?: unknown })?.message === 'string'
      ? String((body as { message: string }).message).slice(0, 500)
      : 'GitHub request failed';
  switch (true) {
    case status === 401:
      return new GitHubError('GITHUB_UNAUTHORIZED', message, { status });
    case status === 403:
      return new GitHubError('GITHUB_FORBIDDEN', message, { status });
    case status === 404:
      return new GitHubError('GITHUB_NOT_FOUND', message, { status });
    case status === 409:
      return new GitHubError('GITHUB_CONFLICT', message, { status });
    case status === 422:
      return new GitHubError('GITHUB_VALIDATION', message, { status });
    case status === 429:
      return new GitHubError('GITHUB_RATE_LIMITED', message, { status });
    case status >= 500:
      return new GitHubError('GITHUB_SERVER_ERROR', message, { status });
    default:
      return new GitHubError('GITHUB_INVALID_RESPONSE', `unexpected status ${status} on ${path}`, {
        status,
      });
  }
}

interface RawRepository {
  name?: unknown;
  owner?: { login?: unknown } | null;
  description?: unknown;
  private?: unknown;
  default_branch?: unknown;
  updated_at?: unknown;
  visibility?: unknown;
}

interface RawBranch {
  name?: unknown;
  commit?: { sha?: unknown } | null;
}

interface RawContent {
  path?: unknown;
  name?: unknown;
  sha?: unknown;
  size?: unknown;
  type?: unknown;
  content?: unknown;
  encoding?: unknown;
}

interface RawCommit {
  sha?: unknown;
  commit?: { message?: unknown } | null;
}

export interface RawApiDeps {
  readonly transport: GitHubTransport;
  /** Optional bounded delay used for the single safe GET retry. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Creates the GitHub client bound to a transport. The transport may be the
 * HTTPS implementation (production) or the offline fake (tests/CI).
 */
export function createGitHubClient(deps: RawApiDeps): {
  listRepositories: () => Promise<unknown[]>;
  getRepository: (owner: string, repository: string) => Promise<RawRepository>;
  listBranches: (owner: string, repository: string) => Promise<RawBranch[]>;
  getBranch: (owner: string, repository: string, branch: string) => Promise<RawBranch>;
  createBranch: (
    owner: string,
    repository: string,
    branch: string,
    fromSha: string,
  ) => Promise<RawBranch>;
  getFile: (owner: string, repository: string, path: string, branch: string) => Promise<RawContent>;
  listDirectory: (
    owner: string,
    repository: string,
    path: string,
    branch: string,
  ) => Promise<RawContent[]>;
  createOrUpdateFile: (input: {
    owner: string;
    repository: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    expectedSha?: string;
  }) => Promise<RawCommit>;
  deleteFile: (input: {
    owner: string;
    repository: string;
    path: string;
    branch: string;
    message: string;
    sha: string;
  }) => Promise<RawCommit>;
} {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Sends one request. GETs retry once on 429 with a bounded backoff. */
  async function send(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Readonly<Record<string, unknown>>,
    query?: Readonly<Record<string, string | number>>,
  ): Promise<unknown> {
    let attempt = 0;
    // Loop only for the single safe GET retry; writes run exactly once.
    for (;;) {
      const response = await deps.transport.request(
        body === undefined && query !== undefined
          ? { method, path, query }
          : body !== undefined
            ? { method, path, body }
            : { method, path },
      );
      if (response.status >= 200 && response.status < 300) return response.body;
      const failure = mapGitHubFailure(response.status, response.body, path);
      const retryable =
        method === 'GET' && response.status === RETRYABLE_GET_STATUS && attempt < MAX_GET_RETRIES;
      if (!retryable) throw failure;
      attempt += 1;
      const header = (response.body as { retry_after?: unknown })?.retry_after;
      const seconds = typeof header === 'number' ? header : Number(header);
      const waitMs =
        Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
          : DEFAULT_RETRY_AFTER_MS;
      await sleep(waitMs);
    }
  }

  function assertRawObject(value: unknown, what: string): asserts value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new GitHubError('GITHUB_INVALID_RESPONSE', `GitHub returned a non-object for ${what}`);
    }
  }

  function assertRawArray(value: unknown, what: string): asserts value is unknown[] {
    if (!Array.isArray(value)) {
      throw new GitHubError('GITHUB_INVALID_RESPONSE', `GitHub returned a non-array for ${what}`);
    }
  }

  return {
    async listRepositories() {
      const body = await send('GET', '/user/repos', undefined, { per_page: 100, sort: 'pushed' });
      assertRawArray(body, 'repository list');
      return body;
    },

    async getRepository(ownerInput, repositoryInput) {
      const owner = validateOwner(ownerInput);
      const repository = validateRepository(repositoryInput);
      const body = await send('GET', `/repos/${owner}/${repository}`);
      assertRawObject(body, 'repository');
      return body as RawRepository;
    },

    async listBranches(ownerInput, repositoryInput) {
      const owner = validateOwner(ownerInput);
      const repository = validateRepository(repositoryInput);
      const body = await send('GET', `/repos/${owner}/${repository}/branches`, undefined, {
        per_page: 100,
      });
      assertRawArray(body, 'branch list');
      return body as RawBranch[];
    },

    async getBranch(ownerInput, repositoryInput, branchInput) {
      const owner = validateOwner(ownerInput);
      const repository = validateRepository(repositoryInput);
      const branch = validateBranch(branchInput);
      const body = await send(
        'GET',
        `/repos/${owner}/${repository}/branches/${encodeURIComponent(branch)}`,
      );
      assertRawObject(body, 'branch');
      return body as RawBranch;
    },

    async createBranch(ownerInput, repositoryInput, branchInput, fromShaInput) {
      const owner = validateOwner(ownerInput);
      const repository = validateRepository(repositoryInput);
      const branch = validateBranch(branchInput);
      const fromSha = validateSha(fromShaInput);
      // Single declared POST - never retried (a duplicate ref write is a
      // conflict, not something to retry blindly).
      const body = await send('POST', `/repos/${owner}/${repository}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      });
      assertRawObject(body, 'created ref');
      // GitHub answers the created branch with its head sha.
      return {
        name: branch,
        commit: { sha: (body as { object?: { sha?: unknown } }).object?.sha ?? fromSha },
      } satisfies RawBranch;
    },

    async getFile(ownerInput, repositoryInput, pathInput, branchInput) {
      const owner = validateOwner(ownerInput);
      const repository = validateRepository(repositoryInput);
      const path = validateGitHubPath(pathInput);
      const branch = validateBranch(branchInput);
      const body = await send(
        'GET',
        `/repos/${owner}/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
        undefined,
        { ref: branch },
      );
      assertRawObject(body, 'file');
      return body as RawContent;
    },

    async listDirectory(ownerInput, repositoryInput, pathInput, branchInput) {
      const owner = validateOwner(ownerInput);
      const repository = validateRepository(repositoryInput);
      const directory = pathInput === '' ? '' : validateGitHubPath(pathInput);
      const branch = validateBranch(branchInput);
      const suffix =
        directory === '' ? '' : `/${directory.split('/').map(encodeURIComponent).join('/')}`;
      const body = await send('GET', `/repos/${owner}/${repository}/contents${suffix}`, undefined, {
        ref: branch,
        per_page: 100,
      });
      assertRawArray(body, 'directory listing');
      return body as RawContent[];
    },

    async createOrUpdateFile(input) {
      const owner = validateOwner(input.owner);
      const repository = validateRepository(input.repository);
      const path = validateGitHubPath(input.path);
      const branch = validateBranch(input.branch);
      const message = validateCommitMessage(input.message);
      const content = validateFileContent(input.content);
      const body = await send('PUT', `/repos/${owner}/${repository}/contents`, {
        path,
        branch,
        message,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        ...(input.expectedSha !== undefined ? { sha: validateSha(input.expectedSha) } : {}),
      });
      assertRawObject(body, 'file change');
      // GitHub's contents API returns { content, commit }; the caller gets
      // ONLY the commit object - raw content blobs never leak upward.
      assertRawObject((body as { commit?: unknown }).commit, 'commit');
      return (body as { commit: RawCommit }).commit;
    },

    async deleteFile(input) {
      const owner = validateOwner(input.owner);
      const repository = validateRepository(input.repository);
      const path = validateGitHubPath(input.path);
      const branch = validateBranch(input.branch);
      const message = validateCommitMessage(input.message);
      const sha = validateSha(input.sha);
      const body = await send('DELETE', `/repos/${owner}/${repository}/contents`, {
        path,
        branch,
        message,
        sha,
      });
      assertRawObject(body, 'file change');
      assertRawObject((body as { commit?: unknown }).commit, 'commit');
      return (body as { commit: RawCommit }).commit;
    },
  };
}
