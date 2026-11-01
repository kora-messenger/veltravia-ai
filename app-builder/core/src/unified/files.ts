import { isBackendSourceFile } from '../backend/index.js';

import {
  FILE_GROUPS,
  type FileGroup,
  type FileGroupSummary,
  type FileGrouping,
  type GroupedFile,
} from './types.js';

/**
 * Logical grouping for the unified file explorer (Step 34).
 *
 * Grouping is a READING AID, not a filesystem operation: the project's real
 * paths are returned unchanged and unevaluated paths are never rewritten. Every
 * file lands in exactly one group, so the explorer can never show fewer files
 * than the workspace holds.
 */

/** Files listed per group before the rest are counted only. */
export const GROUP_LISTING_CAP = 200;

const LABELS: Record<FileGroup, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  shared: 'Shared',
  configuration: 'Configuration',
  tests: 'Tests',
  assets: 'Assets',
  other: 'Other',
};

const TEST_RULES: readonly RegExp[] = [
  /(?:^|\/)(?:__tests__|tests?|spec|e2e)\//i,
  /\.(?:test|spec)\.[a-z0-9]+$/i,
];

const CONFIG_FILES: readonly RegExp[] = [
  /(?:^|\/)(?:package|composer|pubspec)\.json$/i,
  /(?:^|\/)(?:requirements|constraints)\.txt$/i,
  /(?:^|\/)(?:pyproject|Cargo|go)\.(?:toml|mod)$/i,
  /(?:^|\/)tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/i,
  /(?:^|\/)(?:vite|vitest|webpack|rollup|esbuild|next|nuxt|svelte|tailwind|postcss|babel)(?:\.[A-Za-z0-9_-]+)?\.(?:config|setup)\.[a-z0-9]+$/i,
  /(?:^|\/)\.env(?:\.[A-Za-z0-9_-]+)?$/,
  /(?:^|\/)(?:Dockerfile|Makefile|Procfile)$/,
  /(?:^|\/)[^/]+\.(?:ya?ml|ini|toml)$/i,
  /(?:^|\/)\.(?:eslintrc|prettierrc|gitignore|dockerignore|npmrc|nvmrc)[^/]*$/i,
  /(?:^|\/)(?:\.?)eslint\.config\.[a-z0-9]+$/i,
  /(?:^|\/)prettier\.config\.[a-z0-9]+$/i,
];

const ASSET_EXTENSIONS =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|mp4|webm|mov|pdf)$/i;

const SHARED_DIRECTORIES = /(?:^|\/)(?:shared|common|lib|utils|types|packages)(?:\/|$)/i;

const FRONTEND_DIRECTORIES =
  /(?:^|\/)(?:app|pages|views|screens|components|layouts|hooks|styles|public|assets|static)(?:\/|$)/i;

const FRONTEND_EXTENSIONS = /\.(?:tsx|jsx|vue|svelte|dart|css|scss|sass|less|html?)$/i;

const BACKEND_DIRECTORIES =
  /(?:^|\/)(?:api|routes?|controllers?|handlers?|server|models?|schemas?|entities|services|db|database|prisma|migrations?|functions|workers|middleware|guards?)(?:\/|$)/i;

/** Which group a single path belongs to. Deterministic and order-sensitive. */
export function groupForPath(path: string): FileGroup {
  if (TEST_RULES.some((rule) => rule.test(path))) return 'tests';
  if (CONFIG_FILES.some((rule) => rule.test(path))) return 'configuration';
  if (ASSET_EXTENSIONS.test(path)) return 'assets';
  if (SHARED_DIRECTORIES.test(path)) return 'shared';
  // A UI extension wins: `src/components/Button.tsx` is frontend even though the
  // backend classifier also accepts TypeScript. Backend-specific names are
  // checked first only for files that are not UI files.
  if (FRONTEND_EXTENSIONS.test(path) && !BACKEND_DIRECTORIES.test(path)) return 'frontend';
  // The backend classifier is the source of truth for backend source files, so
  // this grouping cannot drift from what the backend builder analyses.
  if (isBackendSourceFile(path) || BACKEND_DIRECTORIES.test(path)) return 'backend';
  if (FRONTEND_DIRECTORIES.test(path)) return 'frontend';
  return 'other';
}

export interface GroupingInputFile {
  readonly path: string;
  readonly size: number;
}

/** Groups a workspace listing. Paths are returned exactly as supplied. */
export function groupWorkspaceFiles(files: readonly GroupingInputFile[]): FileGrouping {
  const buckets = new Map<FileGroup, GroupedFile[]>();
  const byPath: Record<string, FileGroup> = {};
  let bytes = 0;

  for (const file of files) {
    const group = groupForPath(file.path);
    byPath[file.path] = group;
    bytes += file.size;
    const bucket = buckets.get(group);
    const entry: GroupedFile = { path: file.path, size: file.size, group };
    if (bucket === undefined) buckets.set(group, [entry]);
    else bucket.push(entry);
  }

  const groups: FileGroupSummary[] = [];
  for (const group of FILE_GROUPS) {
    const entries = buckets.get(group) ?? [];
    if (entries.length === 0) continue;
    const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
    groups.push({
      group,
      label: LABELS[group],
      count: sorted.length,
      files: sorted.slice(0, GROUP_LISTING_CAP),
      omitted: Math.max(0, sorted.length - GROUP_LISTING_CAP),
    });
  }

  return { groups, totals: { files: files.length, bytes }, byPath };
}

/** The label for a group, for callers that render a single file's group. */
export function fileGroupLabel(group: FileGroup): string {
  return LABELS[group];
}
