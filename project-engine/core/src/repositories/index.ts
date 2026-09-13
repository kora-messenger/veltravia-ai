/**
 * Provider-neutral persistence interfaces for the Project Engine.
 *
 * The engine assumes NO concrete database: MongoDB, PostgreSQL, SQLite, Redis,
 * or anything else would be a future adapter behind these interfaces. The
 * in-memory implementations (project-engine/mock) are deterministic and
 * keyless, so tests and CI run fully offline.
 *
 * Revision semantics: repositories own the optimistic-concurrency counters.
 * Every successful mutation bumps `revision` and stamps `updatedAt`, so a
 * stale `expectedRevision` can never silently overwrite newer changes.
 */

import type {
  FileNode,
  IntegrationReference,
  NodeType,
  Project,
  ProjectConfig,
  ProjectContext,
  ProjectStatus,
  Workspace,
  WorkspaceStatus,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// ProjectRepository
// ---------------------------------------------------------------------------

export interface NewProject {
  readonly name: string;
  readonly description: string;
  readonly projectType: Project['projectType'];
  readonly ownerRef: string;
  readonly version: string;
  readonly metadata: Record<string, unknown>;
}

/** Change-set for `ProjectRepository.update`. Applied atomically by the implementation. */
export interface ProjectChangeSet {
  readonly patch: {
    name?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    status?: ProjectStatus;
    version?: string;
    workspaceId?: string | null;
  };
  /** Caller's view of the revision; a mismatch rejects the whole change. */
  readonly expectedRevision: number;
  readonly updatedAt: string;
}

export interface ProjectRepository {
  /** Creates a project (initial revision 1). The repository assigns the id. */
  create(input: NewProject): Promise<Project>;
  /** Returns the project INCLUDING soft-deleted ones (restore needs them). */
  get(projectId: string): Promise<Project | null>;
  /** Lists projects, EXCLUDING soft-deleted ones unless `includeDeleted`. */
  list(options?: {
    readonly includeDeleted?: boolean;
    readonly ownerRef?: string;
  }): Promise<Project[]>;
  /** Applies a validated change-set; bumps revision; rejects stale revisions. */
  update(projectId: string, change: ProjectChangeSet): Promise<Project>;
}

// ---------------------------------------------------------------------------
// WorkspaceRepository
// ---------------------------------------------------------------------------

export interface NewWorkspace {
  readonly projectId: string;
  readonly name: string;
  readonly root: string;
  readonly metadata: Record<string, unknown>;
}

export interface WorkspaceChangeSet {
  readonly patch: {
    name?: string;
    metadata?: Record<string, unknown>;
    status?: WorkspaceStatus;
  };
  readonly expectedRevision: number;
  readonly updatedAt: string;
}

export interface WorkspaceRepository {
  /** Creates a workspace (initial revision 1). The repository assigns the id. */
  create(input: NewWorkspace): Promise<Workspace>;
  get(workspaceId: string): Promise<Workspace | null>;
  listByProject(projectId: string): Promise<Workspace[]>;
  /** Applies a validated change-set; bumps revision; rejects stale revisions. */
  update(workspaceId: string, change: WorkspaceChangeSet): Promise<Workspace>;
  /**
   * Bumps the workspace revision after a file-tree mutation (structural
   * revision), stamping `updatedAt`. Used only by the FileTreeManager.
   */
  bumpRevision(workspaceId: string, updatedAt: string): Promise<Workspace>;
}

// ---------------------------------------------------------------------------
// FileRepository
// ---------------------------------------------------------------------------

export interface NewFileNode {
  readonly workspaceId: string;
  /** Validated, normalized workspace-relative path. */
  readonly path: string;
  readonly name: string;
  readonly type: NodeType;
  readonly parentId: string | null;
  readonly content?: string;
  readonly createdAt: string;
}

export interface FileNodeChangeSet {
  readonly patch: {
    path?: string;
    name?: string;
    parentId?: string | null;
    content?: string;
  };
  readonly expectedRevision: number;
  readonly updatedAt: string;
}

export interface FileRepository {
  /** Creates a node (initial revision 1). The repository assigns the id and size. */
  createNode(input: NewFileNode): Promise<FileNode>;
  getNode(workspaceId: string, path: string): Promise<FileNode | null>;
  getNodeById(workspaceId: string, nodeId: string): Promise<FileNode | null>;
  /** Children of a directory path (`''` = root), sorted by path. */
  listChildren(workspaceId: string, path: string): Promise<FileNode[]>;
  /** All nodes in a workspace, sorted by path. */
  listAll(workspaceId: string): Promise<FileNode[]>;
  /** Applies a validated change-set; recomputes size; bumps node revision. */
  updateNode(workspaceId: string, nodeId: string, change: FileNodeChangeSet): Promise<FileNode>;
  /**
   * Rewrites the paths of a directory subtree after a move. Only the
   * FileTreeManager calls this, after full validation.
   */
  moveSubtree(
    workspaceId: string,
    fromPath: string,
    toPath: string,
    updatedAt: string,
  ): Promise<void>;
  deleteNode(workspaceId: string, nodeId: string): Promise<void>;
  /** File content; directories have no content. */
  readContent(workspaceId: string, nodeId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// ProjectContextRepository (context + config)
// ---------------------------------------------------------------------------

export interface ProjectContextRepository {
  getContext(projectId: string): Promise<ProjectContext | null>;
  /** Saves the full context; bumps revision; stamps `updatedAt`. */
  saveContext(
    projectId: string,
    context: Omit<ProjectContext, 'revision' | 'updatedAt'>,
    updatedAt: string,
  ): Promise<ProjectContext>;
  getConfig(projectId: string): Promise<ProjectConfig | null>;
  /** Saves the full config; bumps revision; stamps `updatedAt`. */
  saveConfig(
    projectId: string,
    config: Omit<ProjectConfig, 'revision' | 'updatedAt'>,
    updatedAt: string,
  ): Promise<ProjectConfig>;
}

// ---------------------------------------------------------------------------
// IntegrationRepository
// ---------------------------------------------------------------------------

export interface IntegrationRepository {
  /** Upserts by `integrationRef`; rejects duplicate integrationRefs per project. */
  upsert(
    projectId: string,
    reference: IntegrationReference,
    updatedAt: string,
  ): Promise<IntegrationReference>;
  list(projectId: string): Promise<IntegrationReference[]>;
  get(projectId: string, integrationRef: string): Promise<IntegrationReference | null>;
  remove(projectId: string, integrationRef: string): Promise<void>;
}
