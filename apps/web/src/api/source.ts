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

/** Builds a source URL, carrying the workspace when the caller pinned one. */
function sourceUrl(
  projectId: string,
  suffix: string,
  workspaceId: string | undefined,
  params: Record<string, string | number> = {},
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  if (workspaceId !== undefined && workspaceId.length > 0) search.set('workspaceId', workspaceId);
  const query = search.toString();
  return `/api/projects/${encodeURIComponent(projectId)}/source${suffix}${query === '' ? '' : `?${query}`}`;
}

export async function fetchTree(projectId: string, workspaceId?: string): Promise<SourceTreeView> {
  const response = await apiRequest<{ tree: SourceTreeView }>(
    sourceUrl(projectId, '', workspaceId),
  );
  return response.tree;
}

export async function fetchFile(
  projectId: string,
  path: string,
  workspaceId?: string,
): Promise<SourceFileContent> {
  const response = await apiRequest<{ file: SourceFileContent }>(
    sourceUrl(projectId, '/file', workspaceId, { path }),
  );
  return response.file;
}

export async function fetchHistory(
  projectId: string,
  limit = 50,
  workspaceId?: string,
): Promise<readonly FileHistoryEntry[]> {
  const response = await apiRequest<{ entries: readonly FileHistoryEntry[] }>(
    sourceUrl(projectId, '/history', workspaceId, { limit }),
  );
  return response.entries;
}

/** Logical frontend sections (pages, components, …) computed by the server. */
export interface FrontendSectionView {
  readonly section: string;
  readonly label: string;
  readonly count: number;
  readonly bytes: number;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly omitted: number;
}

export interface FrontendStructureView {
  readonly layout: 'component-based' | 'flutter' | 'neutral';
  readonly framework: string | null;
  readonly totals: { readonly files: number; readonly bytes: number };
  readonly sections: readonly FrontendSectionView[];
  readonly pages: readonly string[];
  readonly components: readonly string[];
}

export async function fetchStructure(
  projectId: string,
  workspaceId?: string,
): Promise<FrontendStructureView> {
  const response = await apiRequest<{ structure: FrontendStructureView }>(
    sourceUrl(projectId, '/structure', workspaceId),
  );
  return response.structure;
}
