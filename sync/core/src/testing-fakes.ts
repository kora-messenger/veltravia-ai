import { randomUUID } from 'node:crypto';

import { contentSha } from './hash.js';
import type {
  LocalProjectPort,
  LocalSnapshot,
  PublishInput,
  RemotePort,
  RemoteSnapshot,
} from './ports.js';
import type { BranchChoice, RepositoryChoice } from './types.js';

export interface FakeProject {
  readonly projectId: string;
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly name: string;
}

/** A local project that behaves like the real one where sync notices. */
export class FakeLocalPort implements LocalProjectPort {
  readonly projects = new Map<string, FakeProject>();
  readonly files = new Map<string, Map<string, string>>();
  readonly revisions = new Map<string, number>();
  /** Called after every write, to simulate a concurrent edit. */
  onWrite: (() => void) | undefined;

  addProject(input: { projectId: string; ownerRef: string; name?: string }): void {
    this.projects.set(input.projectId, {
      projectId: input.projectId,
      ownerRef: input.ownerRef,
      workspaceId: `ws_${input.projectId}`,
      name: input.name ?? 'Demo',
    });
    this.files.set(`ws_${input.projectId}`, new Map());
    this.revisions.set(`ws_${input.projectId}`, 0);
  }

  write(projectId: string, path: string, content: string): void {
    const files = this.files.get(`ws_${projectId}`);
    if (files === undefined) throw new Error('no project');
    files.set(path, content);
    this.revisions.set(`ws_${projectId}`, (this.revisions.get(`ws_${projectId}`) ?? 0) + 1);
  }

  remove(projectId: string, path: string): void {
    this.files.get(`ws_${projectId}`)?.delete(path);
    this.revisions.set(`ws_${projectId}`, (this.revisions.get(`ws_${projectId}`) ?? 0) + 1);
  }

  read(projectId: string, path: string): string | undefined {
    return this.files.get(`ws_${projectId}`)?.get(path);
  }

  paths(projectId: string): string[] {
    return [...(this.files.get(`ws_${projectId}`)?.keys() ?? [])].sort();
  }

  async resolveProject(input: { ownerRef: string; projectId: string }) {
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.ownerRef !== input.ownerRef) return null;
    return { projectId: project.projectId, workspaceId: project.workspaceId, name: project.name };
  }

  async readSnapshot(workspaceId: string): Promise<LocalSnapshot> {
    const files = this.files.get(workspaceId) ?? new Map<string, string>();
    return {
      revision: this.revisions.get(workspaceId) ?? 0,
      files: [...files].map(([path, content]) => ({ path, content })),
    };
  }

  async currentRevision(workspaceId: string): Promise<number> {
    return this.revisions.get(workspaceId) ?? 0;
  }

  async writeFile(workspaceId: string, path: string, content: string): Promise<void> {
    const files = this.files.get(workspaceId);
    if (files === undefined) throw new Error('no workspace');
    files.set(path, content);
    this.revisions.set(workspaceId, (this.revisions.get(workspaceId) ?? 0) + 1);
    this.onWrite?.();
  }

  async deleteFile(workspaceId: string, path: string): Promise<void> {
    this.files.get(workspaceId)?.delete(path);
    this.revisions.set(workspaceId, (this.revisions.get(workspaceId) ?? 0) + 1);
    this.onWrite?.();
  }
}

interface FakeBranch {
  files: Map<string, string>;
  head: string;
  commits: { sha: string; message: string; paths: string[]; parent: string }[];
}

/** A remote that rejects a push whose base is not the branch head, like GitHub. */
export class FakeRemotePort implements RemotePort {
  readonly allowed: RepositoryChoice[] = [
    {
      owner: 'acme',
      repository: 'notes',
      visibility: 'private',
      defaultBranch: 'main',
      description: 'Notes service',
    },
    {
      owner: 'acme',
      repository: 'site',
      visibility: 'public',
      defaultBranch: 'main',
      description: 'Marketing site',
    },
  ];
  readonly repos = new Map<string, { branches: Map<string, FakeBranch>; isDefault: string }>();
  failPublish: 'none' | 'head-moved' | 'api-error' = 'none';
  publishCalls: PublishInput[] = [];
  truncated = false;
  /** Files with no readable text, e.g. an image. */
  binaryPaths = new Set<string>();

  constructor() {
    this.addBranch('acme', 'notes', 'main', true);
    this.addBranch('acme', 'notes', 'feature', false);
    this.addBranch('acme', 'site', 'main', true);
  }

  private key(owner: string, repository: string): string {
    return `${owner}/${repository}`;
  }

  addBranch(owner: string, repository: string, branch: string, isDefault: boolean): void {
    const key = this.key(owner, repository);
    const repo = this.repos.get(key) ?? { branches: new Map(), isDefault: branch };
    repo.branches.set(branch, { files: new Map(), head: `head0_${branch}`, commits: [] });
    if (isDefault) repo.isDefault = branch;
    this.repos.set(key, repo);
  }

  /** Test setup: put a file on a branch without a commit being made through sync. */
  seed(owner: string, repository: string, branch: string, path: string, content: string): void {
    const b = this.branch(owner, repository, branch);
    b.files.set(path, content);
  }

  seedBinary(owner: string, repository: string, branch: string, path: string): void {
    this.seed(owner, repository, branch, path, '\u0000binary');
    this.binaryPaths.add(path);
  }

  /** Test setup: move the branch head, as another person's push would. */
  moveHead(owner: string, repository: string, branch: string): void {
    const b = this.branch(owner, repository, branch);
    b.head = `${b.head}+`;
  }

  files(owner: string, repository: string, branch: string): string[] {
    return [...this.branch(owner, repository, branch).files.keys()].sort();
  }

  content(owner: string, repository: string, branch: string, path: string): string | undefined {
    return this.branch(owner, repository, branch).files.get(path);
  }

  branchCount(): number {
    return [...this.repos.values()].reduce((n, r) => n + r.branches.size, 0);
  }

  private branch(owner: string, repository: string, branch: string): FakeBranch {
    const repo = this.repos.get(this.key(owner, repository));
    const b = repo?.branches.get(branch);
    if (b === undefined) throw new Error(`no branch ${owner}/${repository}@${branch}`);
    return b;
  }

  async listRepositories(): Promise<readonly RepositoryChoice[]> {
    return this.allowed;
  }

  async listBranches(owner: string, repository: string): Promise<readonly BranchChoice[]> {
    const repo = this.repos.get(this.key(owner, repository));
    if (repo === undefined) return [];
    return [...repo.branches].map(([name, b]) => ({
      name,
      headSha: b.head,
      isDefault: name === repo.isDefault,
    }));
  }

  async readSnapshot(owner: string, repository: string, branch: string): Promise<RemoteSnapshot> {
    const b = this.branch(owner, repository, branch);
    return {
      headSha: b.head,
      files: [...b.files].map(([path, content]) => {
        const binary = this.binaryPaths.has(path);
        return {
          path,
          hashOfText: binary ? null : contentSha(content),
          size: content.length,
          notText: binary ? ('binary' as const) : null,
        };
      }),
      skipped: 0,
      truncated: this.truncated,
    };
  }

  async readText(
    owner: string,
    repository: string,
    branch: string,
    path: string,
  ): Promise<string | null> {
    if (this.binaryPaths.has(path)) return null;
    return this.branch(owner, repository, branch).files.get(path) ?? null;
  }

  async publish(input: PublishInput): Promise<{ commitSha: string }> {
    this.publishCalls.push(input);
    if (this.failPublish === 'api-error') {
      throw new Error('GitHub answered 500');
    }
    const b = this.branch(input.owner, input.repository, input.branch);
    if (this.failPublish === 'head-moved' || input.expectedHeadSha !== b.head) {
      const error = new Error('not a fast-forward');
      (error as { code?: string }).code = 'GITHUB_CONFLICT';
      throw error;
    }
    for (const change of input.changes) {
      if (change.content === null) b.files.delete(change.path);
      else b.files.set(change.path, change.content);
    }
    const sha = `commit_${b.commits.length + 1}_${randomUUID().slice(0, 6)}`;
    b.commits.push({
      sha,
      message: input.message,
      paths: input.changes.map((c) => c.path),
      parent: b.head,
    });
    b.head = sha;
    return { commitSha: sha };
  }
}
