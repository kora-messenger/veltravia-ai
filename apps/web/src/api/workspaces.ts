/**
 * Workspace API surface + safe UI models (project workspaces only; the file
 * tree and any editor surfaces belong to later checkpoints).
 */
import { apiRequest } from './client';

export type WorkspaceStatus = 'active' | 'locked' | 'archived';

export interface WorkspaceView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly createdAt: string;
  /** Optimistic-concurrency counter (Step 18 rollback guards). */
  readonly revision: number;
}

const STATUSES: readonly WorkspaceStatus[] = ['active', 'locked', 'archived'];

function toWorkspaceView(raw: unknown, source: string): WorkspaceView {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Invalid workspace payload from ${source}`);
  }
  const record = raw as Record<string, unknown>;
  const { id, projectId, name, status, createdAt } = record;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof projectId !== 'string' ||
    typeof name !== 'string' ||
    name.length === 0
  ) {
    throw new Error(`Invalid workspace payload from ${source}`);
  }
  if (!STATUSES.includes(status as WorkspaceStatus)) {
    throw new Error(`Invalid workspace payload from ${source}`);
  }
  return {
    id,
    projectId,
    name,
    status: status as WorkspaceStatus,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    revision: typeof record.revision === 'number' ? record.revision : 0,
  };
}

interface ListResponse {
  readonly workspaces?: unknown;
}

export async function listWorkspaces(projectId: string): Promise<readonly WorkspaceView[]> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/workspaces`,
  );
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as ListResponse;
  if (!Array.isArray(body.workspaces)) {
    throw new Error('Invalid workspace list payload');
  }
  return body.workspaces.map((workspace) => toWorkspaceView(workspace, 'workspace list'));
}

export async function createWorkspace(
  projectId: string,
  input: { readonly name: string },
): Promise<WorkspaceView> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/workspaces`,
    { method: 'POST', body: input },
  );
  return toWorkspaceView(payload, 'workspace create');
}

// -----------------------------------------------------------------
// Step 11C-4: project/workspace context (read-only).
// -----------------------------------------------------------------

export type TreeNodeType = 'file' | 'directory';

/**
 * Safe file-tree node: relative path + node type (+ revision for display).
 * Contents are NEVER fetched by this surface - the workspace context is
 * structural metadata only.
 */
export interface FileTreeView {
  readonly path: string;
  readonly name: string;
  readonly type: TreeNodeType;
}

const NODE_TYPES: readonly TreeNodeType[] = ['file', 'directory'];

function toFileTreeView(raw: unknown, source: string): FileTreeView {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Invalid file tree payload from ${source}`);
  }
  const record = raw as Record<string, unknown>;
  const { path, name, type } = record;
  if (typeof path !== 'string' || path.length === 0 || typeof name !== 'string') {
    throw new Error(`Invalid file tree payload from ${source}`);
  }
  if (!NODE_TYPES.includes(type as TreeNodeType)) {
    throw new Error(`Invalid file tree payload from ${source}`);
  }
  return { path, name, type: type as TreeNodeType };
}

/** The workspace's file tree (structural metadata only, never contents). */
export async function getWorkspaceTree(workspaceId: string): Promise<readonly FileTreeView[]> {
  const payload = await apiRequest<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/tree`,
  );
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    readonly nodes?: unknown;
  };
  if (!Array.isArray(body.nodes)) {
    throw new Error('Invalid file tree payload from workspace tree');
  }
  return body.nodes.map((node) => toFileTreeView(node, 'workspace tree'));
}
