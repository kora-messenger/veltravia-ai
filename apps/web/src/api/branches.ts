import { apiRequest } from './client';

/**
 * Branches, history and the checkpoint policy (Step 38).
 *
 * Shapes match what the server returns, and every field is read defensively:
 * a missing or mistyped value becomes an honest empty value instead of a crash
 * that blanks the page.
 */

export type BranchState = 'active' | 'archived';
export type ChangeActor = 'user' | 'ai-agent' | 'system';
export type HistoryChangeType =
  'initial' | 'edit' | 'ai-change' | 'restore' | 'branch' | 'checkpoint';

export interface BranchView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: BranchState;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly workspaceId: string;
  readonly baseRevisionId: string | null;
  readonly parentBranchId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly archivedAt: string | null;
}

export interface BranchList {
  readonly branches: readonly BranchView[];
  readonly activeBranchId: string | null;
}

export interface BranchDetail {
  readonly branch: BranchView;
  readonly deletable: boolean;
  readonly deleteBlockedReason: string | null;
  readonly latestRevisionNumber: number | null;
}

export interface HistoryEntryView {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly branchId: string;
  readonly branchName: string;
  readonly description: string;
  readonly createdAt: string;
  readonly actor: ChangeActor;
  readonly author: string;
  readonly changeType: HistoryChangeType;
  readonly filesChanged: number;
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly checkpointIds: readonly string[];
  readonly checkpointNames: readonly string[];
  readonly source: string;
}

export interface HistoryPage {
  readonly entries: readonly HistoryEntryView[];
  readonly total: number;
  readonly hasMore: boolean;
}

const enc = encodeURIComponent;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function toBranchView(raw: unknown): BranchView {
  const r = asRecord(raw);
  return {
    id: asString(r.id),
    name: asString(r.name),
    description: asNullableString(r.description),
    state: r.state === 'archived' ? 'archived' : 'active',
    isDefault: r.isDefault === true,
    isActive: r.isActive === true,
    workspaceId: asString(r.workspaceId),
    baseRevisionId: asNullableString(r.baseRevisionId),
    parentBranchId: asNullableString(r.parentBranchId),
    createdAt: asString(r.createdAt),
    createdBy: asString(r.createdBy),
    archivedAt: asNullableString(r.archivedAt),
  };
}

const ACTORS: readonly ChangeActor[] = ['user', 'ai-agent', 'system'];
const CHANGE_TYPES: readonly HistoryChangeType[] = [
  'initial',
  'edit',
  'ai-change',
  'restore',
  'branch',
  'checkpoint',
];

export function toHistoryEntry(raw: unknown): HistoryEntryView {
  const r = asRecord(raw);
  const actor = ACTORS.find((a) => a === r.actor) ?? 'user';
  const changeType = CHANGE_TYPES.find((t) => t === r.changeType) ?? 'edit';
  return {
    revisionId: asString(r.revisionId),
    revisionNumber: asNumber(r.revisionNumber),
    branchId: asString(r.branchId),
    branchName: asString(r.branchName),
    description: asString(r.description),
    createdAt: asString(r.createdAt),
    actor,
    author: asString(r.author),
    changeType,
    filesChanged: asNumber(r.filesChanged),
    added: asNumber(r.added),
    modified: asNumber(r.modified),
    deleted: asNumber(r.deleted),
    checkpointIds: asStrings(r.checkpointIds),
    checkpointNames: asStrings(r.checkpointNames),
    source: asString(r.source),
  };
}

type Options = { readonly fetchImpl?: typeof fetch };
const withFetch = (o: Options) => (o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {});

export async function listBranches(
  projectId: string,
  options: Options & { readonly includeArchived?: boolean } = {},
): Promise<BranchList> {
  const query = options.includeArchived === true ? '?includeArchived=true' : '';
  const raw = asRecord(
    await apiRequest<unknown>(
      `/api/projects/${enc(projectId)}/branches${query}`,
      withFetch(options),
    ),
  );
  return {
    branches: Array.isArray(raw.branches) ? raw.branches.map(toBranchView) : [],
    activeBranchId: asNullableString(raw.activeBranchId),
  };
}

export async function getBranch(
  projectId: string,
  branchId: string,
  options: Options = {},
): Promise<BranchDetail> {
  const raw = asRecord(
    await apiRequest<unknown>(
      `/api/projects/${enc(projectId)}/branches/${enc(branchId)}`,
      withFetch(options),
    ),
  );
  return {
    branch: toBranchView(raw.branch),
    deletable: raw.deletable === true,
    deleteBlockedReason: asNullableString(raw.deleteBlockedReason),
    latestRevisionNumber:
      typeof raw.latestRevisionNumber === 'number' ? raw.latestRevisionNumber : null,
  };
}

export async function createBranch(
  projectId: string,
  input: {
    readonly name: string;
    readonly description?: string;
    readonly fromBranchId?: string;
    readonly fromRevisionId?: string;
  },
  options: Options = {},
): Promise<BranchView> {
  const raw = asRecord(
    await apiRequest<unknown>(`/api/projects/${enc(projectId)}/branches`, {
      method: 'POST',
      body: {
        name: input.name,
        ...(input.description !== undefined && input.description !== ''
          ? { description: input.description }
          : {}),
        ...(input.fromBranchId !== undefined ? { fromBranchId: input.fromBranchId } : {}),
        ...(input.fromRevisionId !== undefined ? { fromRevisionId: input.fromRevisionId } : {}),
      },
      ...withFetch(options),
    }),
  );
  return toBranchView(raw.branch);
}

export async function renameBranch(
  projectId: string,
  branchId: string,
  input: { readonly name?: string; readonly description?: string },
  options: Options = {},
): Promise<BranchView> {
  const raw = asRecord(
    await apiRequest<unknown>(`/api/projects/${enc(projectId)}/branches/${enc(branchId)}`, {
      method: 'PATCH',
      body: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      ...withFetch(options),
    }),
  );
  return toBranchView(raw.branch);
}

async function branchAction(
  projectId: string,
  branchId: string,
  action: 'switch' | 'archive' | 'unarchive',
  options: Options,
): Promise<BranchView> {
  const raw = asRecord(
    await apiRequest<unknown>(
      `/api/projects/${enc(projectId)}/branches/${enc(branchId)}/${action}`,
      { method: 'POST', body: {}, ...withFetch(options) },
    ),
  );
  return toBranchView(raw.branch);
}

export const switchBranch = (projectId: string, branchId: string, options: Options = {}) =>
  branchAction(projectId, branchId, 'switch', options);
export const archiveBranch = (projectId: string, branchId: string, options: Options = {}) =>
  branchAction(projectId, branchId, 'archive', options);
export const unarchiveBranch = (projectId: string, branchId: string, options: Options = {}) =>
  branchAction(projectId, branchId, 'unarchive', options);

export async function deleteBranch(
  projectId: string,
  branchId: string,
  options: Options = {},
): Promise<void> {
  await apiRequest(`/api/projects/${enc(projectId)}/branches/${enc(branchId)}`, {
    method: 'DELETE',
    ...withFetch(options),
  });
}

export async function fetchBranchHistory(
  projectId: string,
  branchId: string,
  options: Options & { readonly limit?: number; readonly offset?: number } = {},
): Promise<HistoryPage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.toString() === '' ? '' : `?${params.toString()}`;
  const raw = asRecord(
    await apiRequest<unknown>(
      `/api/projects/${enc(projectId)}/branches/${enc(branchId)}/history${query}`,
      withFetch(options),
    ),
  );
  return {
    entries: Array.isArray(raw.entries) ? raw.entries.map(toHistoryEntry) : [],
    total: asNumber(raw.total),
    hasMore: raw.hasMore === true,
  };
}
