import type { BackendReport } from '../backend/index.js';
import type { FrontendStructure } from '../frontend/structure.js';

import type { AppHealth, CrossLayerGraph, FileGrouping } from './types.js';

/**
 * The unified project overview (Step 34).
 *
 * Every field either comes from the project record, from stack detection, or
 * from a scan of the files. A field that could not be established is null and
 * the UI shows an honest empty state: no invented framework, no invented
 * language, no invented "deployed" state.
 */

export interface OverviewProject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly projectType: string;
  readonly status: string;
  readonly updatedAt: string | null;
}

export interface OverviewWorkspace {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly revision: number;
}

export interface StackFact {
  readonly framework: string | null;
  readonly language: string | null;
  readonly runtime: string | null;
  /** `detected` when a manifest said so; `unknown` when nothing was found. */
  readonly source: 'detected' | 'unknown';
}

export interface RecentChangeSummary {
  readonly path: string;
  readonly action: string;
  readonly at: string;
}

export interface UnifiedOverview {
  readonly project: OverviewProject;
  readonly workspace: OverviewWorkspace | null;
  readonly stack: StackFact;
  readonly counts: {
    readonly files: number;
    readonly bytes: number;
    readonly frontendFiles: number;
    readonly backendFiles: number;
    readonly configurationFiles: number;
    readonly testFiles: number;
    readonly apiRoutes: number;
    readonly models: number;
    readonly requestSites: number;
    readonly matchedLinks: number;
  };
  readonly health: AppHealth;
  readonly recentChanges: readonly RecentChangeSummary[];
  readonly lastUpdated: string | null;
  readonly notes: readonly string[];
}

export interface OverviewInput {
  readonly project: OverviewProject;
  readonly workspace: OverviewWorkspace | null;
  readonly detection: {
    readonly framework: string | null;
    readonly language: string | null;
    readonly runtime: string | null;
  };
  readonly frontend: FrontendStructure;
  readonly backend: BackendReport;
  readonly grouping: FileGrouping;
  readonly graph: CrossLayerGraph;
  readonly health: AppHealth;
  readonly recentChanges: readonly RecentChangeSummary[];
}

function groupCount(grouping: FileGrouping, group: string): number {
  return grouping.groups.find((entry) => entry.group === group)?.count ?? 0;
}

export function buildUnifiedOverview(input: OverviewInput): UnifiedOverview {
  const notes: string[] = [];
  const stack: StackFact = {
    framework: input.detection.framework,
    language: input.detection.language,
    runtime: input.detection.runtime,
    source:
      input.detection.framework === null &&
      input.detection.language === null &&
      input.detection.runtime === null
        ? 'unknown'
        : 'detected',
  };
  if (stack.source === 'unknown') {
    notes.push(
      'No manifest or entry point identified the stack, so framework and language are unknown.',
    );
  }
  if (input.workspace === null) {
    notes.push('This project has no workspace, so its files and scans are unavailable.');
  }

  const matchedLinks = input.graph.links.filter((link) => link.kind === 'frontend-request').length;
  if (input.graph.requests > 0 && matchedLinks === 0) {
    notes.push('Frontend requests were found but none of them matched a backend route.');
  }

  return {
    project: input.project,
    workspace: input.workspace,
    stack,
    counts: {
      files: input.grouping.totals.files,
      bytes: input.grouping.totals.bytes,
      frontendFiles: groupCount(input.grouping, 'frontend'),
      backendFiles: groupCount(input.grouping, 'backend'),
      configurationFiles: groupCount(input.grouping, 'configuration'),
      testFiles: groupCount(input.grouping, 'tests'),
      apiRoutes: input.backend.routes.length,
      models: input.backend.models.length,
      requestSites: input.graph.requests,
      matchedLinks,
    },
    health: input.health,
    recentChanges: input.recentChanges.slice(0, 12),
    lastUpdated: input.project.updatedAt,
    notes,
  };
}
