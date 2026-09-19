/**
 * Project memory API surface + safe UI models (Step 15).
 *
 * Raw backend responses are mapped into `MemoryView` before reaching the
 * UI: unknown or malformed data becomes a typed error, and the browser
 * never renders (or stores) anything beyond the safe normalized view the
 * API already guarantees. Memory content the user typed themselves is the
 * only content this client can push; AI-extracted candidates arrive from
 * the server and are only reviewed here.
 */
import { apiRequest } from './client';

export type MemoryStatus = 'active' | 'candidate' | 'rejected' | 'archived';
export type MemoryConfidence = 'high' | 'medium' | 'low';
export type MemoryVerificationStatus = 'unverified' | 'verified' | 'stale';

/** Memory types surfaced for manual creation. */
export const MEMORY_TYPE_OPTIONS: readonly string[] = [
  'project_summary',
  'architecture',
  'technology',
  'convention',
  'design_decision',
  'requirement',
  'api_contract',
  'dependency',
  'testing_rule',
  'known_issue',
  'known_limitation',
  'user_preference',
  'documentation',
  'milestone',
  'workflow',
];

export const MEMORY_STATUS_OPTIONS: readonly MemoryStatus[] = ['active', 'candidate', 'archived'];

export interface MemorySourceView {
  readonly kind: string;
  readonly referenceId: string | null;
}

/** Safe UI model for a project memory record. */
export interface MemoryView {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly type: string;
  readonly title: string;
  readonly content: string;
  readonly status: MemoryStatus;
  readonly confidence: MemoryConfidence;
  readonly verificationStatus: MemoryVerificationStatus;
  readonly source: MemorySourceView;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt: string | null;
}

export interface MemoryStatsView {
  readonly total: number;
  readonly active: number;
  readonly archived: number;
  readonly candidates: number;
  readonly rejected: number;
  readonly stale: number;
}

const STATUSES: readonly string[] = MEMORY_STATUS_OPTIONS.concat(['rejected']);
const CONFIDENCES: readonly string[] = ['high', 'medium', 'low'];
const VERIFICATIONS: readonly string[] = ['unverified', 'verified', 'stale'];

function toMemoryView(raw: unknown, origin: string): MemoryView {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Invalid memory payload from ${origin}`);
  }
  const record = raw as Record<string, unknown>;
  const {
    id,
    projectId,
    workspaceId,
    type,
    title,
    content,
    status,
    confidence,
    verificationStatus,
    revision,
    createdAt,
    updatedAt,
    lastVerifiedAt,
  } = record;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof projectId !== 'string' ||
    typeof type !== 'string' ||
    type.length === 0 ||
    typeof title !== 'string' ||
    typeof content !== 'string' ||
    typeof revision !== 'number' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    typeof status !== 'string' ||
    typeof confidence !== 'string' ||
    typeof verificationStatus !== 'string'
  ) {
    throw new Error(`Invalid memory payload from ${origin}`);
  }
  if (!STATUSES.includes(status) || !CONFIDENCES.includes(confidence)) {
    throw new Error(`Invalid memory payload from ${origin}`);
  }
  if (!VERIFICATIONS.includes(verificationStatus)) {
    throw new Error(`Invalid memory payload from ${origin}`);
  }
  const sourceView: unknown = record.source;
  if (
    typeof sourceView !== 'object' ||
    sourceView === null ||
    typeof (sourceView as { kind?: unknown }).kind !== 'string'
  ) {
    throw new Error(`Invalid memory payload from ${origin}`);
  }
  const sourceRecord = sourceView as { kind: string; referenceId?: unknown };
  return {
    id,
    projectId,
    workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
    type,
    title,
    content,
    status: status as MemoryStatus,
    confidence: confidence as MemoryConfidence,
    verificationStatus: verificationStatus as MemoryVerificationStatus,
    source: {
      kind: sourceRecord.kind,
      referenceId: typeof sourceRecord.referenceId === 'string' ? sourceRecord.referenceId : null,
    },
    revision,
    createdAt,
    updatedAt,
    lastVerifiedAt: typeof lastVerifiedAt === 'string' ? lastVerifiedAt : null,
  };
}

function toMemoryList(raw: unknown, origin: string): readonly MemoryView[] {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { memories?: unknown }).memories)
  ) {
    throw new Error(`Invalid memory list payload from ${origin}`);
  }
  return (raw as { memories: unknown[] }).memories.map((entry) => toMemoryView(entry, origin));
}

function toMemoryStats(raw: unknown, origin: string): MemoryStatsView {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Invalid memory stats payload from ${origin}`);
  }
  const record = raw as Record<string, unknown>;
  const { total, active, archived, candidates, rejected, stale } = record;
  if (
    typeof total !== 'number' ||
    typeof active !== 'number' ||
    typeof archived !== 'number' ||
    typeof candidates !== 'number' ||
    typeof rejected !== 'number' ||
    typeof stale !== 'number'
  ) {
    throw new Error(`Invalid memory stats payload from ${origin}`);
  }
  return { total, active, archived, candidates, rejected, stale };
}

const enc = encodeURIComponent;

export async function listMemories(
  projectId: string,
  options: {
    readonly status?: MemoryStatus;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<readonly MemoryView[]> {
  const query = options.status !== undefined ? `?status=${options.status}` : '';
  const raw = await apiRequest<{ memories?: unknown }>(
    `/api/projects/${enc(projectId)}/memories${query}`,
    { fetchImpl: options.fetchImpl },
  );
  return toMemoryList(raw, 'list');
}

export async function searchMemories(
  projectId: string,
  text: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<readonly MemoryView[]> {
  const raw = await apiRequest<{ memories?: unknown }>(
    `/api/projects/${enc(projectId)}/memories/search`,
    { method: 'POST', body: { text, status: 'active' }, fetchImpl: options.fetchImpl },
  );
  return toMemoryList(raw, 'search');
}

export async function getMemoryStats(
  projectId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<MemoryStatsView> {
  const raw = await apiRequest<unknown>(`/api/projects/${enc(projectId)}/memories/stats`, {
    fetchImpl: options.fetchImpl,
  });
  return toMemoryStats(raw, 'stats');
}

export async function createMemory(
  projectId: string,
  input: {
    readonly title: string;
    readonly content: string;
    readonly type: string;
    readonly confidence: MemoryConfidence;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<MemoryView> {
  const { fetchImpl, ...body } = input;
  const raw = await apiRequest<unknown>(`/api/projects/${enc(projectId)}/memories`, {
    method: 'POST',
    body,
    fetchImpl,
  });
  return toMemoryView(raw, 'create');
}

export async function updateMemory(
  projectId: string,
  memoryId: string,
  input: {
    readonly title: string;
    readonly content: string;
    readonly type: string;
    readonly expectedRevision: number;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<MemoryView> {
  const { fetchImpl, ...body } = input;
  const raw = await apiRequest<unknown>(
    `/api/projects/${enc(projectId)}/memories/${enc(memoryId)}`,
    { method: 'PATCH', body, fetchImpl },
  );
  return toMemoryView(raw, 'update');
}

async function memoryAction(
  projectId: string,
  memoryId: string,
  action: 'archive' | 'restore' | 'verify' | 'stale' | 'approve' | 'reject',
  fetchImpl?: typeof fetch,
): Promise<MemoryView> {
  const raw = await apiRequest<unknown>(
    `/api/projects/${enc(projectId)}/memories/${enc(memoryId)}/${action}`,
    { method: 'POST', fetchImpl },
  );
  return toMemoryView(raw, action);
}

export function archiveMemory(projectId: string, memoryId: string, fetchImpl?: typeof fetch) {
  return memoryAction(projectId, memoryId, 'archive', fetchImpl);
}

export function restoreMemory(projectId: string, memoryId: string, fetchImpl?: typeof fetch) {
  return memoryAction(projectId, memoryId, 'restore', fetchImpl);
}

export function verifyMemory(projectId: string, memoryId: string, fetchImpl?: typeof fetch) {
  return memoryAction(projectId, memoryId, 'verify', fetchImpl);
}

export function markMemoryStale(projectId: string, memoryId: string, fetchImpl?: typeof fetch) {
  return memoryAction(projectId, memoryId, 'stale', fetchImpl);
}

export function approveMemoryCandidate(
  projectId: string,
  memoryId: string,
  fetchImpl?: typeof fetch,
) {
  return memoryAction(projectId, memoryId, 'approve', fetchImpl);
}

export function rejectMemoryCandidate(
  projectId: string,
  memoryId: string,
  fetchImpl?: typeof fetch,
) {
  return memoryAction(projectId, memoryId, 'reject', fetchImpl);
}

export async function deleteMemory(
  projectId: string,
  memoryId: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await apiRequest<void>(`/api/projects/${enc(projectId)}/memories/${enc(memoryId)}`, {
    method: 'DELETE',
    fetchImpl,
  });
}
