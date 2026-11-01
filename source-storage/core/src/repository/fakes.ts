/**
 * Test doubles for the source-storage ports.
 *
 * The fake tree behaves like the real project engine where it matters for this
 * package: paths must exist, revisions are required for updates, deletes fail
 * for unknown paths, and directories must exist before files are created
 * inside them. Tests can also force a failure on a chosen operation to prove
 * the change set rolls back.
 */

import { SourceError } from '../errors/index.js';
import type { SourceProjectsPort, SourceTreeNode, SourceTreePort } from './index.js';

interface Node {
  readonly path: string;
  readonly type: 'file' | 'directory';
  revision: number;
  content: string;
}

export class FakeTreePort implements SourceTreePort {
  private nodes = new Map<string, Node>();
  private root = 1;
  /** Path (or operation marker) that should throw on the next write. */
  failOn: string | null = null;
  /** Count of writes, so concurrency tests can prove ordering. */
  writes = 0;

  seed(paths: Record<string, string>): void {
    for (const [path, content] of Object.entries(paths)) {
      const segments = path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        const directory = segments.slice(0, index).join('/');
        if (!this.nodes.has(directory)) {
          this.nodes.set(directory, {
            path: directory,
            type: 'directory',
            revision: 1,
            content: '',
          });
        }
      }
      this.nodes.set(path, { path, type: 'file', revision: 1, content });
    }
  }

  private require(path: string, type?: 'file' | 'directory'): Node {
    const node = this.nodes.get(path);
    if (node === undefined) {
      throw new SourceError('SOURCE_PATH_NOT_FOUND', `"${path}" does not exist.`, { path });
    }
    if (type !== undefined && node.type !== type) {
      throw new SourceError('SOURCE_PATH_INVALID', `"${path}" is not a ${type}.`, { path });
    }
    return node;
  }

  private maybeFail(marker: string): void {
    this.writes += 1;
    if (this.failOn === marker) {
      this.failOn = null;
      throw new Error('simulated engine failure');
    }
  }

  async listAll(): Promise<readonly SourceTreeNode[]> {
    return [...this.nodes.values()].map((node) => ({
      path: node.path,
      type: node.type,
      revision: node.revision,
      updatedAt: new Date(0).toISOString(),
    }));
  }

  async readFile(
    _workspaceId: string,
    path: string,
  ): Promise<{ revision: number; content: string }> {
    const node = this.require(path, 'file');
    return { revision: node.revision, content: node.content };
  }

  async createFile(
    _workspaceId: string,
    path: string,
    content: string,
  ): Promise<{ revision: number }> {
    this.maybeFail(path);
    if (this.nodes.has(path)) {
      throw new SourceError('SOURCE_PATH_CONFLICT', `"${path}" already exists.`, { path });
    }
    if (path.includes('/')) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      this.require(parent, 'directory');
    }
    this.nodes.set(path, { path, type: 'file', revision: 1, content });
    this.root += 1;
    return { revision: 1 };
  }

  async updateFile(
    _workspaceId: string,
    path: string,
    content: string,
    expectedRevision: number,
  ): Promise<{ revision: number }> {
    this.maybeFail(path);
    const node = this.require(path, 'file');
    if (node.revision !== expectedRevision) {
      throw new SourceError('SOURCE_REVISION_CONFLICT', `"${path}" changed.`, { path });
    }
    node.content = content;
    node.revision += 1;
    this.root += 1;
    return { revision: node.revision };
  }

  async deleteFile(_workspaceId: string, path: string): Promise<void> {
    this.maybeFail(path);
    this.require(path, 'file');
    this.nodes.delete(path);
    this.root += 1;
  }

  async createDirectory(_workspaceId: string, path: string): Promise<{ revision: number }> {
    this.maybeFail(path);
    if (this.nodes.has(path)) {
      throw new SourceError('SOURCE_PATH_CONFLICT', `"${path}" already exists.`, { path });
    }
    this.nodes.set(path, { path, type: 'directory', revision: 1, content: '' });
    this.root += 1;
    return { revision: 1 };
  }

  async deleteDirectory(_workspaceId: string, path: string): Promise<void> {
    this.maybeFail(`${path}/`);
    this.require(path, 'directory');
    for (const key of [...this.nodes.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
    }
    this.root += 1;
  }

  async moveNode(
    _workspaceId: string,
    fromPath: string,
    toDirectory: string,
  ): Promise<{ path: string; revision: number }> {
    this.maybeFail(`move:${fromPath}`);
    const node = this.require(fromPath, 'file');
    const base = fromPath.split('/').pop() ?? fromPath;
    const target = toDirectory === '' ? base : `${toDirectory}/${base}`;
    if (this.nodes.has(target)) {
      throw new SourceError('SOURCE_PATH_CONFLICT', `"${target}" already exists.`, {
        path: target,
      });
    }
    this.nodes.delete(fromPath);
    this.nodes.set(target, { ...node, path: target, revision: node.revision + 1 });
    this.root += 1;
    return { path: target, revision: node.revision + 1 };
  }

  async renameNode(
    _workspaceId: string,
    path: string,
    newName: string,
  ): Promise<{ path: string; revision: number }> {
    this.maybeFail(`rename:${path}`);
    const node = this.require(path, 'file');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const target = parent === '' ? newName : `${parent}/${newName}`;
    this.nodes.delete(path);
    this.nodes.set(target, { ...node, path: target, revision: node.revision + 1 });
    this.root += 1;
    return { path: target, revision: node.revision + 1 };
  }

  async rootRevision(): Promise<number> {
    return this.root;
  }

  snapshotPaths(): string[] {
    return [...this.nodes.values()]
      .filter((node) => node.type === 'file')
      .map((node) => node.path)
      .sort();
  }

  readContent(path: string): string {
    return this.require(path, 'file').content;
  }
}

/** Ownership-aware project resolver: only `ownerOf` owns `projectId`. */
export class FakeProjectsPort implements SourceProjectsPort {
  constructor(
    private readonly repositories: Map<string, { ownerRef: string; workspaceId: string }>,
  ) {}

  async resolveRepository(input: {
    ownerRef: string;
    projectId: string;
    workspaceId?: string;
  }): Promise<{ projectId: string; workspaceId: string } | null> {
    const repository = this.repositories.get(input.projectId);
    if (repository === undefined || repository.ownerRef !== input.ownerRef) return null;
    if (input.workspaceId !== undefined && input.workspaceId !== repository.workspaceId)
      return null;
    return { projectId: input.projectId, workspaceId: repository.workspaceId };
  }
}
