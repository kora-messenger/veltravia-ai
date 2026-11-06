import { createHash } from 'node:crypto';

import {
  assertSafeApiPath,
  type GitHubTransport,
  type GitHubTransportRequest,
  type GitHubTransportResponse,
} from './transport.js';

/**
 * An offline GitHub that behaves like Git where synchronisation depends on it.
 *
 * - Commits form a history: each has a parent, a tree and a message.
 * - A tree is a snapshot of every file at that commit.
 * - A branch is a pointer to a commit, and each branch has its own files.
 * - Moving a branch is fast-forward only: the new commit must descend from the
 *   current head, otherwise 422, exactly like GitHub with force=false.
 * - Objects are content-addressed, so the same bytes always give the same sha.
 *
 * It exists so the sync engine's tests exercise real branch, divergence and
 * rejected-push behaviour instead of a fixture that ignores branches.
 */

interface FakeCommitObject {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly treeSha: string;
  readonly message: string;
}

interface FakeTree {
  readonly sha: string;
  /** path -> blob sha */
  readonly files: ReadonlyMap<string, string>;
}

interface FakeGitRepo {
  readonly owner: string;
  readonly name: string;
  readonly visibility: 'public' | 'private';
  readonly defaultBranch: string;
  readonly refs: Map<string, string>; // branch -> commit sha
  readonly commits: Map<string, FakeCommitObject>;
  readonly trees: Map<string, FakeTree>;
  readonly blobs: Map<string, Uint8Array>;
}

const sha1 = (...parts: string[]): string =>
  createHash('sha1').update(parts.join('\u0000')).digest('hex');

export interface FakeGitDataOptions {
  readonly repositories: readonly {
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch?: string;
    readonly visibility?: 'public' | 'private';
    /** Files on the default branch's first commit. */
    readonly files?: Record<string, string | Uint8Array>;
  }[];
}

export class FakeGitDataTransport implements GitHubTransport {
  private readonly repos: FakeGitRepo[] = [];
  /** Every request, for assertions about what was and was not sent. */
  readonly requests: GitHubTransportRequest[] = [];
  /** Throws on the Nth request counted from now (1 = the next one), to model failures. */
  private failAt: number | null = null;
  private failFor = 0;
  private failStatus = 500;
  private down = false;
  /** Makes the next `count` requests answer `status`, then normal service resumes. */
  failNext(count: number, status = 500): void {
    this.failAt = 1;
    this.failFor = count;
    this.failStatus = status;
  }

  /** Called just before a ref moves; a test uses it to push in the middle of a sync. */
  beforeRefUpdate: (() => void) | null = null;

  constructor(options: FakeGitDataOptions) {
    for (const spec of options.repositories) {
      const defaultBranch = spec.defaultBranch ?? 'main';
      const repo: FakeGitRepo = {
        owner: spec.owner,
        name: spec.name,
        visibility: spec.visibility ?? 'private',
        defaultBranch,
        refs: new Map(),
        commits: new Map(),
        trees: new Map(),
        blobs: new Map(),
      };
      this.repos.push(repo);
      const files = new Map<string, string>();
      for (const [path, content] of Object.entries(spec.files ?? {})) {
        files.set(path, this.putBlob(repo, content));
      }
      const tree = this.putTree(repo, files);
      const commit = this.putCommit(repo, [], tree.sha, 'Initial commit');
      repo.refs.set(defaultBranch, commit.sha);
    }
  }

  // -- test controls ---------------------------------------------------------

  failNthRequest(n: number, status = 500): void {
    this.failAt = this.requests.length + n;
    this.failStatus = status;
  }

  setDown(down: boolean): void {
    this.down = down;
  }

  /** Every file on a branch, path -> text. A reading helper for tests. */
  files(owner: string, name: string, branch: string): Map<string, string> {
    const repo = this.find(owner, name);
    const head = repo.refs.get(branch);
    if (head === undefined) return new Map();
    const out = new Map<string, string>();
    for (const [path, sha] of this.commitTree(repo, head).files) {
      const bytes = repo.blobs.get(sha);
      if (bytes !== undefined) out.set(path, Buffer.from(bytes).toString('utf8'));
    }
    return out;
  }

  /** Make a commit directly on a branch, as if someone else pushed. */
  pushDirect(
    owner: string,
    name: string,
    branch: string,
    changes: Record<string, string | null>,
    message = 'Direct push',
  ): string {
    const repo = this.find(owner, name);
    const head = repo.refs.get(branch);
    if (head === undefined) throw new Error(`no branch ${branch}`);
    const base = this.commitTree(repo, head);
    const files = new Map(base.files);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, this.putBlob(repo, content));
    }
    const tree = this.putTree(repo, files);
    const commit = this.putCommit(repo, [head], tree.sha, message);
    repo.refs.set(branch, commit.sha);
    return commit.sha;
  }

  /** Create a branch pointing at an existing branch's head. */
  branchFrom(owner: string, name: string, from: string, branch: string): void {
    const repo = this.find(owner, name);
    const head = repo.refs.get(from);
    if (head === undefined) throw new Error(`no branch ${from}`);
    repo.refs.set(branch, head);
  }

  head(owner: string, name: string, branch: string): string | undefined {
    return this.find(owner, name).refs.get(branch);
  }

  commitCount(owner: string, name: string): number {
    return this.find(owner, name).commits.size;
  }

  /** Files at a branch head as text, for asserting what really landed. */
  filesAt(owner: string, name: string, branch: string): Record<string, string> {
    const repo = this.find(owner, name);
    const head = repo.refs.get(branch);
    if (head === undefined) throw new Error(`no branch ${branch}`);
    const out: Record<string, string> = {};
    for (const [path, blob] of this.commitTree(repo, head).files) {
      out[path] = Buffer.from(repo.blobs.get(blob) ?? new Uint8Array()).toString('utf8');
    }
    return out;
  }

  commitMessage(owner: string, name: string, sha: string): string | undefined {
    return this.find(owner, name).commits.get(sha)?.message;
  }

  parentsOf(owner: string, name: string, sha: string): readonly string[] {
    return this.find(owner, name).commits.get(sha)?.parents ?? [];
  }

  // -- storage ---------------------------------------------------------------

  private find(owner: string, name: string): FakeGitRepo {
    const repo = this.repos.find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.name.toLowerCase() === name.toLowerCase(),
    );
    if (repo === undefined) throw new Error(`no repo ${owner}/${name}`);
    return repo;
  }

  private putBlob(repo: FakeGitRepo, content: string | Uint8Array): string {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    // Git's real blob hash: sha1("blob <length>\0" + content). A caller that
    // computes the same value from the text - the project side of a sync does
    // exactly that - must get the same answer, or the fake would be lying about
    // the one thing the comparison depends on.
    const sha = createHash('sha1')
      .update(`blob ${String(bytes.length)}\u0000`)
      .update(bytes)
      .digest('hex');
    repo.blobs.set(sha, bytes);
    return sha;
  }

  private putTree(repo: FakeGitRepo, files: ReadonlyMap<string, string>): FakeTree {
    const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
    const sha = sha1('tree', ...sorted.map(([p, b]) => `${p}:${b}`));
    const tree: FakeTree = { sha, files: new Map(sorted) };
    repo.trees.set(sha, tree);
    return tree;
  }

  private putCommit(
    repo: FakeGitRepo,
    parents: readonly string[],
    treeSha: string,
    message: string,
  ): FakeCommitObject {
    const sha = sha1('commit', parents.join(','), treeSha, message, String(repo.commits.size));
    const commit: FakeCommitObject = { sha, parents, treeSha, message };
    repo.commits.set(sha, commit);
    return commit;
  }

  private commitTree(repo: FakeGitRepo, commitSha: string): FakeTree {
    const commit = repo.commits.get(commitSha);
    const tree = commit === undefined ? undefined : repo.trees.get(commit.treeSha);
    if (tree === undefined) throw new Error('missing commit or tree');
    return tree;
  }

  private descends(repo: FakeGitRepo, from: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (next === ancestor) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(repo.commits.get(next)?.parents ?? []));
    }
    return false;
  }

  // -- the transport ---------------------------------------------------------

  async request(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    assertSafeApiPath(request.path);
    this.requests.push(request);
    if (this.down) throw new Error('fetch failed (offline)');
    // A run of injected failures, or a single one at an exact position.
    if (this.failFor > 0) {
      this.failFor -= 1;
      if (this.failFor === 0) this.failAt = null;
      return { status: this.failStatus, body: { message: `injected failure ${this.failStatus}` } };
    }
    if (this.failAt !== null && this.requests.length === this.failAt) {
      this.failAt = null;
      return { status: this.failStatus, body: { message: `injected failure ${this.failStatus}` } };
    }
    return this.dispatch(request);
  }

  private dispatch(request: GitHubTransportRequest): GitHubTransportResponse {
    const notFound = { status: 404, body: { message: 'Not Found' } };
    if (request.path === '/user/repos') {
      return {
        status: 200,
        body: this.repos.map((r) => ({
          name: r.name,
          owner: { login: r.owner },
          description: '',
          private: r.visibility === 'private',
          visibility: r.visibility,
          default_branch: r.defaultBranch,
          updated_at: '2026-01-01T00:00:00Z',
        })),
      };
    }
    const segments = request.path.split('/').filter((s) => s.length > 0);
    if (segments[0] !== 'repos' || segments.length < 3) return notFound;
    const repo = this.repos.find(
      (r) =>
        r.owner.toLowerCase() === (segments[1] ?? '').toLowerCase() &&
        r.name.toLowerCase() === (segments[2] ?? '').toLowerCase(),
    );
    if (repo === undefined) return notFound;
    const rest = segments.slice(3);

    if (rest.length === 0 && request.method === 'GET') {
      return {
        status: 200,
        body: {
          name: repo.name,
          owner: { login: repo.owner },
          description: '',
          private: repo.visibility === 'private',
          visibility: repo.visibility,
          default_branch: repo.defaultBranch,
          updated_at: '2026-01-01T00:00:00Z',
        },
      };
    }

    if (rest[0] === 'branches' && request.method === 'GET') {
      if (rest.length === 1) {
        return {
          status: 200,
          body: [...repo.refs.entries()].map(([name, sha]) => ({ name, commit: { sha } })),
        };
      }
      const name = decodeURIComponent(rest.slice(1).join('/'));
      const sha = repo.refs.get(name);
      return sha === undefined ? notFound : { status: 200, body: { name, commit: { sha } } };
    }

    if (rest[0] === 'git') return this.dispatchGit(repo, rest.slice(1), request);

    // GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
    if (rest[0] === 'contents' && request.method === 'GET' && rest.length > 1) {
      const path = decodeURIComponent(rest.slice(1).join('/'));
      const ref = typeof request.query?.['ref'] === 'string' ? request.query['ref'] : undefined;
      const branch = ref ?? repo.defaultBranch;
      const headSha = repo.refs.get(branch);
      if (headSha === undefined) return notFound;
      const tree = this.commitTree(repo, headSha);
      const blobSha = tree.files.get(path);
      if (blobSha === undefined) return notFound;
      const bytes = repo.blobs.get(blobSha);
      if (bytes === undefined) return notFound;
      // Text is returned base64-encoded as GitHub does. A blob that is not
      // valid UTF-8 answers as a listing marker (encoding "none"), which is how
      // a binary file is reported - never as decoded data.
      const text = Buffer.from(bytes).toString('utf8');
      const isText = Buffer.from(text, 'utf8').equals(Buffer.from(bytes));
      return {
        status: 200,
        body: isText
          ? {
              path,
              sha: blobSha,
              size: bytes.length,
              encoding: 'base64',
              content: Buffer.from(bytes).toString('base64'),
            }
          : { path, sha: blobSha, size: bytes.length, encoding: 'none', content: '' },
      };
    }

    return notFound;
  }

  private dispatchGit(
    repo: FakeGitRepo,
    rest: string[],
    request: GitHubTransportRequest,
  ): GitHubTransportResponse {
    const notFound = { status: 404, body: { message: 'Not Found' } };
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (rest[0] === 'commits' && request.method === 'GET' && rest[1] !== undefined) {
      const commit = repo.commits.get(rest[1]);
      return commit === undefined
        ? notFound
        : { status: 200, body: { sha: commit.sha, tree: { sha: commit.treeSha } } };
    }

    if (rest[0] === 'trees' && request.method === 'GET' && rest[1] !== undefined) {
      const tree = repo.trees.get(rest[1]);
      if (tree === undefined) return notFound;
      return {
        status: 200,
        body: {
          sha: tree.sha,
          truncated: false,
          tree: [...tree.files.entries()].map(([path, sha]) => ({
            path,
            mode: '100644',
            type: 'blob',
            sha,
            size: repo.blobs.get(sha)?.byteLength ?? 0,
          })),
        },
      };
    }

    if (rest[0] === 'blobs' && request.method === 'GET' && rest[1] !== undefined) {
      const blob = repo.blobs.get(rest[1]);
      if (blob === undefined) return notFound;
      return {
        status: 200,
        body: {
          sha: rest[1],
          size: blob.byteLength,
          encoding: 'base64',
          content: Buffer.from(blob).toString('base64'),
        },
      };
    }

    if (rest[0] === 'blobs' && request.method === 'POST') {
      if (typeof body['content'] !== 'string' || body['encoding'] !== 'base64') {
        return { status: 422, body: { message: 'Invalid blob' } };
      }
      const sha = this.putBlob(repo, Buffer.from(body['content'], 'base64'));
      return { status: 201, body: { sha } };
    }

    if (rest[0] === 'trees' && request.method === 'POST') {
      const baseSha = body['base_tree'];
      const base = typeof baseSha === 'string' ? repo.trees.get(baseSha) : undefined;
      if (base === undefined || !Array.isArray(body['tree'])) {
        return { status: 422, body: { message: 'Invalid tree' } };
      }
      const files = new Map(base.files);
      for (const entry of body['tree'] as Record<string, unknown>[]) {
        const path = String(entry['path']);
        if (entry['sha'] === null) {
          files.delete(path);
        } else if (typeof entry['sha'] === 'string' && repo.blobs.has(entry['sha'])) {
          files.set(path, entry['sha']);
        } else {
          return { status: 422, body: { message: 'Tree references a missing blob' } };
        }
      }
      return { status: 201, body: { sha: this.putTree(repo, files).sha } };
    }

    if (rest[0] === 'commits' && request.method === 'POST') {
      const parents = Array.isArray(body['parents']) ? (body['parents'] as string[]) : [];
      const treeSha = typeof body['tree'] === 'string' ? body['tree'] : '';
      if (!repo.trees.has(treeSha) || parents.some((p) => !repo.commits.has(p))) {
        return { status: 422, body: { message: 'Invalid commit' } };
      }
      const commit = this.putCommit(repo, parents, treeSha, String(body['message'] ?? ''));
      return { status: 201, body: { sha: commit.sha } };
    }

    if (rest[0] === 'refs' && request.method === 'PATCH' && rest[1] === 'heads') {
      const branch = decodeURIComponent(rest.slice(2).join('/'));
      const current = repo.refs.get(branch);
      const target = typeof body['sha'] === 'string' ? body['sha'] : '';
      if (current === undefined) return notFound;
      if (!repo.commits.has(target)) return { status: 422, body: { message: 'Object not found' } };
      this.beforeRefUpdate?.();
      const now = repo.refs.get(branch) as string;
      // force=false: the new commit must contain the current head.
      if (body['force'] !== false || !this.descends(repo, target, now)) {
        return { status: 422, body: { message: 'Update is not a fast forward' } };
      }
      repo.refs.set(branch, target);
      return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: target } } };
    }

    return notFound;
  }
}
