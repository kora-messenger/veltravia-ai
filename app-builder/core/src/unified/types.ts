/**
 * Unified application workspace vocabulary (Step 34).
 *
 * One project is one application: the same identity, the same workspace, the
 * same files. This module names what that workspace can show without ever
 * claiming more than the files say. Every status is one of a closed set, and a
 * value that could not be established stays `null` or `not-configured` rather
 * than becoming an optimistic guess.
 */

/** The sections of the unified workspace, in navigation order. */
export const UNIFIED_SECTIONS = [
  'overview',
  'build',
  'frontend',
  'backend',
  'database',
  'api-routes',
  'files',
  'ai-assistant',
  'settings',
] as const;

export type UnifiedSection = (typeof UNIFIED_SECTIONS)[number];

/**
 * The only words a status may use. `tested` is never claimed without a recorded
 * run and `running` is never claimed without a live runtime.
 */
export const UNIFIED_STATUSES = [
  'configured',
  'detected',
  'tested',
  'running',
  'unavailable',
  'not-configured',
] as const;

export type UnifiedStatus = (typeof UNIFIED_STATUSES)[number];

export interface StatusFact {
  readonly status: UnifiedStatus;
  /** Short human label, e.g. "Detected". */
  readonly label: string;
  /** One sentence saying what the status is based on. */
  readonly detail: string;
  /** Files or declarations the claim rests on. Empty when none were read. */
  readonly evidence: readonly string[];
}

/** Logical file groups. A path is placed by rule; files are never renamed. */
export const FILE_GROUPS = [
  'frontend',
  'backend',
  'shared',
  'configuration',
  'tests',
  'assets',
  'other',
] as const;

export type FileGroup = (typeof FILE_GROUPS)[number];

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
  /** Files in the group beyond the listing cap. */
  readonly omitted: number;
}

export interface FileGrouping {
  readonly groups: readonly FileGroupSummary[];
  readonly totals: { readonly files: number; readonly bytes: number };
  /** Path classification of every file, for callers that need one path only. */
  readonly byPath: Readonly<Record<string, FileGroup>>;
}

export type LinkConfidence = 'exact' | 'parameterised';

export type LinkKind = 'frontend-request' | 'route-handler' | 'handler-model' | 'route-auth';

export interface LinkEndpoint {
  readonly label: string;
  readonly file: string;
  /** 1-based line, or null when the endpoint is a project-level declaration. */
  readonly line: number | null;
}

export interface CrossLayerLink {
  readonly kind: LinkKind;
  readonly from: LinkEndpoint;
  readonly to: LinkEndpoint;
  readonly method: string | null;
  readonly path: string | null;
  readonly confidence: LinkConfidence;
  /** The declaration or call as written, trimmed and capped. */
  readonly evidence: string;
}

export type UnmatchedReason =
  'no-matching-route' | 'method-mismatch' | 'external-host' | 'dynamic-url';

export interface UnmatchedRequest {
  readonly file: string;
  readonly line: number;
  readonly method: string | null;
  readonly url: string;
  readonly reason: UnmatchedReason;
}

export interface CrossLayerGraph {
  readonly links: readonly CrossLayerLink[];
  /** Request sites read from the project, matched or not. */
  readonly requests: number;
  readonly unmatchedRequests: readonly UnmatchedRequest[];
  /** Routes nothing in the project calls. Not an error: a caller may be absent. */
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
  /** True only when every layer was inspected; false when a scan was capped. */
  readonly inspectedCompletely: boolean;
}
