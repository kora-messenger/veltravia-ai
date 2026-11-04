import type { RestoreStep } from '../gateway/index.js';

/**
 * What branching needs from the Workspace Engine that revisions do not: a way
 * to make a NEW workspace for a branch, and to retire one.
 *
 * Kept apart from VersionWorkspaceGateway on purpose, so the Step 18 port that
 * rollback depends on does not change. Seeding reuses the same RestoreStep
 * list, so a branch is filled by the code path already trusted to rewrite a
 * tree.
 */
export interface BranchWorkspaceGateway {
  /** Makes an empty workspace in the project and returns its id. */
  createWorkspace(projectId: string, name: string): Promise<{ readonly workspaceId: string }>;
  /** Writes the steps into the workspace, in order. */
  seedWorkspace(workspaceId: string, steps: readonly RestoreStep[]): Promise<void>;
  /**
   * Removes a workspace that a failed branch creation left behind. Only ever
   * called on a workspace this branch code just made.
   */
  discardWorkspace(workspaceId: string): Promise<void>;
}
