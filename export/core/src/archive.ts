import { createHash } from 'node:crypto';
import { zipSync, type Zippable } from 'fflate';

import { assertSafeExportPath } from './paths.js';
import { ExportError } from './errors.js';

/**
 * ZIP construction.
 *
 * Bytes in the archive are the file's text encoded as UTF-8, exactly as stored:
 * no newline conversion, no trimming, no formatting. Timestamps are fixed so the
 * same files always produce the same bytes (and the same hash).
 */

/** 1980-01-01, the earliest time a ZIP can record. */
const FIXED_TIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export interface ArchiveEntry {
  readonly path: string;
  readonly content: string;
}

export interface BuiltArchive {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export function buildArchive(entries: readonly ArchiveEntry[], rootFolder: string): BuiltArchive {
  const root = assertSafeExportPath(rootFolder);
  if (root.includes('/')) {
    throw new ExportError('EXPORT_PATH_INVALID', 'The archive root must be a single folder name.');
  }
  const zippable: Zippable = {};
  const seen = new Set<string>();
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    // Checked again here: the archive must be safe whatever fed it.
    const safe = assertSafeExportPath(entry.path);
    const name = `${root}/${safe}`;
    if (seen.has(name.toLowerCase())) {
      throw new ExportError('EXPORT_INTERNAL', 'Two files would share one name in the archive.');
    }
    seen.add(name.toLowerCase());
    zippable[name] = [
      new TextEncoder().encode(entry.content),
      // Level 6: a normal deflate. mtime fixed for reproducible output.
      { level: 6, mtime: FIXED_TIME },
    ];
  }
  const bytes = zipSync(zippable);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** A filesystem-safe archive base name from a project name. */
export function archiveBaseName(projectName: string): string {
  const cleaned = projectName
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'veltravia-project';
}

export function contentHashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
