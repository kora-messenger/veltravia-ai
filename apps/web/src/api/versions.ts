/**
 * Version Control API surface + safe UI models (Step 18).
 *
 * Raw backend responses are mapped into typed views before reaching the UI.
 * Revision views are METADATA ONLY (the backend never sends snapshot
 * contents); diff views are the bounded, server-computed comparisons.
 * The browser can only issue rollback INTENTS - the restore happens
 * server-side, only through the Tool System, after a human confirmation
 * bound to the exact input.
 */
import { apiRequest } from './client';

const enc = encodeURIComponent;

export type RevisionSource =
  | 'manual'
  | 'generation_before'
  | 'generation_after'
  | 'testing_before_repair'
  | 'testing_after'
  | 'coding_before'
  | 'coding_after'
  | 'rollback';

export interface RevisionChangeView {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly total: number;
}

/** Safe UI model for a revision record (metadata only - never contents). */
export interface RevisionView {
  readonly id: string;
  readonly revisionNumber: number;
  readonly parentRevisionId: string | null;
  readonly createdAt: string;
  readonly source: RevisionSource | string;
  readonly change: RevisionChangeView;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly message: string | null;
  readonly restoredFromRevisionId: string | null;
  readonly checkpointRefs: readonly { id: string; name: string }[];
}

export interface CheckpointView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
}

export interface DiffFileView {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' | 'unchanged' | string;
  readonly lines: readonly { readonly kind: string; readonly text: string }[];
}

export interface DiffView {
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly fromLabel: string | null;
  readonly toLabel: string | null;
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly renamed: number;
  readonly unchanged: number;
  readonly files: readonly DiffFileView[];
}

export type RollbackOperationState =
  'pending_confirmation' | 'approved' | 'rejected' | 'completed' | 'failed';

export interface RollbackOperationView {
  readonly id: string;
  readonly state: RollbackOperationState | string;
  readonly createdAt: string;
  readonly result: {
    readonly newRevisionId: string;
    readonly newRevisionNumber: number;
    readonly restoredFromRevisionId: string;
    readonly restoredFromRevisionNumber: number;
    readonly filesChanged: number;
  } | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly request: {
    readonly workspaceId: string;
    readonly targetRevisionId: string;
    readonly expectedCurrentRevision: number;
    readonly reason: string | null;
  };
}

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
  return typeof value === 'number' ? value : 0;
}

function toRevisionView(raw: unknown): RevisionView {
  const record = asRecord(raw);
  const change = asRecord(record.change);
  const checkpointRefs = Array.isArray(record.checkpointRefs)
    ? record.checkpointRefs.map((ref) => {
        const entry = asRecord(ref);
        return { id: asString(entry.id), name: asString(entry.name) };
      })
    : [];
  return {
    id: asString(record.id),
    revisionNumber: asNumber(record.revisionNumber),
    parentRevisionId: asNullableString(record.parentRevisionId),
    createdAt: asString(record.createdAt),
    source: asString(record.source),
    change: {
      added: asNumber(change.added),
      modified: asNumber(change.modified),
      deleted: asNumber(change.deleted),
      total: asNumber(change.total),
    },
    fileCount: asNumber(record.fileCount),
    totalBytes: asNumber(record.totalBytes),
    message: asNullableString(record.message),
    restoredFromRevisionId: asNullableString(record.restoredFromRevisionId),
    checkpointRefs,
  };
}

function toCheckpointView(raw: unknown): CheckpointView {
  const record = asRecord(raw);
  const revision = asRecord(record.revision);
  return {
    id: asString(record.id),
    name: asString(record.name),
    description: asNullableString(record.description),
    createdAt: asString(record.createdAt),
    revisionId: asString(revision.id),
    revisionNumber: asNumber(revision.revisionNumber),
  };
}

function toDiffView(raw: unknown): DiffView {
  const record = asRecord(raw);
  const files = Array.isArray(record.files)
    ? record.files.map((file) => {
        const entry = asRecord(file);
        const lines = Array.isArray(entry.lines)
          ? entry.lines.map((line) => {
              const l = asRecord(line);
              return { kind: asString(l.kind), text: asString(l.text) };
            })
          : [];
        return { path: asString(entry.path), kind: asString(entry.kind), lines };
      })
    : [];
  return {
    fromRevisionId: asString(record.fromRevisionId),
    toRevisionId: asString(record.toRevisionId),
    fromLabel: asNullableString(record.fromLabel),
    toLabel: asNullableString(record.toLabel),
    added: asNumber(record.added),
    modified: asNumber(record.modified),
    deleted: asNumber(record.deleted),
    renamed: asNumber(record.renamed),
    unchanged: asNumber(record.unchanged),
    files,
  };
}

function toOperationView(raw: unknown): RollbackOperationView {
  const record = asRecord(raw);
  const request = asRecord(record.request);
  const result = asRecord(record.result);
  const hasResult = result.id !== undefined || result.newRevisionId !== undefined;
  return {
    id: asString(record.id),
    state: asString(record.state),
    createdAt: asString(record.createdAt),
    result: hasResult
      ? {
          newRevisionId: asString(result.newRevisionId),
          newRevisionNumber: asNumber(result.newRevisionNumber),
          restoredFromRevisionId: asString(result.restoredFromRevisionId),
          restoredFromRevisionNumber: asNumber(result.restoredFromRevisionNumber),
          filesChanged: asNumber(result.filesChanged),
        }
      : null,
    failureCode: asNullableString(record.failureCode),
    failureMessage: asNullableString(record.failureMessage),
    request: {
      workspaceId: asString(request.workspaceId),
      targetRevisionId: asString(request.targetRevisionId),
      expectedCurrentRevision: asNumber(request.expectedCurrentRevision),
      reason: asNullableString(request.reason),
    },
  };
}

export async function listRevisions(
  projectId: string,
  workspaceId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<readonly RevisionView[]> {
  const body = await apiRequest<{ revisions: Record<string, unknown>[] }>(
    `/api/projects/${enc(projectId)}/revisions?workspaceId=${enc(workspaceId)}`,
    { ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
  );
  return (body.revisions ?? []).map(toRevisionView);
}

/** Captures the current tree as a new revision (server-side snapshot). */
export async function captureRevision(
  projectId: string,
  workspaceId: string,
  options: { readonly message?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<RevisionView> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/revisions`,
    {
      method: 'POST',
      body: { workspaceId, ...(options.message !== undefined ? { message: options.message } : {}) },
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    },
  );
  return toRevisionView(raw);
}

export async function fetchRevisionDiff(
  projectId: string,
  workspaceId: string,
  revisionId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<DiffView> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/revisions/${enc(revisionId)}/diff?workspaceId=${enc(workspaceId)}`,
    { ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
  );
  return toDiffView(raw);
}

export async function listCheckpoints(
  projectId: string,
  workspaceId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<readonly CheckpointView[]> {
  const body = await apiRequest<{ checkpoints: Record<string, unknown>[] }>(
    `/api/projects/${enc(projectId)}/checkpoints?workspaceId=${enc(workspaceId)}`,
    { ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
  );
  return (body.checkpoints ?? []).map(toCheckpointView);
}

export async function createCheckpoint(
  projectId: string,
  workspaceId: string,
  input: {
    readonly name: string;
    readonly description?: string;
    readonly revisionId?: string;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<CheckpointView> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/checkpoints`,
    {
      method: 'POST',
      body: {
        workspaceId,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.revisionId !== undefined ? { revisionId: input.revisionId } : {}),
      },
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    },
  );
  return toCheckpointView(raw);
}

export async function deleteCheckpoint(
  projectId: string,
  workspaceId: string,
  checkpointId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await apiRequest(
    `/api/projects/${enc(projectId)}/checkpoints/${enc(checkpointId)}?workspaceId=${enc(workspaceId)}`,
    {
      method: 'DELETE',
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    },
  );
}

export interface OpenedRollback {
  readonly operation: RollbackOperationView;
  readonly validation: {
    readonly targetRevisionId: string;
    readonly targetRevisionNumber: number;
    readonly currentRevision: number;
    readonly filesChanged: number;
  };
}

/**
 * Opens a rollback. The server validates the target and pauses for a HUMAN
 * confirmation; nothing is restored until the decision endpoint approves.
 */
export async function openRollback(
  projectId: string,
  input: {
    readonly workspaceId: string;
    readonly targetRevisionId: string;
    readonly expectedCurrentRevision: number;
    readonly reason?: string;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<OpenedRollback> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/rollback`,
    {
      method: 'POST',
      body: {
        workspaceId: input.workspaceId,
        targetRevisionId: input.targetRevisionId,
        expectedCurrentRevision: input.expectedCurrentRevision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    },
  );
  const validation = asRecord(asRecord(raw).validation);
  return {
    operation: toOperationView(asRecord(raw).operation),
    validation: {
      targetRevisionId: asString(validation.targetRevisionId),
      targetRevisionNumber: asNumber(validation.targetRevisionNumber),
      currentRevision: asNumber(validation.currentRevision),
      filesChanged: asNumber(validation.filesChanged),
    },
  };
}

/** Submits the human decision for a paused rollback. */
export async function decideRollback(
  projectId: string,
  operationId: string,
  decision: 'approve' | 'reject',
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<RollbackOperationView> {
  const raw = await apiRequest<Record<string, unknown>>(
    `/api/projects/${enc(projectId)}/rollback/${enc(operationId)}/confirmation`,
    {
      method: 'POST',
      body: { decision },
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    },
  );
  // The approve-failure path wraps the operation view; unwrap it.
  const record = asRecord(raw);
  return toOperationView(record.operation !== undefined ? record.operation : raw);
}
