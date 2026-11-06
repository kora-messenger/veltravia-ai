import { runtimeConfig } from '../config/runtime-config.js';
import { ApiError, apiRequest, isOffline } from './client';

/**
 * Native source-code export client (Step 40, phase 2).
 *
 * Like the testing client this sends NO owner header: the projects the web app
 * creates belong to the server's development owner, and the export routes apply
 * the same rule to a request with no header.
 *
 * Every response is checked before a page sees it. Nothing here holds file
 * CONTENT except the archive itself, and only while a download takes.
 */

export type ExportScope = 'project' | 'selection';
export type ExportStatus = 'running' | 'ready' | 'failed' | 'expired';
export type ExclusionReason =
  | 'credential-file'
  | 'secret-in-content'
  | 'too-large'
  | 'total-size-limit'
  | 'file-count-limit'
  | 'unreadable';

export interface ExcludedFile {
  readonly path: string;
  readonly reason: ExclusionReason;
  readonly detail: string;
}

export interface IncludedFile {
  readonly path: string;
  readonly size: number;
  readonly contentHash: string;
}

export interface ExportView {
  readonly exportId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly scope: ExportScope;
  readonly selection: readonly string[];
  readonly status: ExportStatus;
  readonly revision: number | null;
  readonly fileName: string | null;
  readonly archiveBytes: number | null;
  readonly archiveHash: string | null;
  readonly included: readonly IncludedFile[];
  readonly excluded: readonly ExcludedFile[];
  readonly totals: { readonly files: number; readonly bytes: number };
  readonly consistencyRetries: number;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface ExportValidation {
  readonly exportId: string;
  readonly valid: boolean;
  readonly entries: number;
  readonly problems: readonly string[];
}

const STATUSES: readonly ExportStatus[] = ['running', 'ready', 'failed', 'expired'];
const REASONS: readonly ExclusionReason[] = [
  'credential-file',
  'secret-in-content',
  'too-large',
  'total-size-limit',
  'file-count-limit',
  'unreadable',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function malformed(): never {
  throw new ApiError(502, 'EXPORT_MALFORMED', 'The service sent an export this page cannot read.');
}

/** Check a server payload and return it typed, or refuse it. */
export function parseExportView(value: unknown): ExportView {
  if (!isRecord(value)) return malformed();
  if (
    typeof value['exportId'] !== 'string' ||
    !STATUSES.includes(value['status'] as ExportStatus)
  ) {
    return malformed();
  }
  const { excluded, included, totals } = value;
  if (!Array.isArray(excluded) || !Array.isArray(included) || !isRecord(totals)) return malformed();
  for (const entry of excluded) {
    if (
      !isRecord(entry) ||
      typeof entry['path'] !== 'string' ||
      !REASONS.includes(entry['reason'] as ExclusionReason)
    ) {
      return malformed();
    }
  }
  if (typeof totals['files'] !== 'number' || typeof totals['bytes'] !== 'number')
    return malformed();
  return value as unknown as ExportView;
}

export async function createExport(
  projectId: string,
  request: { readonly scope: ExportScope; readonly paths?: readonly string[] },
): Promise<ExportView> {
  const body =
    request.scope === 'selection'
      ? { scope: 'selection', paths: [...(request.paths ?? [])] }
      : { scope: 'project' };
  const response = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/exports`,
    { method: 'POST', body },
  );
  return parseExportView(response);
}

export async function getExport(exportId: string): Promise<ExportView> {
  return parseExportView(await apiRequest<unknown>(`/api/exports/${encodeURIComponent(exportId)}`));
}

export async function listExports(projectId: string): Promise<readonly ExportView[]> {
  const response = await apiRequest<unknown>(
    `/api/exports?projectId=${encodeURIComponent(projectId)}`,
  );
  if (!isRecord(response) || !Array.isArray(response['exports'])) return malformed();
  return response['exports'].map(parseExportView);
}

export async function validateExport(exportId: string): Promise<ExportValidation> {
  const response = await apiRequest<unknown>(
    `/api/exports/${encodeURIComponent(exportId)}/validate`,
  );
  if (
    !isRecord(response) ||
    typeof response['valid'] !== 'boolean' ||
    !Array.isArray(response['problems'])
  ) {
    return malformed();
  }
  return response as unknown as ExportValidation;
}

export async function discardExport(exportId: string): Promise<void> {
  await apiRequest<void>(`/api/exports/${encodeURIComponent(exportId)}`, { method: 'DELETE' });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  // Copy into a Uint8Array made HERE. Under jsdom on Node 20, the ArrayBuffer a
  // Response returns comes from another realm and crypto.subtle refuses it; a
  // typed array built in this realm is accepted everywhere, including a browser.
  const digest = await subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DownloadedArchive {
  readonly blob: Blob;
  readonly fileName: string;
  /** True when the browser recomputed the hash and it matched the server's. */
  readonly verified: boolean;
}

async function failureMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && isRecord(payload['error'])) {
      const message = payload['error']['message'];
      if (typeof message === 'string') return message;
    }
  } catch {
    /* keep the generic message */
  }
  return 'The download failed.';
}

/**
 * Fetch the archive bytes. When the browser can hash them, the hash is compared
 * with the one the server recorded; a mismatch is an error, so a truncated or
 * altered download is never handed over as if it were fine.
 */
export async function downloadExport(
  view: Pick<ExportView, 'exportId' | 'fileName' | 'archiveHash'>,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadedArchive> {
  if (isOffline()) throw new ApiError(0, 'OFFLINE', 'You are offline. The download did not start.');
  let response: Response;
  try {
    response = await fetchImpl(
      `${runtimeConfig().apiBaseUrl}/api/exports/${encodeURIComponent(view.exportId)}/download`,
    );
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Veltravia AI service.');
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'EXPORT_DOWNLOAD_FAILED', await failureMessage(response));
  }
  const bytes = await response.arrayBuffer();
  const expected = view.archiveHash ?? response.headers.get('x-veltravia-archive-sha256');
  const actual = await sha256Hex(bytes);
  if (actual !== null && expected !== null && actual !== expected) {
    throw new ApiError(
      502,
      'EXPORT_CORRUPT',
      'The downloaded file does not match the export. It was not saved; try again.',
    );
  }
  return {
    blob: new Blob([bytes], { type: 'application/zip' }),
    fileName: view.fileName ?? 'project.zip',
    verified: actual !== null && expected !== null,
  };
}

/** Hand a downloaded archive to the browser's save flow. */
export function saveArchive(archive: DownloadedArchive): void {
  const url = URL.createObjectURL(archive.blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = archive.fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
