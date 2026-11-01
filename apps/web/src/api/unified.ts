import { apiRequest } from './client';

/**
 * Unified application workspace client (Step 34).
 *
 * One project is one application. This module mirrors the server's vocabulary
 * exactly, so the workspace can only display a status the server actually
 * reports. Every endpoint behind it is read-only except the path grouper, which
 * classifies paths and changes nothing.
 */

export type UnifiedStatus =
  'configured' | 'detected' | 'tested' | 'running' | 'unavailable' | 'not-configured';

export interface StatusFact {
  readonly status: UnifiedStatus;
  readonly label: string;
  readonly detail: string;
  readonly evidence: readonly string[];
}

export type FileGroup =
  'frontend' | 'backend' | 'shared' | 'configuration' | 'tests' | 'assets' | 'other';

export interface GroupedFile {
  readonly path: string;
  readonly size: number;
  readonly group: FileGroup;
}

export interface FileGroupSummary {
  readonly group: FileGroup;
  readonly label: string;
  readonly count: number;
  readonly files: readonly GroupedFile[];
  readonly omitted: number;
}

export interface FileGrouping {
  readonly groups: readonly FileGroupSummary[];
  readonly totals: { readonly files: number; readonly bytes: number };
}

export type LinkKind = 'frontend-request' | 'route-handler' | 'handler-model' | 'route-auth';

export interface LinkEndpoint {
  readonly label: string;
  readonly file: string;
  readonly line: number | null;
}

export interface CrossLayerLink {
  readonly kind: LinkKind;
  readonly from: LinkEndpoint;
  readonly to: LinkEndpoint;
  readonly method: string | null;
  readonly path: string | null;
  readonly confidence: 'exact' | 'parameterised';
  readonly evidence: string;
}

export interface UnmatchedRequest {
  readonly file: string;
  readonly line: number;
  readonly method: string | null;
  readonly url: string;
  readonly reason: 'no-matching-route' | 'method-mismatch' | 'external-host' | 'dynamic-url';
}

export interface CrossLayerGraph {
  readonly links: readonly CrossLayerLink[];
  readonly requests: number;
  readonly unmatchedRequests: readonly UnmatchedRequest[];
  readonly routesWithoutCaller: readonly { readonly method: string; readonly path: string }[];
  readonly note: string;
}

export interface AppHealth {
  readonly frontend: StatusFact;
  readonly backend: StatusFact;
  readonly apiRoutes: StatusFact;
  readonly database: StatusFact;
  readonly tests: StatusFact;
  readonly runtime: StatusFact;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly inspectedCompletely: boolean;
}

export interface OverviewCounts {
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
}

export interface UnifiedOverview {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly projectType: string;
    readonly status: string;
    readonly updatedAt: string | null;
  };
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly branch: string;
    readonly revision: number;
  } | null;
  readonly stack: {
    readonly framework: string | null;
    readonly language: string | null;
    readonly runtime: string | null;
    readonly source: 'detected' | 'unknown';
  };
  readonly counts: OverviewCounts;
  readonly recentChanges: readonly {
    readonly path: string;
    readonly action: string;
    readonly at: string;
  }[];
  readonly lastUpdated: string | null;
  readonly notes: readonly string[];
}

export interface UnifiedAppView {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly projectType: string;
    readonly status: string;
    readonly updatedAt: string;
  };
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly branch: string;
    readonly revision: number;
  } | null;
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

export interface UnifiedCapabilities {
  readonly readOnly: boolean;
  readonly sections: Readonly<Record<string, string>>;
  readonly composition: {
    readonly sourceOfTruth: string;
    readonly duplicateStores: boolean;
    readonly secondAiSystem: boolean;
    readonly scans: string;
  };
  readonly unavailable: readonly string[];
  readonly writes: string;
}

/** Everything the workspace needs for its first paint. */
export async function fetchUnifiedApp(projectId: string): Promise<UnifiedAppView> {
  return apiRequest<UnifiedAppView>(`/api/projects/${encodeURIComponent(projectId)}/app`);
}

export async function fetchUnifiedCapabilities(): Promise<UnifiedCapabilities> {
  return apiRequest<UnifiedCapabilities>('/api/app-builder/unified');
}

/** Classifies the paths a plan would touch. Nothing is written or approved. */
export async function groupPaths(
  projectId: string,
  paths: readonly string[],
): Promise<Readonly<Record<string, FileGroup>>> {
  const response = await apiRequest<{ groups: Record<string, FileGroup> }>(
    `/api/projects/${encodeURIComponent(projectId)}/app/group`,
    { method: 'POST', body: { paths } },
  );
  return response.groups;
}
