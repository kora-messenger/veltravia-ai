/**
 * The offline, deterministic fake GitHub transport.
 *
 * It simulates ONLY the API surface the connector declares: repositories,
 * branches, file contents, commits - plus the failure modes the security
 * model must handle (401/403/404/409/422/429/5xx, timeout, network error,
 * invalid payloads, malicious repository content). No network, no host
 * filesystem, no credentials. The normal test suite depends on NOTHING real.
 */

import type {
  GitHubTransport,
  GitHubTransportRequest,
  GitHubTransportResponse,
} from './transport.js';
import { assertSafeApiPath } from './transport.js';

interface FakeFile {
  readonly path: string;
  content: string;
  sha: string;
  size: number;
}

interface FakeCommit {
  readonly sha: string;
  readonly message: string;
  readonly path: string;
  readonly branch: string;
}

interface FakeRepositoryState {
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: 'public' | 'private';
  readonly defaultBranch: string;
  readonly branches: Map<string, string>; // branch -> head sha
  readonly files: Map<string, FakeFile>; // path -> file (per default branch, suffices for tests)
  readonly commits: FakeCommit[];
}

export interface FakeGitHubState {
  readonly repositories: FakeRepositoryState[];
}

export interface FakeGitHubTransportOptions {
  readonly state?: FakeGitHubState;
  /** When set, every request fails with this status before dispatch. */
  readonly failStatus?: number;
  /** When true, requests throw a network-level error instead of answering. */
  readonly networkDown?: boolean;
  /** When true, requests simulate a timeout instead of answering. */
  readonly timeout?: boolean;
  /** Count of leading requests that must answer 429 before normal service. */
  readonly rateLimitBursts?: number;
}

function makeSha(seed: string, counter: number): string {
  const base = `${seed}:${counter}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < base.length; i += 1) {
    hash ^= base.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let sha = '';
  let value = hash;
  while (sha.length < 40) {
    value = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    sha += value.toString(16).padStart(8, '0');
  }
  return sha.slice(0, 40);
}

/** A deterministic fixture repository state factory. */
export function createFakeRepository(input: {
  owner: string;
  name: string;
  defaultBranch?: string;
  description?: string;
  visibility?: 'public' | 'private';
  files?: Record<string, string>;
}): FakeRepositoryState {
  const defaultBranch = input.defaultBranch ?? 'main';
  const branches = new Map<string, string>([
    [defaultBranch, makeSha(`${input.owner}/${input.name}`, 0)],
  ]);
  const files = new Map<string, FakeFile>();
  let counter = 1;
  for (const [path, content] of Object.entries(input.files ?? {})) {
    const sha = makeSha(path, counter);
    counter += 1;
    files.set(path, { path, content, sha, size: content.length });
  }
  return {
    owner: input.owner,
    name: input.name,
    description: input.description ?? '',
    visibility: input.visibility ?? 'public',
    defaultBranch,
    branches,
    files,
    commits: [],
  };
}

/** The full offline fake: repositories + branches + files + commits. */
export class FakeGitHubTransport implements GitHubTransport {
  private readonly state: FakeGitHubState;
  private failStatus?: number;
  private networkDown = false;
  private timeout = false;
  private rateLimitBursts = 0;
  /** Every request that reached the transport, for security assertions. */
  readonly requests: GitHubTransportRequest[] = [];

  constructor(options: FakeGitHubTransportOptions = {}) {
    this.state = options.state ?? { repositories: [] };
    this.failStatus = options.failStatus;
    this.networkDown = options.networkDown ?? false;
    this.timeout = options.timeout ?? false;
    this.rateLimitBursts = options.rateLimitBursts ?? 0;
  }

  get repositories(): FakeRepositoryState[] {
    return this.state.repositories;
  }

  setFailure(status?: number): void {
    this.failStatus = status;
  }

  setNetworkDown(down: boolean): void {
    this.networkDown = down;
  }

  setTimeout(timeout: boolean): void {
    this.timeout = timeout;
  }

  triggerRateLimit(bursts: number): void {
    this.rateLimitBursts = bursts;
  }

  /** Adds or replaces a file directly (fixture setup). */
  writeFile(owner: string, name: string, path: string, content: string): void {
    const repo = this.find(owner, name);
    repo.files.set(path, {
      path,
      content,
      sha: makeSha(path, repo.files.size + 1),
      size: content.length,
    });
  }

  private find(owner: string, name: string): FakeRepositoryState {
    const repo = this.state.repositories.find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.name.toLowerCase() === name.toLowerCase(),
    );
    if (repo === undefined) {
      return {
        owner,
        name,
        description: '',
        visibility: 'public',
        defaultBranch: 'main',
        branches: new Map(),
        files: new Map(),
        commits: [],
      };
    }
    return repo;
  }

  async request(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    assertSafeApiPath(request.path);
    this.requests.push(request);
    if (this.networkDown) {
      throw new Error('fetch failed (offline)');
    }
    if (this.timeout) {
      throw new Error('aborted');
    }
    if (this.failStatus !== undefined) {
      return { status: this.failStatus, body: { message: `injected failure ${this.failStatus}` } };
    }
    if (this.rateLimitBursts > 0) {
      this.rateLimitBursts -= 1;
      return {
        status: 429,
        body: { message: 'rate limited', retry_after: 0 },
      };
    }
    return this.dispatch(request);
  }

  private dispatch(request: GitHubTransportRequest): GitHubTransportResponse {
    const segments = request.path.split('/').filter((segment) => segment.length > 0);
    const query = request.query ?? {};

    // /user/repos
    if (request.path === '/user/repos') {
      return {
        status: 200,
        body: this.state.repositories.map((repo) => ({
          name: repo.name,
          owner: { login: repo.owner },
          description: repo.description,
          private: repo.visibility === 'private',
          visibility: repo.visibility,
          default_branch: repo.defaultBranch,
          updated_at: '2026-01-01T00:00:00Z',
        })),
      };
    }

    // /repos/{owner}/{repo}[/contents...|/branches...|/git/refs]
    if (segments[0] !== 'repos' || segments.length < 3) {
      return { status: 404, body: { message: 'Not Found' } };
    }
    const owner = segments[1] ?? '';
    const name = segments[2] ?? '';
    const repo = this.state.repositories.find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.name.toLowerCase() === name.toLowerCase(),
    );
    if (repo === undefined) {
      return { status: 404, body: { message: 'Not Found' } };
    }

    // GET /repos/{owner}/{repo}
    if (segments.length === 3 && request.method === 'GET') {
      return {
        status: 200,
        body: {
          name: repo.name,
          owner: { login: repo.owner },
          description: repo.description,
          private: repo.visibility === 'private',
          visibility: repo.visibility,
          default_branch: repo.defaultBranch,
          updated_at: '2026-01-01T00:00:00Z',
        },
      };
    }

    // /repos/{owner}/{repo}/branches[/{branch}]
    if (segments[3] === 'branches') {
      if (segments.length === 4 && request.method === 'GET') {
        return {
          status: 200,
          body: [...repo.branches.entries()].map(([branchName, sha]) => ({
            name: branchName,
            commit: { sha },
          })),
        };
      }
      if (segments.length === 5 && request.method === 'GET') {
        const branchName = decodeURIComponent(segments[4] ?? '');
        const sha = repo.branches.get(branchName);
        if (sha === undefined) {
          return { status: 404, body: { message: 'branch not found' } };
        }
        return { status: 200, body: { name: branchName, commit: { sha } } };
      }
      return { status: 404, body: { message: 'Not Found' } };
    }

    // POST /repos/{owner}/{repo}/git/refs (create branch)
    if (segments[3] === 'git' && segments[4] === 'refs' && request.method === 'POST') {
      const body = (request.body ?? {}) as { ref?: string; sha?: string };
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const fromSha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
        return { status: 422, body: { message: 'invalid ref' } };
      }
      const branchName = ref.slice('refs/heads/'.length);
      if (repo.branches.has(branchName)) {
        return { status: 422, body: { message: 'Reference already exists' } };
      }
      const head = makeSha(`${branchName}:${fromSha}`, repo.commits.length + 1);
      repo.branches.set(branchName, head);
      return { status: 201, body: { ref, object: { sha: head } } };
    }

    // /repos/{owner}/{repo}/contents[/{path}]
    if (segments[3] === 'contents' && request.method === 'GET') {
      const branch = typeof query.ref === 'string' ? query.ref : repo.defaultBranch;
      if (!repo.branches.has(branch)) {
        return { status: 404, body: { message: 'branch not found' } };
      }
      const repoPath = segments
        .slice(4)
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      if (repoPath === '') {
        // Directory listing of the root or a subdirectory.
        const entries = new Map<
          string,
          { name: string; path: string; type: 'file' | 'dir'; size: number; sha: string }
        >();
        for (const file of repo.files.values()) {
          const rest = file.path;
          const slash = rest.indexOf('/');
          if (slash === -1) {
            entries.set(rest, {
              name: rest,
              path: file.path,
              type: 'file',
              size: file.size,
              sha: file.sha,
            });
          } else {
            const dirName = rest.slice(0, slash);
            if (!entries.has(dirName)) {
              entries.set(dirName, {
                name: dirName,
                path: `${repoPath === '' ? '' : `${repoPath}/`}${dirName}`,
                type: 'dir',
                size: 0,
                sha: '0'.repeat(40),
              });
            }
          }
        }
        return { status: 200, body: [...entries.values()] };
      }
      const file = repo.files.get(repoPath);
      if (file === undefined) {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return {
        status: 200,
        body: {
          path: file.path,
          sha: file.sha,
          size: file.size,
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(file.content, 'utf-8').toString('base64'),
        },
      };
    }

    // PUT /repos/{owner}/{repo}/contents (create-or-update file)
    if (segments[3] === 'contents' && segments.length === 4 && request.method === 'PUT') {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const path = typeof body.path === 'string' ? body.path : '';
      const message = typeof body.message === 'string' ? body.message : '';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const content = typeof body.content === 'string' ? body.content : '';
      if (!repo.branches.has(branch)) {
        return { status: 422, body: { message: `branch ${branch} does not exist` } };
      }
      const existing = repo.files.get(path);
      if (existing !== undefined && typeof body.sha !== 'string') {
        return { status: 422, body: { message: 'sha was not provided and the file exists' } };
      }
      if (existing !== undefined && body.sha !== existing.sha) {
        return {
          status: 409,
          body: { message: 'the file changed since it was read - re-read and retry' },
        };
      }
      if (existing === undefined && body.sha !== undefined) {
        return { status: 422, body: { message: 'sha provided for a file that does not exist' } };
      }
      const decoded = Buffer.from(content, 'base64').toString('utf-8');
      const newSha = makeSha(`${path}:${repo.commits.length + 1}`, repo.commits.length + 2);
      const commit: FakeCommit = {
        sha: makeSha(`commit:${message}`, repo.commits.length + 3),
        message,
        path,
        branch,
      };
      repo.files.set(path, { path, content: decoded, sha: newSha, size: decoded.length });
      repo.commits.push(commit);
      repo.branches.set(branch, commit.sha);
      return {
        status: existing === undefined ? 201 : 200,
        body: {
          content: { path, sha: newSha },
          commit: { sha: commit.sha, message },
        },
      };
    }

    // DELETE /repos/{owner}/{repo}/contents (delete file)
    if (segments[3] === 'contents' && segments.length === 4 && request.method === 'DELETE') {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const path = typeof body.path === 'string' ? body.path : '';
      const message = typeof body.message === 'string' ? body.message : '';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const file = repo.files.get(path);
      if (file === undefined) {
        return { status: 404, body: { message: 'Not Found' } };
      }
      if (typeof body.sha !== 'string' || body.sha !== file.sha) {
        return {
          status: 409,
          body: { message: 'the file changed since it was read - re-read and retry' },
        };
      }
      const commit: FakeCommit = {
        sha: makeSha(`delete:${path}`, repo.commits.length + 4),
        message,
        path,
        branch,
      };
      repo.files.delete(path);
      repo.commits.push(commit);
      repo.branches.set(branch, commit.sha);
      return { status: 200, body: { content: null, commit: { sha: commit.sha, message } } };
    }

    return { status: 404, body: { message: 'Not Found' } };
  }
}
