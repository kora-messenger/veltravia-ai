import { unzipSync } from 'fflate';

import { contentHashOf } from './archive.js';
import { assertSafeExportPath } from './paths.js';
import type { IncludedFile } from './types.js';
import { EXPORT_LIMITS } from './types.js';

/**
 * Check a stored archive against what the export says it contains.
 *
 * It opens the REAL bytes, so it can catch a corrupt archive, an entry the
 * export did not record, a recorded file that is missing, or content that no
 * longer matches its hash. Problems name paths and kinds, never content.
 */
export interface ArchiveValidation {
  readonly valid: boolean;
  readonly entries: number;
  readonly problems: readonly string[];
}

export function validateArchive(
  bytes: Uint8Array,
  rootFolder: string,
  included: readonly IncludedFile[],
): ArchiveValidation {
  const problems: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      // Refuse to inflate anything that was not recorded as included.
      filter: (entry) => entry.originalSize <= EXPORT_LIMITS.maxFileBytes,
    });
  } catch {
    return { valid: false, entries: 0, problems: ['The archive could not be opened.'] };
  }

  const expected = new Map(included.map((file) => [`${rootFolder}/${file.path}`, file]));
  const names = Object.keys(files).filter((name) => !name.endsWith('/'));

  for (const name of names) {
    try {
      assertSafeExportPath(name);
    } catch {
      problems.push('An entry has an unsafe name.');
      continue;
    }
    const record = expected.get(name);
    if (record === undefined) {
      problems.push(`An entry was not recorded by the export: ${name}`);
      continue;
    }
    const text = new TextDecoder().decode(files[name]);
    if (contentHashOf(text) !== record.contentHash) {
      problems.push(`Content does not match its recorded hash: ${name}`);
    }
  }
  for (const name of expected.keys()) {
    if (!names.includes(name)) problems.push(`A recorded file is missing: ${name}`);
  }
  return { valid: problems.length === 0, entries: names.length, problems };
}
