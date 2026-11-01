import { apiRequest } from './client';

/**
 * Typed client for native project source storage (Step 31).
 *
 * The explorer shows exactly what the server reports: whether a file is in
 * history, how large it is, which revision it is at, and whether a read was
 * truncated. No client-side guessing.
 */

export interface SourceFileView {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly revision: number;
  readonly size: number;
  readonly updatedAt: string;
  readonly contentHash: string | null;
}

export interface SourceTreeView {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly rootRevision: number;
  readonly files: readonly SourceFileView[];
  readonly directories: readonly string[];
  readonly totals: { readonly files: number; readonly bytes: number };
}

export interface SourceFileContent {
  readonly path: string;
  readonly revision: number;
  readonly size: number;
  readonly contentHash: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface FileHistoryEntry {
  readonly id: string;
  readonly path: string;
  readonly changeKind: 'created' | 'modified' | 'deleted' | 'moved' | 'directory-created';
  readonly revision: number;
  readonly size: number;
  readonly contentHash: string | null;
  readonly actor: 'source-api' | 'ai-agent' | 'external-writer' | 'snapshot-restore';
  readonly summary: string;
  readonly at: string;
}

export async function fetchTree(projectId: string): Promise<SourceTreeView> {
  const response = await apiRequest<{ tree: SourceTreeView }>(
    `/api/projects/${encodeURIComponent(projectId)}/source`,
  );
  return response.tree;
}

export async function fetchFile(projectId: string, path: string): Promise<SourceFileContent> {
  const response = await apiRequest<{ file: SourceFileContent }>(
    `/api/projects/${encodeURIComponent(projectId)}/source/file?path=${encodeURIComponent(path)}`,
  );
  return response.file;
}

export async function fetchHistory(
  projectId: string,
  limit = 50,
): Promise<readonly FileHistoryEntry[]> {
  const response = await apiRequest<{ entries: readonly FileHistoryEntry[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/source/history?limit=${limit}`,
  );
  return response.entries;
}
