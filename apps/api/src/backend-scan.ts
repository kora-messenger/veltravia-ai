import {
  analyseBackend,
  isBackendSourceFile,
  type BackendReport,
  type BackendSnapshotFile,
} from '@veltravia/app-builder-core';
import type { SourceRepositoryManager } from '@veltravia/source-storage-core';

/**
 * Builds the backend report the UI reads (Step 33).
 *
 * The scan is deliberately narrow: it asks the source layer for the tree, reads
 * a bounded number of backend-shaped files, and hands the text to the pure
 * analyser. It never touches the host filesystem, never runs a command and never
 * resolves a secret. Ownership is the source layer's, not this module's.
 */

export const BACKEND_SCAN_LIMITS = {
  /** Files whose text is read at all. */
  maxFiles: 60,
  /** Bytes read per file; a larger file is cut and reported as truncated. */
  maxBytesPerFile: 48 * 1024,
  /** Files listed in the tree before we stop collecting candidates. */
  maxTreeFiles: 5_000,
} as const;

export interface BackendScanInput {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId?: string;
}

export interface BackendScanDeps {
  readonly source: SourceRepositoryManager;
  /**
   * Stack detection, supplied by the server. Absent or failing detection means
   * `framework: null`, never a guess.
   */
  readonly detect?: (
    projectId: string,
    workspaceId: string | undefined,
  ) => Promise<{ framework: string | null; language: string | null; runtime: string | null }>;
}

/** Higher rank wins the limited read budget. */
function priority(path: string): number {
  if (
    /(?:^|\/)package\.json$|requirements\.txt$|pyproject\.toml$|composer\.json$|go\.mod$/i.test(
      path,
    )
  ) {
    return 0;
  }
  if (/\.(prisma|sql)$/i.test(path)) return 1;
  if (/(?:^|\/)\.env(?:\.[A-Za-z0-9_-]+)?$/.test(path)) return 2;
  if (/(?:^|\/)(routes?|controllers?|handlers?|endpoints?)\//i.test(path)) return 3;
  if (/(?:^|\/)(models?|schemas?|entities)\//i.test(path)) return 4;
  if (/(?:^|\/)(auth|middleware|guards?)\//i.test(path)) return 5;
  if (/(?:^|\/)(functions|api|workers|serverless)\//i.test(path)) return 6;
  if (/(?:^|\/)(config|settings)\//i.test(path)) return 7;
  return 8;
}

export async function scanBackend(
  deps: BackendScanDeps,
  input: BackendScanInput,
): Promise<BackendReport> {
  const { source } = deps;
  const scoped = {
    projectId: input.projectId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  };

  // Ownership and revision are resolved here, by the source layer.
  const tree = await source.tree(input.ownerRef, scoped);

  let framework: string | null = null;
  let language: string | null = null;
  let runtime: string | null = null;
  if (deps.detect !== undefined) {
    try {
      const detected = await deps.detect(input.projectId, tree.workspaceId);
      framework = detected.framework;
      language = detected.language;
      runtime = detected.runtime;
    } catch {
      // Detection is descriptive; an unrecognised stack simply stays unknown.
    }
  }

  const candidates = tree.files
    .filter((file) => file.type === 'file' && isBackendSourceFile(file.path))
    .filter((file) => file.size <= BACKEND_SCAN_LIMITS.maxBytesPerFile)
    .slice(0, BACKEND_SCAN_LIMITS.maxTreeFiles)
    .sort(
      (left, right) =>
        priority(left.path) - priority(right.path) || left.path.localeCompare(right.path),
    );

  const selected = candidates.slice(0, BACKEND_SCAN_LIMITS.maxFiles);
  const skippedFiles = Math.max(0, candidates.length - selected.length);

  const files: BackendSnapshotFile[] = [];
  let truncated = false;
  let unreadable = 0;
  for (const candidate of selected) {
    try {
      const file = await source.readFile(input.ownerRef, { ...scoped, path: candidate.path });
      if (file.truncated) truncated = true;
      files.push({ path: file.path, size: file.size, content: file.content });
    } catch {
      // An unreadable file is skipped, not fatal: the count below reports it.
      unreadable += 1;
    }
  }

  const recentChanges = await readRecentChanges(source, input.ownerRef, scoped);

  return analyseBackend({
    files,
    framework,
    language,
    runtime,
    recentChanges,
    skippedFiles: skippedFiles + unreadable,
    truncated,
  });
}

async function readRecentChanges(
  source: SourceRepositoryManager,
  ownerRef: string,
  scoped: { projectId: string; workspaceId?: string },
): Promise<{ path: string; changeKind: string; at: string }[]> {
  try {
    const history = await source.history(ownerRef, { ...scoped, limit: 25 });
    return history.entries
      .filter((entry) => isBackendSourceFile(entry.path))
      .slice(0, 8)
      .map((entry) => ({ path: entry.path, changeKind: entry.changeKind, at: entry.at }));
  } catch {
    // History is a convenience; a project without it still gets a report.
    return [];
  }
}

/** Exposed for tests: which files a scan would read, in order. */
export function planScan(paths: readonly string[]): string[] {
  return paths
    .filter((path) => isBackendSourceFile(path))
    .sort((left, right) => priority(left) - priority(right) || left.localeCompare(right))
    .slice(0, BACKEND_SCAN_LIMITS.maxFiles);
}
