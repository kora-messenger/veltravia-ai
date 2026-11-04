import {
  BranchManager,
  InMemoryBranchStore,
  VersionControlManager,
  VersionError,
  type BranchWorkspaceGateway,
  type GatewayNode,
  type VersionWorkspaceGateway,
} from '@veltravia/version-core';
import { InMemoryRevisionStore } from '@veltravia/version-mock';
import { isProjectError, type ProjectEngine } from '@veltravia/project-core';

/**
 * Version Control API service (Step 18).
 *
 * Wires the VersionControlManager to the REAL Project Engine through the
 * gateway port: the engine stays the single authority for tree state, and
 * every restore step flows through its validated file-tree operations.
 *
 * Development/CI limitation (honest, same as every current service): the
 * revision store is the DETERMINISTIC IN-MEMORY mock - state lives per
 * process and is wiped on restart. Swapping in a persistent store means
 * implementing the same RevisionStore interface; nothing else changes.
 */

/** Maps a ProjectEngine typed error into the version-control namespace. */
function toVersionError(error: unknown): VersionError {
  if (isProjectError(error)) {
    const code =
      error.code === 'PROJECT_NOT_FOUND'
        ? 'VERSION_PROJECT_NOT_FOUND'
        : error.code === 'WORKSPACE_NOT_FOUND'
          ? 'VERSION_WORKSPACE_NOT_FOUND'
          : 'VERSION_VALIDATION_FAILED';
    return new VersionError(code, error.message, { cause: error.code });
  }
  return new VersionError(
    'VERSION_VALIDATION_FAILED',
    error instanceof Error ? error.message : 'unexpected failure',
  );
}

export interface VersionControlServiceOptions {
  readonly projectEngine: ProjectEngine;
  /**
   * A manager made elsewhere (tests inject one). Branches are then built on
   * THAT manager, so they see the same revisions rather than a second store.
   */
  readonly manager?: VersionControlManager;
  readonly now?: () => Date;
  readonly onAudit?: (event: { readonly type: string }) => void;
  readonly retention?: {
    readonly maxRevisionsPerWorkspace?: number;
    readonly maxCheckpointsPerWorkspace?: number;
  };
}

export interface VersionControlService {
  readonly manager: VersionControlManager;
  /** Branches over the same revisions (Step 38). */
  readonly branches: BranchManager;
}

export function createVersionControlService(
  options: VersionControlServiceOptions,
): VersionControlService {
  const engine = options.projectEngine;
  const now = options.now ?? (() => new Date());

  /**
   * The gateway adapter: ALL tree access for version control flows through
   * the Project Engine here. No filesystem, no host paths.
   */
  const gateway: VersionWorkspaceGateway = {
    getWorkspace: async (workspaceId) => {
      try {
        const workspace = await engine.workspaces.getWorkspace(workspaceId);
        return {
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          revision: workspace.revision,
          status: workspace.status,
        };
      } catch (error) {
        throw toVersionError(error);
      }
    },
    listNodes: async (workspaceId) => {
      try {
        const nodes = await engine.files.listAll(workspaceId);
        const listed: GatewayNode[] = [];
        for (const node of nodes) {
          if (node.path === '') continue; // the tree root is implicit
          if (node.type === 'directory') {
            listed.push({ path: node.path, type: 'directory', size: 0, content: null });
            continue;
          }
          const { content } = await engine.files.readFile(workspaceId, node.path);
          listed.push({ path: node.path, type: 'file', size: content.length, content });
        }
        listed.sort((a, b) => a.path.localeCompare(b.path));
        return listed;
      } catch (error) {
        throw toVersionError(error);
      }
    },
    applyRestore: async (workspaceId, steps) => {
      try {
        for (const step of steps) {
          if (step.kind === 'create_directory') {
            await engine.files.createDirectory(workspaceId, step.path);
          } else if (step.kind === 'create_file') {
            await engine.files.createFile(workspaceId, {
              path: step.path,
              content: step.content,
            });
          } else if (step.kind === 'update_file') {
            // Read the CURRENT node revision fresh, so a concurrent edit
            // surfaces as an honest engine conflict instead of a blind
            // overwrite (the manager rechecks expectedCurrentRevision first).
            const { node } = await engine.files.readFile(workspaceId, step.path);
            await engine.files.updateFile(workspaceId, step.path, {
              content: step.content,
              expectedRevision: node.revision,
            });
          } else if (step.kind === 'delete_file') {
            await engine.files.deleteFile(workspaceId, step.path);
          } else {
            await engine.files.deleteDirectory(workspaceId, step.path);
          }
        }
      } catch (error) {
        throw toVersionError(error);
      }
    },
  };

  const manager =
    options.manager ??
    new VersionControlManager({
      store: new InMemoryRevisionStore(),
      gateway,
      now,
      auditSink: (event) => {
        options.onAudit?.(event);
      },
      ...(options.retention ? { policy: { ...options.retention } } : {}),
    });

  /**
   * Branch workspace access, on the same engine. A failed branch creation
   * archives the half-made workspace rather than deleting it: the engine has no
   * delete, and hiding is the safer thing to do with files anyway.
   */
  const branchWorkspaces: BranchWorkspaceGateway = {
    createWorkspace: async (projectId, name) => {
      try {
        const workspace = await engine.workspaces.createWorkspace(projectId, { name });
        return { workspaceId: workspace.id };
      } catch (error) {
        throw toVersionError(error);
      }
    },
    seedWorkspace: (workspaceId, steps) => gateway.applyRestore(workspaceId, steps),
    discardWorkspace: async (workspaceId) => {
      try {
        await engine.workspaces.archiveWorkspace(workspaceId);
      } catch (error) {
        throw toVersionError(error);
      }
    },
  };

  const branches = new BranchManager({
    versions: manager,
    store: new InMemoryBranchStore(),
    workspaces: branchWorkspaces,
    now,
  });

  return { manager, branches };
}
