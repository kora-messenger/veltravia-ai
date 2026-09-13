/**
 * Project & Workspace Engine - provider-neutral model types (Step 7).
 *
 * Everything here is infrastructure-neutral: no AI vendor SDKs, no GitHub,
 * no concrete databases, no sandbox execution. Future systems (sandbox,
 * coding agent, connectors, deployment) attach through explicit interfaces.
 */

// ---------------------------------------------------------------------------
// Status / type unions
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = ['active', 'archived', 'deleted'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TYPES = ['web', 'mobile', 'backend', 'fullstack', 'library', 'other'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const WORKSPACE_STATUSES = ['active', 'locked', 'archived'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const NODE_TYPES = ['file', 'directory'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const INTEGRATION_STATUSES = ['connected', 'disconnected'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/** Structured project-context categories. Contents are PROJECT DATA, never instructions. */
export const CONTEXT_CATEGORIES = [
  'goals',
  'technologyPreferences',
  'architectureNotes',
  'buildPreferences',
  'userInstructions',
  'decisions',
] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function isProjectType(value: unknown): value is ProjectType {
  return typeof value === 'string' && (PROJECT_TYPES as readonly string[]).includes(value);
}

export function isWorkspaceStatus(value: unknown): value is WorkspaceStatus {
  return typeof value === 'string' && (WORKSPACE_STATUSES as readonly string[]).includes(value);
}

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value);
}

export function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  return typeof value === 'string' && (INTEGRATION_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/**
 * A persistent, provider-neutral application project.
 *
 * `ownerRef` is an opaque owner identity reference (never a credential).
 * `workspaceId` is the default workspace (nullable until one is assigned).
 * `version` is a free-form project version label (projectVersion); `revision`
 * is the optimistic-concurrency counter - the two are distinct concepts.
 */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: ProjectStatus;
  readonly projectType: ProjectType;
  readonly ownerRef: string;
  readonly workspaceId: string | null;
  readonly version: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Plain, secret-free metadata (validated at write time). */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Input accepted by `ProjectManager.createProject` (plus a generated id). */
export interface CreateProjectInput {
  readonly name: string;
  readonly description: string;
  readonly projectType: ProjectType;
  readonly ownerRef: string;
  readonly version?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Fields a caller may patch on an existing project. */
export type ProjectPatch = Partial<Pick<Project, 'name' | 'description' | 'metadata'>>;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * The logical working environment belonging to a project.
 *
 * `root` is a STABLE LOGICAL ROOT identifier (never a host filesystem path).
 * The engine never touches the host filesystem; the future sandbox system owns
 * actual execution surfaces.
 */
export interface Workspace {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  /** Stable logical root, e.g. `workspace://<id>/`. Not a host path. */
  readonly root: string;
  /** Optimistic-concurrency counter; bumped on workspace and file-tree changes. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
}

export type WorkspacePatch = Partial<Pick<Workspace, 'name' | 'metadata'>>;

// ---------------------------------------------------------------------------
// Virtual file tree
// ---------------------------------------------------------------------------

/**
 * A node in a workspace's virtual file tree.
 *
 * Paths are workspace-relative POSIX-style strings (`src/App.tsx`), validated
 * and normalized by the path module - never host paths.
 */
export interface FileNode {
  readonly id: string;
  readonly workspaceId: string;
  /** Normalized workspace-relative path; the tree root is the empty string. */
  readonly path: string;
  readonly name: string;
  readonly type: NodeType;
  /** Parent node id; `null` for children of the root. */
  readonly parentId: string | null;
  /** Content size in bytes; `0` for directories. */
  readonly size: number;
  /** Node-level optimistic-concurrency counter. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Project context (lightweight structured context - NOT AI memory infrastructure)
// ---------------------------------------------------------------------------

/** A recorded decision entry inside project context. */
export interface ContextDecision {
  readonly summary: string;
  readonly rationale?: string;
  readonly decidedAt?: string;
}

/**
 * Structured project context. Provider-neutral storage only: no embeddings,
 * no vector databases, no retrieval. Entries are PROJECT DATA - a context
 * value can never change Veltravia's security policy.
 */
export interface ProjectContext {
  readonly goals: readonly string[];
  readonly technologyPreferences: readonly string[];
  readonly architectureNotes: readonly string[];
  readonly buildPreferences: readonly string[];
  readonly userInstructions: readonly string[];
  readonly decisions: readonly ContextDecision[];
  readonly revision: number;
  readonly updatedAt: string;
}

export type ProjectContextPatch = Partial<
  Pick<
    ProjectContext,
    | 'goals'
    | 'technologyPreferences'
    | 'architectureNotes'
    | 'buildPreferences'
    | 'userInstructions'
  >
> & {
  readonly decisions?: readonly ContextDecision[];
};

// ---------------------------------------------------------------------------
// Project configuration
// ---------------------------------------------------------------------------

/**
 * Safe project configuration. Strictly metadata for future build systems -
 * the engine NEVER executes any of these commands.
 *
 * Secret-like fields and secret-shaped values are REJECTED at validation time;
 * secrets belong to the future secure secret/connector system.
 */
export interface ProjectConfig {
  readonly framework?: string;
  readonly language?: string;
  readonly runtime?: string;
  readonly packageManager?: string;
  readonly buildCommand?: string;
  readonly testCommand?: string;
  readonly lintCommand?: string;
  readonly entryPoints: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
}

export type ProjectConfigPatch = Partial<Omit<ProjectConfig, 'revision' | 'updatedAt'>>;

// ---------------------------------------------------------------------------
// Integration references (credential-FREE)
// ---------------------------------------------------------------------------

/**
 * A project's reference to a connected integration.
 *
 * The project knows THAT an integration is connected (by id) - never the
 * credential. Actual credentials live only in the future secure
 * secret/connector system:
 *
 *   Project -> Integration References -> Connector Manager -> Connector
 */
export interface IntegrationReference {
  /** Logical integration name, e.g. `github`. */
  readonly integrationRef: string;
  /** Connector id as registered with the ConnectorManager. */
  readonly connectorId: string;
  /** Opaque connection id - resolved to credentials elsewhere. */
  readonly connectionId: string;
  readonly status: IntegrationStatus;
  readonly linkedAt?: string;
  /** Plain, secret-free metadata (validated at write time). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** File-tree METADATA only - never file contents. */
export interface SnapshotFileNode {
  readonly path: string;
  readonly type: NodeType;
  readonly size: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SnapshotWorkspace {
  readonly id: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly root: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Sorted by path. */
  readonly nodes: readonly SnapshotFileNode[];
}

/**
 * Deterministic, serializable project snapshot.
 *
 * Deterministic: identical state produces an identical snapshot (stable key
 * order, all arrays sorted). Serializable: plain JSON. Secret-free: metadata
 * is scrubbed, and nothing secret can be stored in the first place.
 */
export interface ProjectSnapshot {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly status: ProjectStatus;
    readonly projectType: ProjectType;
    readonly ownerRef: string;
    readonly version: string;
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  };
  /** Sorted by id. */
  readonly workspaces: readonly SnapshotWorkspace[];
  readonly config: Omit<ProjectConfig, 'revision' | 'updatedAt'> | null;
  readonly context: Omit<ProjectContext, 'revision' | 'updatedAt'> | null;
  /** Sorted by integrationRef. */
  readonly integrations: readonly IntegrationReference[];
}
