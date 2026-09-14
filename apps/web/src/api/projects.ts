/**
 * Project API surface + safe UI models.
 *
 * Raw backend responses are mapped into `ProjectView` before reaching the
 * UI: unknown/invalid data becomes a typed error, and fields the UI does not
 * use (e.g. raw metadata) are dropped rather than passed through.
 */
import { apiRequest } from './client';

export type ProjectStatus = 'active' | 'archived';
export type ProjectType = 'web' | 'mobile' | 'backend' | 'fullstack' | 'library' | 'other';

export const PROJECT_TYPE_OPTIONS: readonly ProjectType[] = [
  'web',
  'mobile',
  'backend',
  'fullstack',
  'library',
  'other',
];

/** Safe UI model for a project. Metadata is intentionally not surfaced. */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: ProjectStatus;
  readonly projectType: ProjectType;
  readonly version: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const STATUSES: readonly ProjectStatus[] = ['active', 'archived'];
const TYPES: readonly ProjectType[] = PROJECT_TYPE_OPTIONS;

function toProjectView(raw: unknown, source: string): ProjectView {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Invalid project payload from ${source}`);
  }
  const record = raw as Record<string, unknown>;
  const { id, name, description, status, projectType, version, revision, createdAt, updatedAt } =
    record;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Invalid project payload from ${source}`);
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Invalid project payload from ${source}`);
  }
  if (!STATUSES.includes(status as ProjectStatus)) {
    // The API never returns deleted projects in listings; anything else is
    // unexpected and must not be rendered as a known state.
    throw new Error(`Invalid project payload from ${source}`);
  }
  if (!TYPES.includes(projectType as ProjectType)) {
    throw new Error(`Invalid project payload from ${source}`);
  }
  return {
    id,
    name,
    description: typeof description === 'string' ? description : '',
    status: status as ProjectStatus,
    projectType: projectType as ProjectType,
    version: typeof version === 'string' ? version : '',
    revision: typeof revision === 'number' ? revision : 0,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  };
}

interface ListResponse {
  readonly projects?: unknown;
}

export async function listProjects(): Promise<readonly ProjectView[]> {
  const payload = await apiRequest<unknown>('/api/projects');
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as ListResponse;
  if (!Array.isArray(body.projects)) {
    throw new Error('Invalid project list payload');
  }
  return body.projects.map((project) => toProjectView(project, 'project list'));
}

export async function getProject(projectId: string): Promise<ProjectView> {
  const payload = await apiRequest<unknown>(`/api/projects/${encodeURIComponent(projectId)}`);
  return toProjectView(payload, 'project detail');
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description: string;
  readonly projectType: ProjectType;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectView> {
  const payload = await apiRequest<unknown>('/api/projects', {
    method: 'POST',
    body: input,
  });
  return toProjectView(payload, 'project create');
}

export async function updateProject(
  projectId: string,
  patch: { readonly name?: string; readonly description?: string },
  expectedRevision: number,
): Promise<ProjectView> {
  const payload = await apiRequest<unknown>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: { ...patch, expectedRevision },
  });
  return toProjectView(payload, 'project update');
}

export async function archiveProject(projectId: string): Promise<ProjectView> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/archive`,
    { method: 'POST' },
  );
  return toProjectView(payload, 'project archive');
}

export async function restoreProject(projectId: string): Promise<ProjectView> {
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/restore`,
    { method: 'POST' },
  );
  return toProjectView(payload, 'project restore');
}

/** Formats an ISO timestamp for display; falls back to the raw value. */
export function formatTimestamp(iso: string): string {
  if (iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
