import { InMemoryRevisionStore } from '@veltravia/version-mock';
import {
  BranchManager,
  InMemoryBranchStore,
  VersionControlManager,
  type BranchWorkspaceGateway,
  type GatewayNode,
  type GatewayWorkspaceInfo,
  type RestoreStep,
  type VersionWorkspaceGateway,
} from '@veltravia/version-core';

/**
 * A small fake of the Workspace Engine for tests: every workspace is its own
 * file tree, and its revision counter goes up on each write, as the real one's
 * does. Implements both ports so a test drives branching end to end offline.
 */
export class FakeWorkspaces implements VersionWorkspaceGateway, BranchWorkspaceGateway {
  private readonly trees = new Map<string, Map<string, GatewayNode>>();
  private readonly info = new Map<string, { projectId: string; revision: number }>();
  private counter = 0;
  /** Set to make the next seed fail, to test clean-up. */
  failNextSeed = false;
  readonly discarded: string[] = [];

  addWorkspace(projectId: string, files: Record<string, string> = {}): string {
    this.counter += 1;
    const id = `ws-${this.counter}`;
    this.info.set(id, { projectId, revision: 1 });
    const tree = new Map<string, GatewayNode>();
    this.trees.set(id, tree);
    for (const [path, content] of Object.entries(files)) this.put(id, path, content);
    return id;
  }

  private put(workspaceId: string, path: string, content: string): void {
    const tree = this.trees.get(workspaceId);
    if (tree === undefined) throw new Error('no such workspace');
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!tree.has(dir)) tree.set(dir, { path: dir, type: 'directory', size: 0, content: null });
    }
    tree.set(path, { path, type: 'file', size: content.length, content });
  }

  /** What a person editing a file does: change content and bump the revision. */
  write(workspaceId: string, path: string, content: string): void {
    this.put(workspaceId, path, content);
    this.bump(workspaceId);
  }

  remove(workspaceId: string, path: string): void {
    this.trees.get(workspaceId)?.delete(path);
    this.bump(workspaceId);
  }

  read(workspaceId: string, path: string): string | null {
    return this.trees.get(workspaceId)?.get(path)?.content ?? null;
  }

  paths(workspaceId: string): string[] {
    return [...(this.trees.get(workspaceId)?.keys() ?? [])].sort();
  }

  has(workspaceId: string): boolean {
    return this.trees.has(workspaceId);
  }

  private bump(workspaceId: string): void {
    const info = this.info.get(workspaceId);
    if (info !== undefined) info.revision += 1;
  }

  // VersionWorkspaceGateway
  async getWorkspace(workspaceId: string): Promise<GatewayWorkspaceInfo> {
    const info = this.info.get(workspaceId);
    if (info === undefined) throw new Error('no such workspace');
    return { projectId: info.projectId, workspaceId, revision: info.revision, status: 'active' };
  }

  async listNodes(workspaceId: string): Promise<readonly GatewayNode[]> {
    return [...(this.trees.get(workspaceId)?.values() ?? [])].map((n) => ({ ...n }));
  }

  async applyRestore(workspaceId: string, steps: readonly RestoreStep[]): Promise<void> {
    for (const step of steps) {
      if (step.kind === 'create_directory') {
        this.trees
          .get(workspaceId)
          ?.set(step.path, { path: step.path, type: 'directory', size: 0, content: null });
      } else if (step.kind === 'create_file' || step.kind === 'update_file') {
        this.put(workspaceId, step.path, step.content);
      } else {
        this.trees.get(workspaceId)?.delete(step.path);
      }
      this.bump(workspaceId);
    }
  }

  // BranchWorkspaceGateway
  async createWorkspace(projectId: string, _name: string): Promise<{ workspaceId: string }> {
    return { workspaceId: this.addWorkspace(projectId) };
  }

  async seedWorkspace(workspaceId: string, steps: readonly RestoreStep[]): Promise<void> {
    if (this.failNextSeed) {
      this.failNextSeed = false;
      throw new Error('disk full');
    }
    await this.applyRestore(workspaceId, steps);
  }

  async discardWorkspace(workspaceId: string): Promise<void> {
    this.trees.delete(workspaceId);
    this.info.delete(workspaceId);
    this.discarded.push(workspaceId);
  }
}

export function makeHarness() {
  let n = 0;
  const workspaces = new FakeWorkspaces();
  const versions = new VersionControlManager({
    store: new InMemoryRevisionStore(),
    gateway: workspaces,
    generateId: () => `id-${(n += 1)}`,
    now: () => new Date('2026-11-04T10:00:00.000Z'),
  });
  const branches = new BranchManager({
    versions,
    store: new InMemoryBranchStore(),
    workspaces,
    generateId: () => `id-${(n += 1)}`,
    now: () => new Date('2026-11-04T10:00:00.000Z'),
  });
  return { workspaces, versions, branches };
}
