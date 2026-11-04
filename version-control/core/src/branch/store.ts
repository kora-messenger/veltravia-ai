import type { ActiveBranch, Branch } from './types.js';

/**
 * Where branches live. A port, like RevisionStore: the in-memory version below
 * is what tests and local runs use; a database-backed one can replace it
 * without touching the manager.
 */
export interface BranchStore {
  createBranch(branch: Branch): Promise<void>;
  getBranch(branchId: string): Promise<Branch | null>;
  /** Every branch of the project, archived ones included. */
  listBranches(projectId: string): Promise<Branch[]>;
  /** Replaces a branch record. Branch records are small and fully rewritten. */
  updateBranch(branch: Branch): Promise<void>;
  deleteBranch(branchId: string): Promise<void>;
  getActive(projectId: string): Promise<ActiveBranch | null>;
  setActive(active: ActiveBranch): Promise<void>;
  /** The branch that owns a workspace, if any. */
  findByWorkspace(workspaceId: string): Promise<Branch | null>;
}

export class InMemoryBranchStore implements BranchStore {
  private readonly branches = new Map<string, Branch>();
  private readonly active = new Map<string, ActiveBranch>();

  async createBranch(branch: Branch): Promise<void> {
    this.branches.set(branch.id, branch);
  }

  async getBranch(branchId: string): Promise<Branch | null> {
    return this.branches.get(branchId) ?? null;
  }

  async listBranches(projectId: string): Promise<Branch[]> {
    return [...this.branches.values()]
      .filter((branch) => branch.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async updateBranch(branch: Branch): Promise<void> {
    this.branches.set(branch.id, branch);
  }

  async deleteBranch(branchId: string): Promise<void> {
    this.branches.delete(branchId);
  }

  async getActive(projectId: string): Promise<ActiveBranch | null> {
    return this.active.get(projectId) ?? null;
  }

  async setActive(active: ActiveBranch): Promise<void> {
    this.active.set(active.projectId, active);
  }

  async findByWorkspace(workspaceId: string): Promise<Branch | null> {
    for (const branch of this.branches.values()) {
      if (branch.workspaceId === workspaceId) return branch;
    }
    return null;
  }
}
