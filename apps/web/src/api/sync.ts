import { runtimeConfig } from '../config/runtime-config.js';
import { ApiError, apiRequest, isOffline } from './client';

/**
 * GitHub sync client (Step 40, phase 3).
 *
 * Like the export client this sends NO owner header: the projects the web app
 * creates belong to the server's development owner, and the sync routes apply
 * the same rule to a request with no header.
 *
 * Everything a plan says arrives already counted by the server. This module
 * never decides what a sync will do: it shapes and checks what the server said,
 * so a page can never render a change that was not planned. No file CONTENT is
 * held here at all - a conflict resolution posts the person's merged text once
 * and keeps no copy.
 */

export type SyncPlanStatus = 'ready' | 'needs-approval' | 'needs-conflicts' | 'failed';
export type SyncMode = 'initial' | 'update';
export type ChangeKind = 'add' | 'modify' | 'delete' | 'rename';
export type SkipReason =
  | 'not-text'
  | 'too-large'
  | 'unreadable'
  | 'unsafe-path'
  | 'case-collision'
  | 'credential-file'
  | 'secret-in-content';
export type ConflictKind = 'both-modified' | 'both-added' | 'deleted-locally' | 'deleted-remotely';
export type ConflictResolution = 'keep-local' | 'keep-remote' | 'manual';

export interface SyncChange {
  readonly kind: ChangeKind;
  readonly path: string;
  /** Present for a rename: where the file used to be. */
  readonly from: string | null;
  readonly hash: string | null;
  readonly size: number;
}

export interface SkippedFile {
  readonly path: string;
  readonly side: 'local' | 'remote';
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface SyncConflict {
  readonly id: string;
  readonly path: string;
  readonly kind: ConflictKind;
  readonly resolution: ConflictResolution | null;
  readonly localHash: string | null;
  readonly remoteHash: string | null;
}

export interface PlanFailure {
  readonly code: string;
  readonly message: string;
}

export interface SyncPlan {
  readonly planId: string;
  readonly projectId: string;
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly status: SyncPlanStatus;
  readonly mode: SyncMode;
  readonly remoteHead: string;
  readonly localRevision: number | null;
  readonly push: readonly SyncChange[];
  readonly pull: readonly SyncChange[];
  readonly conflicts: readonly SyncConflict[];
  readonly skipped: readonly SkippedFile[];
  readonly unchanged: number;
  readonly approvalReasons: readonly string[];
  readonly approved: boolean;
  readonly message: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly failure: PlanFailure | null;
}

export interface SyncConnectionView {
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly lastSyncedCommit: string | null;
  readonly lastSyncedAt: string | null;
}

export interface SyncStatusView {
  readonly connected: boolean;
  readonly connection: SyncConnectionView | null;
  readonly plans: readonly SyncPlan[];
  readonly hasUnresolvedConflicts: boolean;
  /** 'memory' is the truth today: a restart forgets the connection. */
  readonly persistence: string;
}

export interface SyncHistoryEntry {
  readonly entryId: string;
  readonly projectId: string;
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly outcome: 'success' | 'failure';
  readonly commitSha: string | null;
  readonly message: string;
  readonly at: string;
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly pulled: number;
  readonly conflicts: number;
  readonly approval: 'approved' | 'not-required';
  readonly failureCode: string | null;
}

export interface SyncHistoryView {
  readonly entries: readonly SyncHistoryEntry[];
  readonly persistence: string;
}

/** A repository the connected GitHub account is allowed to sync with. */
export interface SyncRepositoryView {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
}

function malformed(): never {
  throw new ApiError(502, 'SYNC_MALFORMED', 'The service sent a sync this page cannot read.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function strList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function parseChange(raw: unknown): SyncChange | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw['kind']);
  const path = str(raw['path']);
  if (kind === null || path === null) return null;
  if (kind !== 'add' && kind !== 'modify' && kind !== 'delete' && kind !== 'rename') return null;
  return {
    kind,
    path,
    from: str(raw['from']),
    hash: str(raw['hash']),
    size: num(raw['size']) ?? 0,
  };
}

function parseSkipped(raw: unknown): SkippedFile | null {
  if (!isRecord(raw)) return null;
  const path = str(raw['path']);
  const side = str(raw['side']);
  const reason = str(raw['reason']);
  if (path === null || reason === null) return null;
  if (side !== 'local' && side !== 'remote') return null;
  return {
    path,
    side,
    reason: reason as SkipReason,
    detail: str(raw['detail']) ?? '',
  };
}

function parseConflict(raw: unknown): SyncConflict | null {
  if (!isRecord(raw)) return null;
  const id = str(raw['id']);
  const path = str(raw['path']);
  const kind = str(raw['kind']);
  if (id === null || path === null || kind === null) return null;
  const resolution = str(raw['resolution']);
  return {
    id,
    path,
    kind: kind as ConflictKind,
    resolution:
      resolution === 'keep-local' || resolution === 'keep-remote' || resolution === 'manual'
        ? resolution
        : null,
    localHash: str(raw['localHash']),
    remoteHash: str(raw['remoteHash']),
  };
}

function listOf<T>(value: unknown, parse: (raw: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(parse).filter((v): v is T => v !== null) : [];
}

export function parsePlan(raw: unknown): SyncPlan {
  if (!isRecord(raw)) throw malformed();
  const planId = str(raw['planId']);
  const status = str(raw['status']);
  const mode = str(raw['mode']);
  const owner = str(raw['owner']);
  const repository = str(raw['repository']);
  const branch = str(raw['branch']);
  if (
    planId === null ||
    status === null ||
    owner === null ||
    repository === null ||
    branch === null
  )
    throw malformed();
  const failure = isRecord(raw['failure'])
    ? {
        code: str(raw['failure']['code']) ?? 'UNKNOWN',
        message: str(raw['failure']['message']) ?? '',
      }
    : null;
  return {
    planId,
    projectId: str(raw['projectId']) ?? '',
    owner,
    repository,
    branch,
    status: status as SyncPlanStatus,
    mode: mode === 'initial' ? 'initial' : 'update',
    remoteHead: str(raw['remoteHead']) ?? '',
    localRevision: num(raw['localRevision']),
    push: listOf(raw['push'], parseChange),
    pull: listOf(raw['pull'], parseChange),
    conflicts: listOf(raw['conflicts'], parseConflict),
    skipped: listOf(raw['skipped'], parseSkipped),
    unchanged: num(raw['unchanged']) ?? 0,
    approvalReasons: strList(raw['approvalReasons']),
    approved: bool(raw['approved']),
    message: str(raw['message']) ?? '',
    createdAt: str(raw['createdAt']) ?? '',
    expiresAt: str(raw['expiresAt']) ?? '',
    failure,
  };
}

function parseConnection(raw: unknown): SyncConnectionView | null {
  if (!isRecord(raw)) return null;
  const owner = str(raw['owner']);
  const repository = str(raw['repository']);
  const branch = str(raw['branch']);
  if (owner === null || repository === null || branch === null) return null;
  return {
    owner,
    repository,
    branch,
    lastSyncedCommit: str(raw['lastSyncedCommit']),
    lastSyncedAt: str(raw['lastSyncedAt']),
  };
}

export function parseStatus(raw: unknown): SyncStatusView {
  if (!isRecord(raw)) throw malformed();
  return {
    connected: bool(raw['connected']),
    connection: parseConnection(raw['connection']),
    plans: listOf(raw['plans'], (value) => {
      try {
        return parsePlan(value);
      } catch {
        return null;
      }
    }),
    hasUnresolvedConflicts: bool(raw['hasUnresolvedConflicts']),
    persistence: str(raw['persistence']) ?? 'memory',
  };
}

function parseHistoryEntry(raw: unknown): SyncHistoryEntry | null {
  if (!isRecord(raw)) return null;
  const entryId = str(raw['entryId']);
  const outcome = str(raw['outcome']);
  if (entryId === null || (outcome !== 'success' && outcome !== 'failure')) return null;
  return {
    entryId,
    projectId: str(raw['projectId']) ?? '',
    owner: str(raw['owner']) ?? '',
    repository: str(raw['repository']) ?? '',
    branch: str(raw['branch']) ?? '',
    outcome,
    commitSha: str(raw['commitSha']),
    message: str(raw['message']) ?? '',
    at: str(raw['at']) ?? '',
    added: strList(raw['added']),
    modified: strList(raw['modified']),
    deleted: strList(raw['deleted']),
    pulled: num(raw['pulled']) ?? 0,
    conflicts: num(raw['conflicts']) ?? 0,
    approval: str(raw['approval']) === 'approved' ? 'approved' : 'not-required',
    failureCode: str(raw['failureCode']),
  };
}

export function parseHistory(raw: unknown): SyncHistoryView {
  if (!isRecord(raw)) throw malformed();
  return {
    entries: listOf(raw['entries'], parseHistoryEntry),
    persistence: str(raw['persistence']) ?? 'memory',
  };
}

function projectPath(projectId: string, suffix: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/sync${suffix}`;
}

function planPath(planId: string, suffix: string): string {
  return `/api/sync/plans/${encodeURIComponent(planId)}${suffix}`;
}

export async function fetchSyncStatus(
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<SyncStatusView> {
  return parseStatus(
    await apiRequest<unknown>(projectPath(projectId, ''), {
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  );
}

export async function fetchRepositories(
  fetchImpl?: typeof fetch,
): Promise<readonly SyncRepositoryView[]> {
  // The connector's own discovery route, not a per-project one: it lists what
  // the CONNECTED account may reach, which is the same list for every project.
  const response = await apiRequest<unknown>('/api/github/repositories', {
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  if (!isRecord(response) || !Array.isArray(response['repositories'])) throw malformed();
  return response['repositories'].flatMap((raw): SyncRepositoryView[] => {
    if (!isRecord(raw)) return [];
    const owner = str(raw['owner']);
    const name = str(raw['name']);
    if (owner === null || name === null) return [];
    return [
      {
        owner,
        name,
        defaultBranch: str(raw['defaultBranch']) ?? 'main',
        visibility: raw['visibility'] === 'private' ? 'private' : 'public',
      },
    ];
  });
}

export async function connectRepository(
  projectId: string,
  input: { owner: string; repository: string; branch: string },
  fetchImpl?: typeof fetch,
): Promise<SyncConnectionView> {
  const response = await apiRequest<unknown>(projectPath(projectId, '/connect'), {
    method: 'POST',
    body: input,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const connection = isRecord(response) ? parseConnection(response['connection']) : null;
  const parsed = connection ?? parseConnection(response);
  if (parsed === null) throw malformed();
  return parsed;
}

export async function disconnectRepository(
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await apiRequest<unknown>(projectPath(projectId, ''), {
    method: 'DELETE',
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

export async function createPlan(projectId: string, fetchImpl?: typeof fetch): Promise<SyncPlan> {
  return parsePlan(
    await apiRequest<unknown>(projectPath(projectId, '/plans'), {
      method: 'POST',
      body: {},
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  );
}

export async function fetchPlan(planId: string, fetchImpl?: typeof fetch): Promise<SyncPlan> {
  return parsePlan(
    await apiRequest<unknown>(planPath(planId, ''), {
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  );
}

export async function approvePlan(planId: string, fetchImpl?: typeof fetch): Promise<SyncPlan> {
  return parsePlan(
    await apiRequest<unknown>(planPath(planId, '/approval'), {
      method: 'POST',
      body: {},
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  );
}

/** Both sides of a conflict, as the server is willing to show them. */
export interface ConflictDetail {
  readonly conflict: SyncConflict;
  readonly local: string | null;
  readonly remote: string | null;
  /** True when a side was withheld because it looks like it holds a credential. */
  readonly withheld: boolean;
}

export async function fetchConflictDetail(
  planId: string,
  conflictId: string,
  fetchImpl?: typeof fetch,
): Promise<ConflictDetail> {
  const raw = await apiRequest<unknown>(
    planPath(planId, `/conflicts/${encodeURIComponent(conflictId)}`),
    { ...(fetchImpl === undefined ? {} : { fetchImpl }) },
  );
  if (!isRecord(raw)) throw malformed();
  const conflict = parseConflict(raw['conflict']);
  if (conflict === null) throw malformed();
  return {
    conflict,
    local: str(raw['local']),
    remote: str(raw['remote']),
    withheld: bool(raw['withheld']),
  };
}

export async function resolveConflict(
  planId: string,
  conflictId: string,
  input: { resolution: ConflictResolution; manualContent?: string },
  fetchImpl?: typeof fetch,
): Promise<SyncPlan> {
  return parsePlan(
    await apiRequest<unknown>(planPath(planId, `/conflicts/${encodeURIComponent(conflictId)}`), {
      method: 'POST',
      body: input,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  );
}

export async function applyPlan(
  planId: string,
  fetchImpl?: typeof fetch,
): Promise<{ plan: SyncPlan; commitSha: string | null }> {
  const raw = await apiRequest<unknown>(planPath(planId, '/apply'), {
    method: 'POST',
    body: {},
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  if (!isRecord(raw)) throw malformed();
  return {
    plan: parsePlan(raw['plan']),
    commitSha: str(raw['commitSha']),
  };
}

export async function cancelPlan(planId: string, fetchImpl?: typeof fetch): Promise<SyncPlan> {
  return parsePlan(
    await apiRequest<unknown>(planPath(planId, '/cancel'), {
      method: 'POST',
      body: {},
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  );
}

export async function fetchHistory(
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<SyncHistoryView> {
  return parseHistory(
    await apiRequest<unknown>(projectPath(projectId, '/history'), {
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  );
}

export { ApiError, isOffline, runtimeConfig };
