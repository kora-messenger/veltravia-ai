/**
 * The Version Control gateway port (Step 18).
 *
 * Version Control NEVER touches a filesystem and never owns tree state: the
 * Project Engine remains the single authority. This port is the ONLY way
 * version control observes and restores a workspace tree, so a future
 * deployment adapter only re-implements this interface.
 *
 *   Version Control -> VersionWorkspaceGateway -> Project Engine
 *
 * Every restore mutation flows through here - and the API's rollback route
 * reaches this port ONLY through the Tool System (`project.rollback`).
 */

export interface GatewayWorkspaceInfo {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: string;
}

/** One tree node as the gateway reports it (content only for files). */
export interface GatewayNode {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly content: string | null;
}

/** A single restore step. The adapter applies these through the Project Engine. */
export type RestoreStep =
  | { readonly kind: 'create_directory'; readonly path: string }
  | { readonly kind: 'create_file'; readonly path: string; readonly content: string }
  | { readonly kind: 'update_file'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete_file'; readonly path: string }
  | { readonly kind: 'delete_directory'; readonly path: string };

export interface VersionWorkspaceGateway {
  /** Unknown ids throw typed errors the API maps to 404/409. */
  getWorkspace(workspaceId: string): Promise<GatewayWorkspaceInfo>;
  /** All nodes of the workspace tree, sorted by path. */
  listNodes(workspaceId: string): Promise<readonly GatewayNode[]>;
  /**
   * Applies a validated restore plan through the Project Engine, scoped to
   * one workspace. The adapter revalidates every path/revision at the engine
   * boundary; a failed step aborts the whole restore (typed error, no
   * partial-success claims by version control itself).
   */
  applyRestore(workspaceId: string, steps: readonly RestoreStep[]): Promise<void>;
}
