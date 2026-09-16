import { AGENT_PROJECT_CONTEXT_MAX_SERIALIZED } from '@veltravia/agent-core';
import { ProjectError, type FileNode, type ProjectEngine } from '@veltravia/project-core';

/**
 * Server-side project/workspace association for agent runs (Step 11C-4).
 *
 * The browser is NEVER the source of truth: the API resolves and validates
 * the project/workspace association against the Project Engine before a
 * run starts, then derives a bounded, safe context (metadata + file-tree
 * structure only - NEVER file contents). The derived context enters the
 * agent as UNTRUSTED PROJECT DATA via AgentRequest.projectContext.
 */

/** Maximum file-tree nodes included in an agent's project context. */
export const AGENT_CONTEXT_MAX_TREE_NODES = 200;

/** Maximum characters of the project description included in the context. */
export const AGENT_CONTEXT_MAX_DESCRIPTION = 280;

export interface AgentProjectContextInput {
  readonly projectId?: string;
  readonly workspaceId?: string;
}

export interface AgentProjectContext {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly projectType: string;
    readonly version: string;
    readonly revision: number;
    readonly description: string;
  };
  readonly workspace?: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly revision: number;
  };
  readonly fileTree?: {
    /** Bounded structural metadata only: relative paths and node types. */
    readonly nodes: readonly { readonly path: string; readonly type: string }[];
    /** Total nodes in the workspace (honest when the list is truncated). */
    readonly total: number;
    readonly included: number;
    readonly truncated: boolean;
  };
}

/** Builds the bounded context view of one file node (path + type only). */
function toContextNode(node: FileNode): { readonly path: string; readonly type: string } {
  return { path: node.path, type: node.type };
}

/**
 * Resolves and validates the project/workspace association and derives the
 * bounded, safe project context for an agent run.
 *
 * - No identifiers -> no context (the run stays a plain conversation).
 * - projectId alone -> project metadata only.
 * - projectId + workspaceId -> full validation: the project must exist, the
 *   workspace must exist, and the workspace must belong to that project.
 *   A mismatch is rejected - Project A can never borrow Project B's
 *   workspace as agent context.
 * - workspaceId without projectId is rejected: the association is always
 *   an explicit, validated pair.
 *
 * File contents are NEVER read here: only tree structure (paths + types)
 * enters the context, so secret-like files (.env, key files) may appear as
 * names but their contents can never leak into an agent context.
 */
export async function resolveAgentProjectContext(
  engine: ProjectEngine,
  input: AgentProjectContextInput,
): Promise<AgentProjectContext | undefined> {
  const { projectId, workspaceId } = input;
  if (projectId === undefined && workspaceId === undefined) {
    return undefined;
  }
  if (projectId === undefined) {
    // The association must be an explicit, checkable pair.
    throw new ProjectError(
      'PROJECT_INVALID_REQUEST',
      'A workspace association requires the project it belongs to.',
    );
  }
  if (workspaceId !== undefined && (projectId === '' || workspaceId === '')) {
    throw new ProjectError('PROJECT_INVALID_REQUEST', 'Project and workspace ids cannot be empty.');
  }

  // Project existence is validated by the engine (throws PROJECT_NOT_FOUND).
  const project = await engine.projects.getProject(projectId);

  const context: AgentProjectContext = {
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      projectType: project.projectType,
      version: project.version,
      revision: project.revision,
      description: project.description.slice(0, AGENT_CONTEXT_MAX_DESCRIPTION),
    },
  };

  if (workspaceId === undefined) {
    return context;
  }

  // Workspace existence is validated by the engine (throws WORKSPACE_NOT_FOUND).
  const workspace = await engine.workspaces.getWorkspace(workspaceId);
  if (workspace.projectId !== projectId) {
    throw new ProjectError(
      'PROJECT_INVALID_REQUEST',
      'This workspace does not belong to the given project.',
    );
  }

  // Bounded structural file-tree metadata. listAll returns every node; the
  // context keeps at most AGENT_CONTEXT_MAX_TREE_NODES and reports the
  // honest total + truncated flag so the model never believes it sees the
  // complete tree when it does not.
  const nodes = await engine.files.listAll(workspaceId);
  const sorted = [...nodes].sort((left, right) => left.path.localeCompare(right.path));

  const workspaceContext = {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    revision: workspace.revision,
  };

  // The whole context must also fit the agent request's serialized budget
  // (AGENT_PROJECT_CONTEXT_MAX_SERIALIZED): shrink the node list until it
  // fits. The truncated flag stays honest - the model is told both the
  // true total and how many entries it received.
  let includedCount = Math.min(sorted.length, AGENT_CONTEXT_MAX_TREE_NODES);
  for (;;) {
    const candidate = buildFileTree(sorted, includedCount);
    const serialized = JSON.stringify({
      ...context,
      workspace: workspaceContext,
      fileTree: candidate,
    });
    if (serialized.length <= AGENT_PROJECT_CONTEXT_MAX_SERIALIZED || includedCount === 0) {
      return {
        ...context,
        workspace: workspaceContext,
        fileTree: candidate,
      };
    }
    // Shrink deterministically (drop the alphabetically last paths first).
    includedCount = Math.max(0, includedCount - Math.ceil(includedCount / 8));
  }
}

/** Builds the honest, bounded file-tree view for the first `count` nodes. */
function buildFileTree(
  sorted: readonly FileNode[],
  count: number,
): {
  readonly nodes: readonly { readonly path: string; readonly type: string }[];
  readonly total: number;
  readonly included: number;
  readonly truncated: boolean;
} {
  const included = sorted.slice(0, count);
  return {
    nodes: included.map(toContextNode),
    total: sorted.length,
    included: included.length,
    truncated: sorted.length > included.length,
  };
}
