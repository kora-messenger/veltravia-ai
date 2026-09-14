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
