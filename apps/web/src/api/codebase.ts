/**
 * Codebase intelligence API surface + safe UI models (Step 16).
 *
 * Raw backend responses are mapped into typed views before reaching the
 * UI: unknown or malformed data becomes a typed error, and the browser
 * never renders anything beyond the safe metadata the API already
 * guarantees. Source CONTENT is never part of this surface - the
 * workspace file routes remain the only content pathway.
 */
import { apiRequest } from './client';

const enc = encodeURIComponent;

export type CodebaseIndexStatus = 'current' | 'stale' | 'failed' | 'building';
export type CodebaseParseStatus = 'parsed' | 'failed' | 'unsupported';

export interface CodebaseFileView {
  readonly path: string;
  readonly language: string | null;
  readonly size: number;
  readonly parseStatus: CodebaseParseStatus;
  readonly parseNote: string | null;
  readonly flaggedSecrets: boolean;
}

export interface CodebaseFrameworkView {
  readonly id: string;
  readonly name: string;
  readonly confidence: string;
  readonly evidence: readonly string[];
}

/** Safe UI model for a stored codebase index (bounded file list included). */
export interface CodebaseIndexView {
  readonly indexId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: CodebaseIndexStatus;
  readonly buildState: string;
  readonly languages: readonly string[];
  readonly frameworks: readonly CodebaseFrameworkView[];
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationshipCount: number;
  readonly dependencyCount: number;
  readonly routeCount: number;
  readonly componentCount: number;
  readonly entryPointCount: number;
  readonly failedFileCount: number;
  readonly unsupportedFileCount: number;
  readonly flaggedSecretFileCount: number;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly files: readonly CodebaseFileView[];
}

export interface CodebaseSearchResultView {
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly filePath: string | null;
  readonly range: { readonly startLine: number } | null;
}

export interface CodebaseTraceNodeView {
  readonly label: string;
  readonly kind: string;
  readonly filePath: string | null;
  readonly reason: string;
}

export interface CodebaseTraceView {
  readonly feature: string;
  readonly nodes: readonly CodebaseTraceNodeView[];
  readonly edges: readonly { readonly label: string }[];
  readonly notes: readonly string[];
  readonly truncated: boolean;
}

export interface CodebaseSummaryView {
  readonly languages: readonly string[];
  readonly frameworks: readonly CodebaseFrameworkView[];
  readonly entryPoints: readonly { readonly filePath: string }[];
  readonly routes: readonly { readonly method: string; readonly path: string }[];
  readonly testFilePaths: readonly string[];
  readonly architectureHints: readonly string[];
  readonly flaggedSecretFileCount: number;
}

function unknownContext(operation: string): string {
  return `Unexpected response from the codebase service during ${operation}.`;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toIndex(raw: unknown): CodebaseIndexView {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(unknownContext('index load'));
  }
  const record = raw as Record<string, unknown>;
  const files = Array.isArray(record.files) ? record.files : [];
  return {
    indexId: toStringValue(record.indexId),
    workspaceId: toStringValue(record.workspaceId),
    revision: typeof record.revision === 'number' ? record.revision : 0,
    status: (['current', 'stale', 'failed', 'building'] as const).includes(
      record.status as CodebaseIndexStatus,
    )
      ? (record.status as CodebaseIndexStatus)
      : 'failed',
    buildState: toStringValue(record.buildState),
    languages: Array.isArray(record.languages) ? (record.languages as string[]).map(String) : [],
    frameworks: Array.isArray(record.frameworks)
      ? (record.frameworks as Record<string, unknown>[]).map((framework) => ({
          id: toStringValue(framework?.id),
          name: toStringValue(framework?.name),
          confidence: toStringValue(framework?.confidence),
          evidence: Array.isArray(framework?.evidence)
            ? (framework.evidence as unknown[]).map(String)
            : [],
        }))
      : [],
    fileCount: typeof record.fileCount === 'number' ? record.fileCount : 0,
    symbolCount: typeof record.symbolCount === 'number' ? record.symbolCount : 0,
    relationshipCount: typeof record.relationshipCount === 'number' ? record.relationshipCount : 0,
    dependencyCount: typeof record.dependencyCount === 'number' ? record.dependencyCount : 0,
    routeCount: typeof record.routeCount === 'number' ? record.routeCount : 0,
    componentCount: typeof record.componentCount === 'number' ? record.componentCount : 0,
    entryPointCount: typeof record.entryPointCount === 'number' ? record.entryPointCount : 0,
    failedFileCount: typeof record.failedFileCount === 'number' ? record.failedFileCount : 0,
    unsupportedFileCount:
      typeof record.unsupportedFileCount === 'number' ? record.unsupportedFileCount : 0,
    flaggedSecretFileCount:
      typeof record.flaggedSecretFileCount === 'number' ? record.flaggedSecretFileCount : 0,
    failure:
      typeof record.failure === 'object' && record.failure !== null
        ? {
            code: toStringValue((record.failure as Record<string, unknown>).code),
            message: toStringValue((record.failure as Record<string, unknown>).message),
          }
        : null,
    files: files.slice(0, 200).map((file) => {
      const fileRecord = file as Record<string, unknown>;
      return {
        path: toStringValue(fileRecord.path),
        language: typeof fileRecord.language === 'string' ? fileRecord.language : null,
        size: typeof fileRecord.size === 'number' ? fileRecord.size : 0,
        parseStatus: (['parsed', 'failed', 'unsupported'] as const).includes(
          fileRecord.parseStatus as CodebaseParseStatus,
        )
          ? (fileRecord.parseStatus as CodebaseParseStatus)
          : 'unsupported',
        parseNote: typeof fileRecord.parseNote === 'string' ? fileRecord.parseNote : null,
        flaggedSecrets: fileRecord.flaggedSecrets === true,
      };
    }),
  };
}

function toSearchResults(raw: unknown): readonly CodebaseSearchResultView[] {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { results?: unknown }).results)
  ) {
    throw new Error(unknownContext('search'));
  }
  return ((raw as { results: unknown[] }).results as Record<string, unknown>[]).map((result) => ({
    title: toStringValue(result.title),
    detail: toStringValue(result.detail),
    evidence: Array.isArray(result.evidence)
      ? (
          (result.evidence as Record<string, unknown>[]).map((item) =>
            toStringValue(item?.reason ?? ''),
          ) as readonly string[]
        ).filter((reason) => reason !== '')
      : [],
    filePath: typeof result.filePath === 'string' ? result.filePath : null,
    range:
      typeof result.range === 'object' && result.range !== null
        ? { startLine: (result.range as Record<string, unknown>).startLine as number }
        : null,
  }));
}

function toTrace(raw: unknown): CodebaseTraceView {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(unknownContext('trace'));
  }
  const record = raw as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const notes = Array.isArray(record.notes) ? record.notes : [];
  const edges = Array.isArray(record.edges) ? record.edges : [];
  return {
    feature: toStringValue(record.feature),
    nodes: (nodes as Record<string, unknown>[]).map((node) => ({
      label: toStringValue(node.label),
      kind: toStringValue(node.kind),
      filePath: typeof node.filePath === 'string' ? node.filePath : null,
      reason: toStringValue(node.reason),
    })),
    edges: (edges as Record<string, unknown>[]).map((edge) => ({
      label: toStringValue(edge.label),
    })),
    notes: notes.map(String),
    truncated: record.truncated === true,
  };
}

export async function getIndex(
  projectId: string,
  workspaceId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<CodebaseIndexView> {
  const raw = await apiRequest<{ index?: unknown }>(
    `/api/projects/${enc(projectId)}/codebase/index?workspaceId=${enc(workspaceId)}`,
    { fetchImpl: options.fetchImpl },
  );
  if (typeof raw !== 'object' || raw === null || (raw as { index?: unknown }).index === undefined) {
    throw new Error(unknownContext('index load'));
  }
  return toIndex((raw as { index: unknown }).index);
}

export async function buildIndex(
  projectId: string,
  workspaceId: string,
  options: {
    readonly incremental?: boolean;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<{ index: CodebaseIndexView; incremental: boolean; changedFiles: number }> {
  const raw = await apiRequest<{ index?: unknown; incremental?: boolean; changedFiles?: number }>(
    `/api/projects/${enc(projectId)}/codebase/index`,
    {
      method: 'POST',
      body: {
        workspaceId,
        ...(options.incremental !== undefined ? { incremental: options.incremental } : {}),
      },
      fetchImpl: options.fetchImpl,
    },
  );
  if (raw.index === undefined) {
    throw new Error(unknownContext('index build'));
  }
  return {
    index: toIndex(raw.index),
    incremental: raw.incremental === true,
    changedFiles: typeof raw.changedFiles === 'number' ? raw.changedFiles : 0,
  };
}

export async function searchCodebase(
  projectId: string,
  workspaceId: string,
  query: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<readonly CodebaseSearchResultView[]> {
  const raw = await apiRequest<{ results?: unknown }>(
    `/api/projects/${enc(projectId)}/codebase/search`,
    {
      method: 'POST',
      body: { workspaceId, query, searchType: 'symbol' },
      fetchImpl: options.fetchImpl,
    },
  );
  return toSearchResults(raw);
}

export async function traceFeature(
  projectId: string,
  workspaceId: string,
  feature: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<CodebaseTraceView> {
  const raw = await apiRequest<{ trace?: unknown }>(
    `/api/projects/${enc(projectId)}/codebase/trace`,
    {
      method: 'POST',
      body: { workspaceId, feature },
      fetchImpl: options.fetchImpl,
    },
  );
  if (typeof raw !== 'object' || raw === null || (raw as { trace?: unknown }).trace === undefined) {
    throw new Error(unknownContext('trace'));
  }
  return toTrace((raw as { trace: unknown }).trace);
}

export async function getSummary(
  projectId: string,
  workspaceId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<CodebaseSummaryView> {
  const raw = await apiRequest<{ summary?: unknown }>(
    `/api/projects/${enc(projectId)}/codebase/summary?workspaceId=${enc(workspaceId)}`,
    { fetchImpl: options.fetchImpl },
  );
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(unknownContext('summary'));
  }
  const record = (raw as { summary?: unknown }).summary as Record<string, unknown> | undefined;
  if (record === undefined) {
    throw new Error(unknownContext('summary'));
  }
  return {
    languages: Array.isArray(record.languages) ? (record.languages as string[]).map(String) : [],
    frameworks: Array.isArray(record.frameworks)
      ? (record.frameworks as Record<string, unknown>[]).map((framework) => ({
          id: toStringValue(framework?.id),
          name: toStringValue(framework?.name),
          confidence: toStringValue(framework?.confidence),
          evidence: Array.isArray(framework?.evidence)
            ? (framework.evidence as unknown[]).map(String)
            : [],
        }))
      : [],
    entryPoints: Array.isArray(record.entryPoints)
      ? (record.entryPoints as Record<string, unknown>[]).map((entry) => ({
          filePath: toStringValue(entry?.filePath),
        }))
      : [],
    routes: Array.isArray(record.routes)
      ? (record.routes as Record<string, unknown>[]).map((route) => ({
          method: toStringValue(route?.method),
          path: toStringValue(route?.path),
        }))
      : [],
    testFilePaths: Array.isArray(record.testFilePaths)
      ? (record.testFilePaths as string[]).map(String)
      : [],
    architectureHints: Array.isArray(record.architectureHints)
      ? (record.architectureHints as string[]).map(String)
      : [],
    flaggedSecretFileCount:
      typeof record.flaggedSecretFileCount === 'number' ? record.flaggedSecretFileCount : 0,
  };
}

export async function extractMemoryCandidates(
  projectId: string,
  workspaceId: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const raw = await apiRequest<{ candidates?: unknown }>(
    `/api/projects/${enc(projectId)}/codebase/memory-candidates`,
    { method: 'POST', body: { workspaceId }, fetchImpl: options.fetchImpl },
  );
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { candidates?: unknown }).candidates !== 'number'
  ) {
    throw new Error(unknownContext('memory extraction'));
  }
  return (raw as { candidates: number }).candidates;
}
