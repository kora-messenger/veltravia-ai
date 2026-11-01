import {
  buildAppHealth,
  buildUnifiedOverview,
  classifyFrontendStructure,
  detectCrossLayerLinks,
  groupWorkspaceFiles,
  type AppHealth,
  type CrossLayerGraph,
  type FileGrouping,
  type UnifiedOverview,
} from '@veltravia/app-builder-core';
import type { SourceRepositoryManager, SourceTreeView } from '@veltravia/source-storage-core';

import { scanBackend, type BackendScanDeps } from './backend-scan.js';

/**
 * Unified application workspace loader (Step 34).
 *
 * One project is one application, so this composes the systems that already
 * exist rather than inventing a second one: the source layer supplies the tree,
 * the backend scan and frontend classifier supply the layers, and the pure core
 * derives the file grouping, the cross-layer graph, the health panel and the
 * overview from those reports.
 *
 * Nothing here writes, executes, connects to a database or reads a secret. The
 * only reads are bounded file reads through the source layer, which enforces
 * project ownership.
 */

export const UNIFIED_READ_LIMITS = {
  /** Frontend-ish files whose text is read to find request sites. */
  maxUiFiles: 60,
  /** Distinct backend files read to resolve handler -> model edges. */
  maxRouteFiles: 40,
  maxBytesPerFile: 48 * 1024,
} as const;

export interface UnifiedProjectMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly projectType: string;
  readonly status: string;
  readonly updatedAt: string;
}

export interface UnifiedWorkspaceMeta {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly revision: number;
}

export interface UnifiedDeps {
  readonly source: SourceRepositoryManager;
  /** The same scan the Backend Builder uses: one analyser, no second opinion. */
  readonly scan: BackendScanDeps;
  readonly describeProject: (projectId: string, ownerRef: string) => Promise<UnifiedProjectMeta>;
  /** Live runtime state, supplied by the server. Absent means `none`. */
  readonly runtimeState?: (
    projectId: string,
    workspaceId: string,
  ) => Promise<'running' | 'stopped' | 'none'>;
}

export interface UnifiedAppView {
  readonly project: UnifiedProjectMeta;
  readonly workspace: UnifiedWorkspaceMeta | null;
  readonly source: {
    readonly rootRevision: number;
    readonly files: number;
    readonly directories: number;
    readonly bytes: number;
  };
  readonly overview: UnifiedOverview;
  readonly health: AppHealth;
  readonly files: FileGrouping;
  readonly links: CrossLayerGraph;
}

export interface UnifiedInput {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId?: string;
}

const UI_FILE = /\.(?:tsx|jsx|vue|svelte|dart|ts|js|mjs|astro|html)$/i;

function priority(path: string): number {
  if (/\.(?:tsx|jsx|vue|svelte|astro)$/i.test(path)) return 0;
  if (/(?:^|\/)(?:api|services|client|lib|hooks|utils)(?:\/|$)/i.test(path)) return 1;
  return 2;
}

async function readBounded(
  source: SourceRepositoryManager,
  input: UnifiedInput,
  workspaceId: string,
  paths: readonly string[],
): Promise<{ files: { path: string; content: string }[]; truncated: boolean }> {
  const files: { path: string; content: string }[] = [];
  let truncated = false;
  for (const path of paths) {
    try {
      const read = await source.readFile(input.ownerRef, {
        projectId: input.projectId,
        workspaceId,
        path,
      });
      if (read.truncated) truncated = true;
      files.push({ path: read.path, content: read.content });
    } catch {
      // An unreadable file simply contributes no edges; the health panel says so.
      truncated = true;
    }
  }
  return { files, truncated };
}

/** Composes every unified view in one pass over the same tree. */
export async function loadUnifiedApp(
  deps: UnifiedDeps,
  input: UnifiedInput,
): Promise<UnifiedAppView> {
  const [project, backendReport] = await Promise.all([
    deps.describeProject(input.projectId, input.ownerRef),
    scanBackend(deps.scan, input),
  ]);

  const tree: SourceTreeView = await deps.source.tree(input.ownerRef, {
    projectId: input.projectId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  });
  const workspaceId = tree.workspaceId;

  const fileEntries = tree.files
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({ path: entry.path, size: entry.size }));
  const grouping = groupWorkspaceFiles(fileEntries);

  // The classifier reads paths only; detection supplies the framework id it may
  // name. An unrecognised stack stays null.
  const frontend = classifyFrontendStructure({
    files: tree.files
      .filter((entry) => entry.type === 'file')
      .map((entry) => ({ path: entry.path, size: entry.size })),
    framework: backendReport.structure.framework,
  });

  // Request sites live in UI and client code; handler -> model edges live in the
  // files that declare routes. Both reads are capped.
  const uiCandidates = fileEntries
    .filter((entry) => UI_FILE.test(entry.path))
    .filter(
      (entry) =>
        grouping.byPath[entry.path] === 'frontend' || grouping.byPath[entry.path] === 'shared',
    )
    .filter((entry) => entry.size <= UNIFIED_READ_LIMITS.maxBytesPerFile)
    .sort(
      (left, right) =>
        priority(left.path) - priority(right.path) || left.path.localeCompare(right.path),
    )
    .slice(0, UNIFIED_READ_LIMITS.maxUiFiles)
    .map((entry) => entry.path);

  const routeFiles = [...new Set(backendReport.routes.map((route) => route.file))]
    .filter((path) => path.length > 0)
    .slice(0, UNIFIED_READ_LIMITS.maxRouteFiles);

  const readUi = await readBounded(
    deps.source,
    { ...input, workspaceId },
    workspaceId,
    uiCandidates,
  );
  const readRoutes = await readBounded(
    deps.source,
    { ...input, workspaceId },
    workspaceId,
    routeFiles.filter((path) => !uiCandidates.includes(path)),
  );

  const graph = detectCrossLayerLinks({
    files: [...readUi.files, ...readRoutes.files],
    routes: backendReport.routes,
    models: backendReport.models,
  });

  const runtimeState =
    deps.runtimeState === undefined
      ? 'none'
      : await deps.runtimeState(input.projectId, workspaceId).catch(() => 'none' as const);

  const groupCount = (group: string): number =>
    grouping.groups.find((entry) => entry.group === group)?.count ?? 0;

  // The panel and the explorer must agree on what a "frontend file" is, so the
  // counts come from the grouping that the file explorer renders, not from the
  // scan's own wider view of the tree.
  const health = buildAppHealth({
    frontendFiles: groupCount('frontend'),
    backendFiles: groupCount('backend'),
    frontendLayout: frontend.layout,
    frontendFramework: frontend.framework,
    backend: backendReport,
    configurationFiles: groupCount('configuration'),
    testFiles: groupCount('tests'),
    runtime: runtimeState,
    unmatchedRequests: graph.unmatchedRequests.length,
    scanCapped: backendReport.scanned.skipped > 0 || readUi.truncated || readRoutes.truncated,
  });

  let recentChanges: { path: string; action: string; at: string }[];
  try {
    const history = await deps.source.history(input.ownerRef, {
      projectId: input.projectId,
      workspaceId,
      limit: 12,
    });
    recentChanges = history.entries.map((entry) => ({
      path: entry.path,
      action: entry.changeKind,
      at: entry.at,
    }));
  } catch {
    recentChanges = [];
  }

  const overview = buildUnifiedOverview({
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      projectType: project.projectType,
      status: project.status,
      updatedAt: project.updatedAt,
    },
    workspace: {
      id: workspaceId,
      name: workspaceId,
      branch: '',
      revision: tree.rootRevision,
    },
    detection: {
      framework: backendReport.structure.framework,
      language: backendReport.structure.language,
      runtime: backendReport.structure.runtime,
    },
    frontend,
    backend: backendReport,
    grouping,
    graph,
    health,
    recentChanges,
  });

  return {
    project,
    workspace: {
      id: workspaceId,
      name: workspaceId,
      branch: '',
      revision: tree.rootRevision,
    },
    source: {
      rootRevision: tree.rootRevision,
      files: tree.totals.files,
      directories: tree.directories.length,
      bytes: tree.totals.bytes,
    },
    overview,
    health,
    files: grouping,
    links: graph,
  };
}

export const UNIFIED_CAPABILITIES = {
  readOnly: true,
  sections: {
    overview: 'implemented',
    frontend: 'implemented',
    backend: 'implemented',
    database: 'inspection-only',
    'api-routes': 'implemented',
    files: 'implemented',
    connections: 'detected-from-source',
    'ai-assistant': 'coding-agent-with-approval',
    settings: 'read-only',
  },
  composition: {
    sourceOfTruth: 'the project engine and the native source layer',
    duplicateStores: false,
    secondAiSystem: false,
    scans: 'bounded, read-only, through the source layer',
  },
  unavailable: [
    'deployment',
    'hosting',
    'database connections',
    'migrations',
    'autonomous coding',
    'unrestricted shell execution',
    'billing',
  ],
  writes: 'coding-agent-run-with-human-approval',
} as const;
