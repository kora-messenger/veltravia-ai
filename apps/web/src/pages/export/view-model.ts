import type { ExclusionReason, ExportStatus, ExportView } from '../../api/exports';

/**
 * Wording and arithmetic for the export page. Pure functions: nothing here
 * calls the network, and nothing decides whether an export is safe. The server
 * did that; this only says what it found.
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function pluralFiles(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

export function reasonLabel(reason: ExclusionReason): string {
  switch (reason) {
    case 'credential-file':
      return 'Credential file';
    case 'secret-in-content':
      return 'Looks like a secret';
    case 'too-large':
      return 'Too large';
    case 'total-size-limit':
      return 'Archive size limit';
    case 'file-count-limit':
      return 'File count limit';
    case 'unreadable':
      return 'Could not be read';
  }
}

export function statusLabel(status: ExportStatus): string {
  switch (status) {
    case 'running':
      return 'Exporting';
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired';
  }
}

export type BadgeToneName = 'neutral' | 'primary' | 'success' | 'warning' | 'error';

export function statusTone(status: ExportStatus): BadgeToneName {
  switch (status) {
    case 'ready':
      return 'success';
    case 'failed':
      return 'error';
    case 'expired':
      return 'warning';
    case 'running':
      return 'primary';
  }
}

/** A friendlier line for the failure codes a person can act on. */
export function failureAdvice(code: string): string {
  switch (code) {
    case 'EXPORT_REVISION_CONFLICT':
      return 'The project was being edited while it was exported, so nothing was saved. Try again once editing has paused.';
    case 'EXPORT_NOTHING_TO_EXPORT':
      return 'There was nothing safe to export. Anything left out is listed below.';
    case 'EXPORT_TOO_LARGE':
      return 'The archive would be larger than an export may be. Export a smaller selection instead.';
    case 'EXPORT_RATE_LIMITED':
      return 'Too many exports in a short time. Wait a moment and try again.';
    case 'EXPORT_NOT_FOUND':
      return 'That export or project is no longer available.';
    case 'EXPORT_EXPIRED':
      return 'This export has expired. Run it again to get a fresh file.';
    default:
      return 'The export could not be completed.';
  }
}

export function minutesLeft(expiresAt: string | null, now: number): number | null {
  if (expiresAt === null) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return null;
  return ms <= 0 ? 0 : Math.ceil(ms / 60000);
}

/** One-line description of what an export covers. */
export function scopeSummary(view: Pick<ExportView, 'scope' | 'selection'>): string {
  if (view.scope === 'project') return 'Whole project';
  const count = view.selection.length;
  return count === 1 ? `Selection: ${view.selection[0]}` : `Selection of ${count} items`;
}

export interface TreeEntry {
  readonly path: string;
  readonly type: 'file' | 'directory';
}

/**
 * Items the picker offers, in a stable order: folders and files together,
 * sorted by path so a folder is followed by its children.
 */
export function pickerEntries(
  files: readonly { readonly path: string }[],
  directories: readonly string[],
): readonly TreeEntry[] {
  const entries: TreeEntry[] = [
    ...directories.map((path) => ({ path, type: 'directory' as const })),
    ...files.map((file) => ({ path: file.path, type: 'file' as const })),
  ];
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function depthOf(path: string): number {
  return path.split('/').length - 1;
}

/** True when `path` is inside (or is) any selected path, so it shows as covered. */
export function isCovered(path: string, selected: ReadonlySet<string>): boolean {
  for (const chosen of selected) {
    if (path === chosen || path.startsWith(`${chosen}/`)) return true;
  }
  return false;
}

/**
 * Toggle a path in a selection. Choosing a folder drops its already-chosen
 * children (the folder covers them); un-choosing is a plain removal.
 */
export function toggleSelection(selected: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(selected);
  if (next.has(path)) {
    next.delete(path);
    return next;
  }
  for (const chosen of selected) {
    if (chosen.startsWith(`${path}/`)) next.delete(chosen);
  }
  next.add(path);
  return next;
}
