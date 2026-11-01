/**
 * Backend analysis vocabulary (Step 33).
 *
 * Everything here describes what was READ from a project's own files, never
 * what we assume a backend looks like. Every claim carries its evidence, and a
 * value we could not establish is `null` or `'unknown'` rather than a guess.
 */

/** HTTP verbs a route can declare. `ANY` means the source said "any method". */
export type BackendHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** Which parsing rule produced a route. Shown to the user as provenance. */
export type RouteSource =
  | 'express-fastify'
  | 'fastify-route-object'
  | 'next-app-router'
  | 'next-pages-api'
  | 'python-decorator'
  | 'django-urlconf';

/**
 * Whether the route's own file shows authentication wiring. Never `public`:
 * the absence of a guard in the file is not proof a route is open.
 */
export type RouteAuthState = 'declared' | 'unknown';

export interface BackendRoute {
  readonly method: BackendHttpMethod;
  readonly path: string;
  readonly file: string;
  /** 1-based line of the declaration in the file that was read. */
  readonly line: number;
  readonly handler: string | null;
  readonly auth: RouteAuthState;
  readonly source: RouteSource;
  /** The declaration as written, trimmed and length-capped. */
  readonly evidence: string;
}

export interface BackendModelField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  /** Referenced model or table when a relation is declared. */
  readonly references: string | null;
}

export type ModelSource = 'prisma' | 'sql';

export interface BackendModelRelationship {
  readonly field: string;
  readonly target: string;
  /** `list` when the field holds many rows, `single` otherwise. */
  readonly cardinality: 'single' | 'list';
  readonly derivedFrom: 'prisma-relation' | 'sql-foreign-key';
}

export interface BackendModel {
  readonly name: string;
  readonly source: ModelSource;
  readonly file: string;
  readonly line: number;
  readonly fields: readonly BackendModelField[];
  readonly indexes: readonly string[];
  readonly relationships: readonly BackendModelRelationship[];
}

export type BackendFunctionKind = 'serverless-function' | 'request-handler';

export interface BackendFunction {
  readonly name: string;
  readonly file: string;
  readonly kind: BackendFunctionKind;
  /** Runtime only when a manifest declared one; never assumed. */
  readonly runtime: string | null;
  readonly inputSchema: 'not-declared' | 'declared';
  readonly outputSchema: 'not-declared' | 'declared';
  readonly evidence: string;
}

export interface BackendEnvironmentVariable {
  readonly name: string;
  /** Files that reference the name, relative to the workspace root. */
  readonly sources: readonly string[];
  /** `code` when read at runtime, `template` when seen in an example file. */
  readonly kind: 'code' | 'template';
}

export type BackendSectionName =
  | 'routes'
  | 'services'
  | 'models'
  | 'middleware'
  | 'config'
  | 'functions'
  | 'database'
  | 'utilities';

export interface BackendStructureSection {
  readonly section: BackendSectionName;
  readonly label: string;
  readonly count: number;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly omitted: number;
}

export interface BackendStructure {
  readonly layout: 'node' | 'python' | 'php' | 'dotnet' | 'neutral';
  /** Framework id from stack detection, or null when it recognised nothing. */
  readonly framework: string | null;
  readonly language: string | null;
  readonly runtime: string | null;
  readonly totals: { readonly files: number; readonly bytes: number };
  readonly sections: readonly BackendStructureSection[];
}

export interface BackendAuthReport {
  /** `declared` means a library was named in a manifest, not that it works. */
  readonly status: 'declared' | 'absent';
  readonly provider: string | null;
  readonly evidence: readonly string[];
  readonly loginMethods: readonly string[];
  readonly sessionStrategy: 'not-inspected';
  readonly protectedRoutes: number;
  readonly userModel: string | null;
  readonly note: string;
}

export interface BackendDatabaseReport {
  readonly status: 'declared' | 'absent';
  readonly provider: string | null;
  /** Always `not-configured`: no adapter is wired in this release. */
  readonly connection: 'not-configured';
  readonly evidence: readonly string[];
  readonly models: number;
  readonly note: string;
}

export interface BackendLogEntry {
  readonly at: string;
  readonly severity: 'debug' | 'info' | 'warn' | 'error' | 'unknown';
  readonly service: string;
  readonly message: string;
  readonly source: string;
}

export interface BackendLogsReport {
  readonly available: false;
  readonly reason: string;
  readonly entries: readonly BackendLogEntry[];
  readonly redaction: 'applied-when-available';
}

export interface BackendRecentChange {
  readonly path: string;
  readonly changeKind: string;
  readonly at: string;
}

export interface BackendManifest {
  readonly file: string;
  /** Dependency names only - versions are not surfaced as configuration. */
  readonly dependencies: readonly string[];
}

export interface BackendReport {
  readonly structure: BackendStructure;
  readonly routes: readonly BackendRoute[];
  readonly models: readonly BackendModel[];
  readonly functions: readonly BackendFunction[];
  readonly environment: readonly BackendEnvironmentVariable[];
  readonly auth: BackendAuthReport;
  readonly database: BackendDatabaseReport;
  readonly logs: BackendLogsReport;
  readonly manifests: readonly BackendManifest[];
  readonly recentChanges: readonly BackendRecentChange[];
  readonly scanned: {
    readonly files: number;
    readonly read: number;
    readonly skipped: number;
    readonly truncated: boolean;
  };
  /** Plain-language caveats the UI shows next to the data. */
  readonly warnings: readonly string[];
}
