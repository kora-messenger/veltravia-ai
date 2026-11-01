import { apiRequest } from './client';

/**
 * Backend Builder client (Step 33).
 *
 * Everything here is READ-ONLY by construction: the endpoints expose a report,
 * never a mutation. The vocabulary mirrors the server's so a section cannot
 * display a field the server does not send, and every claim keeps the file and
 * line it was read from.
 */

export type BackendHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RouteSource =
  | 'express-fastify'
  | 'fastify-route-object'
  | 'next-app-router'
  | 'next-pages-api'
  | 'python-decorator'
  | 'django-urlconf';

export interface BackendRoute {
  readonly method: BackendHttpMethod;
  readonly path: string;
  readonly file: string;
  readonly line: number;
  readonly handler: string | null;
  readonly auth: 'declared' | 'unknown';
  readonly source: RouteSource;
  readonly evidence: string;
}

export interface BackendModelField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly references: string | null;
}

export interface BackendModelRelationship {
  readonly field: string;
  readonly target: string;
  readonly cardinality: 'single' | 'list';
  readonly derivedFrom: 'prisma-relation' | 'sql-foreign-key';
}

export interface BackendModel {
  readonly name: string;
  readonly source: 'prisma' | 'sql';
  readonly file: string;
  readonly line: number;
  readonly fields: readonly BackendModelField[];
  readonly indexes: readonly string[];
  readonly relationships: readonly BackendModelRelationship[];
}

export interface BackendFunction {
  readonly name: string;
  readonly file: string;
  readonly kind: 'serverless-function' | 'request-handler';
  readonly runtime: string | null;
  readonly inputSchema: 'not-declared' | 'declared';
  readonly outputSchema: 'not-declared' | 'declared';
  readonly evidence: string;
}

export interface BackendEnvironmentVariable {
  readonly name: string;
  readonly sources: readonly string[];
  readonly kind: 'code' | 'template';
}

export interface BackendStructureSection {
  readonly section: string;
  readonly label: string;
  readonly count: number;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly omitted: number;
}

export interface BackendStructure {
  readonly layout: 'node' | 'python' | 'php' | 'dotnet' | 'neutral';
  readonly framework: string | null;
  readonly language: string | null;
  readonly runtime: string | null;
  readonly totals: { readonly files: number; readonly bytes: number };
  readonly sections: readonly BackendStructureSection[];
}

export interface BackendAuthReport {
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
  readonly connection: 'not-configured';
  readonly evidence: readonly string[];
  readonly models: number;
  readonly note: string;
}

export interface BackendLogsReport {
  readonly available: false;
  readonly reason: string;
  readonly entries: readonly never[];
  readonly redaction: 'applied-when-available';
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
  readonly manifests: readonly {
    readonly file: string;
    readonly dependencies: readonly string[];
  }[];
  readonly recentChanges: readonly {
    readonly path: string;
    readonly changeKind: string;
    readonly at: string;
  }[];
  readonly scanned: {
    readonly files: number;
    readonly read: number;
    readonly skipped: number;
    readonly truncated: boolean;
  };
  readonly warnings: readonly string[];
}

export interface BackendCapabilities {
  readonly readOnly: boolean;
  readonly sections: Record<string, string>;
  readonly extraction: {
    readonly frameworks: readonly string[];
    readonly modelFormats: readonly string[];
    readonly environmentValues: string;
    readonly logSources: string;
  };
  readonly unavailable: readonly string[];
  readonly writes: string;
}

export type BackendSection =
  'overview' | 'routes' | 'database' | 'models' | 'functions' | 'auth' | 'environment' | 'logs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A report the client cannot interpret is an error, not a half-filled screen.
 * The shape below is the boundary: anything missing is fatal to the render and
 * surfaces as "Could not read the report", never as an empty section.
 */
function parseReport(payload: unknown): BackendReport {
  if (!isRecord(payload) || !isRecord(payload.report)) {
    throw new Error('The backend report was not in the expected shape.');
  }
  const report = payload.report;
  const required = [
    'structure',
    'routes',
    'models',
    'functions',
    'environment',
    'auth',
    'database',
    'logs',
    'manifests',
    'recentChanges',
    'scanned',
    'warnings',
  ] as const;
  for (const key of required) {
    if (!(key in report)) throw new Error(`The backend report is missing "${key}".`);
  }
  if (!Array.isArray(report.routes) || !Array.isArray(report.models)) {
    throw new Error('The backend report lists were not arrays.');
  }
  return report as unknown as BackendReport;
}

export async function fetchBackendReport(
  projectId: string,
  options: { workspaceId?: string; fetchImpl?: typeof fetch } = {},
): Promise<BackendReport> {
  const query =
    options.workspaceId === undefined
      ? ''
      : `?workspaceId=${encodeURIComponent(options.workspaceId)}`;
  const payload = await apiRequest<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/backend${query}`,
    {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    },
  );
  return parseReport(payload);
}

export async function fetchBackendCapabilities(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<BackendCapabilities> {
  const payload = await apiRequest<unknown>('/api/backend/capabilities', {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (!isRecord(payload) || !Array.isArray(payload.unavailable)) {
    throw new Error('The capability statement was not in the expected shape.');
  }
  return payload as unknown as BackendCapabilities;
}
