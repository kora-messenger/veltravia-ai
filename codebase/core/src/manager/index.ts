/**
 * CodebaseIntelligenceManager (Phases 4, 25, 26, 27).
 *
 * The single orchestration point for index builds, stale detection,
 * incremental updates, and all analysis queries. Architecture:
 *
 *   Project Engine (via CodebaseSourceProvider) -> Codebase Intelligence
 *   -> Indexes / Relationships / Search -> Agent (evidence-backed reasoning)
 *
 * It is an ANALYSIS layer ONLY: it never mutates project files, never
 * executes code, and never reads anything outside the workspace it was
 * asked to index through the provider port. Source content is UNTRUSTED
 * project data - symbol names and evidence are scrubbed, and secret-shaped
 * values are flagged, never stored.
 */

import { createHash } from 'node:crypto';

import { CodebaseError } from '../errors/index.js';
import { detectLanguage, isParsedLanguage } from '../languages/index.js';
import { parseJsonFile, parseSourceFile, type ParsedFile } from '../parse/index.js';
import { buildRelationships } from '../relationships/index.js';
import { detectFrameworks, type PackageJsonFacts } from '../frameworks/index.js';
import { detectEntryPoints } from '../entrypoints/index.js';
import { detectComponentsFromSymbols } from '../components/index.js';
import { sourceContainsSecrets } from '../secrets/index.js';
import { canTransition } from '../index-state/index.js';
import { searchCodebase } from '../search/index.js';
import { traceFeature } from '../trace/index.js';
import { buildCodebaseSummary } from '../summary/index.js';
import type { CodebaseIndexRepository } from '../repositories/index.js';
import {
  DEFAULT_CODEBASE_LIMITS,
  type CodebaseIndexBuildState,
  type CodeSearchQuery,
  type CodeSearchResult,
  type CodebaseIndex,
  type CodebaseLimits,
  type CodebaseSourceProvider,
  type CodebaseSummary,
  type FeatureTraceQuery,
  type FeatureTraceResult,
  type FileIndexEntry,
  type IndexedSymbol,
  type SourcePath,
} from '../types/index.js';

export interface CodebaseIntelligenceManagerOptions {
  readonly provider: CodebaseSourceProvider;
  readonly repository: CodebaseIndexRepository;
  readonly now?: () => Date;
  /** Hard resource limits; defaults to DEFAULT_CODEBASE_LIMITS. */
  readonly limits?: Partial<CodebaseLimits>;
}

export interface BuildIndexOptions {
  /** Reuse cached parse products for unchanged files (default: true). */
  readonly incremental?: boolean;
}

export interface BuildIndexResult {
  readonly index: CodebaseIndex;
  /** True when cached parses were reused for unchanged files. */
  readonly incremental: boolean;
  readonly changedFiles: number;
}

interface InFlightBuild {
  cancelled: boolean;
  state: CodebaseIndexBuildState;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function limitToQuery(maxResults: number | undefined, limits: CodebaseLimits): number {
  return Math.max(1, Math.min(maxResults ?? limits.maxSearchResults, limits.maxSearchResults));
}

export class CodebaseIntelligenceManager {
  private readonly provider: CodebaseSourceProvider;
  private readonly repository: CodebaseIndexRepository;
  private readonly now: () => Date;
  private readonly limits: CodebaseLimits;
  /** In-process parse cache: workspace key -> path -> parsed product + hash. */
  private readonly parseCache = new Map<
    string,
    Map<string, { hash: string; parsed: ParsedFile }>
  >();
  private readonly inFlight = new Map<string, InFlightBuild>();

  constructor(options: CodebaseIntelligenceManagerOptions) {
    this.provider = options.provider;
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.limits = { ...DEFAULT_CODEBASE_LIMITS, ...options.limits };
  }

  private key(projectId: string, workspaceId: string): string {
    return `${projectId}:${workspaceId}`;
  }

  private async requireIndex(projectId: string, workspaceId: string): Promise<CodebaseIndex> {
    const stored = await this.repository.get(projectId, workspaceId);
    if (stored === null) {
      throw new CodebaseError('CODEBASE_INDEX_NOT_FOUND', 'no codebase index for this workspace', {
        projectId,
        workspaceId,
      });
    }
    return this.refreshStatus(stored);
  }

  /** Lazily refreshes stale status by comparing the current workspace revision. */
  private async refreshStatus(index: CodebaseIndex): Promise<CodebaseIndex> {
    if (index.buildState !== 'completed') {
      return index;
    }
    const currentRevision = await this.provider
      .workspaceRevision(index.workspaceId)
      .catch(() => null);
    if (currentRevision === null || currentRevision === index.revision) {
      return index;
    }
    const staleIndex: CodebaseIndex = {
      ...index,
      status: 'stale',
      updatedAt: this.now().toISOString(),
    };
    await this.repository.markStale(index.projectId, index.workspaceId);
    return staleIndex;
  }

  // ---- index build ---------------------------------------------------------

  async buildIndex(
    projectId: string,
    workspaceId: string,
    options: BuildIndexOptions = {},
  ): Promise<BuildIndexResult> {
    const key = this.key(projectId, workspaceId);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      throw new CodebaseError(
        'CODEBASE_INDEX_BUILD_IN_PROGRESS',
        'an index build is already running for this workspace',
        { projectId, workspaceId },
      );
    }
    const build: InFlightBuild = { cancelled: false, state: 'created' };
    this.inFlight.set(key, build);
    try {
      return await this.runBuild(projectId, workspaceId, build, options.incremental ?? true);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Requests cancellation of an in-flight build (one-way). */
  async cancelBuild(projectId: string, workspaceId: string): Promise<boolean> {
    const build = this.inFlight.get(this.key(projectId, workspaceId));
    if (build === undefined) {
      return false;
    }
    build.cancelled = true;
    return true;
  }

  private setState(build: InFlightBuild, state: CodebaseIndexBuildState): void {
    if (!canTransition(build.state, state)) {
      throw new Error(`invalid index build transition: ${build.state} -> ${state}`);
    }
    build.state = state;
  }

  private async runBuild(
    projectId: string,
    workspaceId: string,
    build: InFlightBuild,
    incremental: boolean,
  ): Promise<BuildIndexResult> {
    const key = this.key(projectId, workspaceId);
    const startedAt = Date.now();
    const createdAt = this.now().toISOString();

    this.setState(build, 'scanning');
    const files = (await this.provider.listFiles(workspaceId))
      .filter((file) => file.type === 'file')
      .slice(0, this.limits.maxIndexedFiles);
    const workspaceRevision = await this.provider.workspaceRevision(workspaceId);

    this.setState(build, 'parsing');
    const cache = incremental
      ? (this.parseCache.get(key) ?? new Map())
      : new Map<string, { hash: string; parsed: ParsedFile }>();
    if (!incremental) {
      cache.clear();
    }

    const fileEntries: FileIndexEntry[] = [];
    const parsedFiles: ParsedFile[] = [];
    const externalImports = new Set<string>();
    let packageJsonFacts: PackageJsonFacts | undefined;
    let changedFiles = 0;

    for (const file of files) {
      if (build.cancelled) {
        await this.persistFailureShell(
          projectId,
          workspaceId,
          'cancelled',
          build.state,
          createdAt,
          undefined,
        );
        throw new CodebaseError('CODEBASE_CANCELLED', 'index build was cancelled', {
          state: build.state,
        });
      }
      if (Date.now() - startedAt > this.limits.maxIndexDurationMs) {
        await this.persistFailureShell(projectId, workspaceId, 'failed', build.state, createdAt, {
          code: 'CODEBASE_LIMIT_EXCEEDED',
          message: `index build exceeded the ${this.limits.maxIndexDurationMs}ms time budget`,
        });
        throw new CodebaseError(
          'CODEBASE_LIMIT_EXCEEDED',
          'index build exceeded its time budget',
          {},
        );
      }

      const language = detectLanguage(file.path);
      const tooLarge = file.size > this.limits.maxSourceBytesPerFile;
      let parsed: ParsedFile | undefined;
      let hash = '';
      let flaggedSecrets = false;

      if (language !== null && !tooLarge) {
        let content: string;
        try {
          content = await this.provider.readFileContent(workspaceId, file.path);
        } catch {
          fileEntries.push(
            this.fileEntry(
              file.path,
              language,
              file.size,
              file.revision,
              '',
              'failed',
              'source read failed',
              false,
              createdAt,
            ),
          );
          continue;
        }
        hash = hashContent(content);
        const cached = cache.get(file.path);
        if (cached !== undefined && cached.hash === hash) {
          parsed = cached.parsed;
        } else if (isParsedLanguage(language)) {
          parsed = parseSourceFile({ path: file.path, content });
          cache.set(file.path, { hash, parsed });
          changedFiles += 1;
        } else if (language === 'json') {
          parsed = parseJsonFile(file.path, content);
          cache.set(file.path, { hash, parsed });
          changedFiles += 1;
        } else {
          // Supported language WITHOUT a parser registered (css, html):
          // honest explicit state, never a pretend parse.
          parsed = undefined;
        }
        flaggedSecrets =
          isParsedLanguage(language) || language === 'json'
            ? sourceContainsSecrets(content)
            : false;

        if (
          language === 'json' &&
          (file.path === 'package.json' || file.path.endsWith('/package.json'))
        ) {
          try {
            const manifest = JSON.parse(content) as Record<string, unknown>;
            packageJsonFacts = {
              dependencies: (manifest.dependencies ?? {}) as Record<string, string>,
              devDependencies: (manifest.devDependencies ?? {}) as Record<string, string>,
            };
          } catch {
            // malformed manifest: framework detection simply lacks this signal
          }
        }
      }

      if (tooLarge) {
        fileEntries.push(
          this.fileEntry(
            file.path,
            language,
            file.size,
            file.revision,
            hash,
            'skipped',
            `file exceeds the ${this.limits.maxSourceBytesPerFile}-byte per-file limit`,
            false,
            createdAt,
          ),
        );
        continue;
      }
      if (language === null) {
        fileEntries.push(
          this.fileEntry(
            file.path,
            null,
            file.size,
            file.revision,
            '',
            'unsupported',
            'no parser registered for this file type',
            false,
            createdAt,
          ),
        );
        continue;
      }
      if (parsed === undefined) {
        fileEntries.push(
          this.fileEntry(
            file.path,
            language,
            file.size,
            file.revision,
            hash,
            'unsupported',
            'no parser registered for this language',
            false,
            createdAt,
          ),
        );
        continue;
      }
      parsedFiles.push(parsed);
      fileEntries.push(
        this.fileEntry(
          file.path,
          language,
          file.size,
          file.revision,
          hash,
          parsed.parseStatus,
          parsed.parseNote,
          flaggedSecrets,
          createdAt,
        ),
      );
    }

    this.parseCache.set(key, cache);

    this.setState(build, 'resolving');
    const symbols = parsedFiles
      .flatMap((file) => [...file.symbols])
      .slice(0, this.limits.maxSymbolsTotal);

    this.setState(build, 'building_relationships');
    const relationshipBuild = buildRelationships({
      parsedFiles,
      limits: { maxRelationshipsTotal: this.limits.maxRelationshipsTotal },
    });
    for (const edge of relationshipBuild.dependencies) {
      if (edge.external && edge.package !== null) {
        externalImports.add(edge.specifier);
      }
    }

    const frameworks = detectFrameworks({
      paths: fileEntries.map((entry) => entry.path),
      ...(packageJsonFacts !== undefined ? { packageJsonFacts } : {}),
      externalImports,
    });
    const entryPoints = detectEntryPoints(fileEntries.map((entry) => entry.path));
    const components = detectComponentsFromSymbols(symbols);

    this.setState(build, 'completed');
    const index: CodebaseIndex = {
      indexId: createHash('sha256')
        .update(`${projectId}|${workspaceId}|${workspaceRevision}|${this.now().toISOString()}`)
        .digest('hex')
        .slice(0, 16),
      projectId,
      workspaceId,
      revision: workspaceRevision,
      status: 'current',
      buildState: 'completed',
      languages: [
        ...new Set(
          fileEntries
            .filter((entry) => entry.language !== null)
            .map((entry) => entry.language as NonNullable<FileIndexEntry['language']>),
        ),
      ].sort(),
      frameworks,
      files: fileEntries,
      symbols,
      relationships: relationshipBuild.relationships,
      routes: parsedFiles.flatMap((file) => [...file.routes]),
      entryPoints,
      components,
      dependencies: relationshipBuild.dependencies,
      fileCount: fileEntries.length,
      symbolCount: symbols.length,
      relationshipCount: relationshipBuild.relationships.length,
      dependencyCount: relationshipBuild.dependencies.length,
      createdAt,
      updatedAt: this.now().toISOString(),
    };
    await this.repository.save(index);
    return { index, incremental: incremental && changedFiles < fileEntries.length, changedFiles };
  }

  /**
   * Persists a failed/cancelled build shell ONLY when no completed index
   * exists yet - a failed rebuild never destroys a previous good index.
   */
  private async persistFailureShell(
    projectId: string,
    workspaceId: string,
    outcome: 'failed' | 'cancelled',
    state: CodebaseIndexBuildState,
    createdAt: string,
    failure: { code: string; message: string } | undefined,
  ): Promise<void> {
    const existing = await this.repository.get(projectId, workspaceId);
    if (existing !== null && existing.buildState === 'completed') {
      return;
    }
    const revision = await this.provider.workspaceRevision(workspaceId).catch(() => 0);
    const shell: CodebaseIndex = {
      indexId: '',
      projectId,
      workspaceId,
      revision,
      status: outcome === 'failed' ? 'failed' : 'failed',
      buildState: outcome,
      languages: [],
      frameworks: [],
      files: [],
      symbols: [],
      relationships: [],
      routes: [],
      entryPoints: [],
      components: [],
      dependencies: [],
      fileCount: 0,
      symbolCount: 0,
      relationshipCount: 0,
      dependencyCount: 0,
      ...(failure !== undefined ? { failure } : {}),
      createdAt,
      updatedAt: this.now().toISOString(),
    };
    await this.repository.save(shell);
  }

  private fileEntry(
    path: SourcePath,
    language: FileIndexEntry['language'],
    size: number,
    revision: number,
    hash: string,
    parseStatus: FileIndexEntry['parseStatus'],
    parseNote: string | undefined,
    flaggedSecrets: boolean,
    indexedAt: string,
  ): FileIndexEntry {
    return {
      path,
      language,
      size,
      revision,
      hash,
      parseStatus,
      ...(parseNote !== undefined ? { parseNote } : {}),
      flaggedSecrets,
      indexedAt,
    };
  }

  // ---- queries -------------------------------------------------------------

  async getIndex(projectId: string, workspaceId: string): Promise<CodebaseIndex> {
    return this.requireIndex(projectId, workspaceId);
  }

  async search(
    projectId: string,
    workspaceId: string,
    query: Omit<CodeSearchQuery, 'maxResults'> & { maxResults?: number },
  ): Promise<CodeSearchResult[]> {
    const index = await this.requireIndex(projectId, workspaceId);
    return searchCodebase(index, {
      ...query,
      maxResults: limitToQuery(query.maxResults, this.limits),
    });
  }

  async getSummary(projectId: string, workspaceId: string): Promise<CodebaseSummary> {
    const index = await this.requireIndex(projectId, workspaceId);
    return buildCodebaseSummary(index);
  }

  async getSymbol(
    projectId: string,
    workspaceId: string,
    symbolId: string,
  ): Promise<IndexedSymbol> {
    const index = await this.requireIndex(projectId, workspaceId);
    const symbol = index.symbols.find((candidate) => candidate.symbolId === symbolId);
    if (symbol === undefined) {
      throw new CodebaseError('CODEBASE_SYMBOL_NOT_FOUND', 'unknown symbol id', { symbolId });
    }
    return symbol;
  }

  async getFileSymbols(
    projectId: string,
    workspaceId: string,
    path: SourcePath,
  ): Promise<readonly IndexedSymbol[]> {
    const index = await this.requireIndex(projectId, workspaceId);
    return index.symbols.filter((symbol) => symbol.filePath === path);
  }

  async getFileEntry(
    projectId: string,
    workspaceId: string,
    path: SourcePath,
  ): Promise<FileIndexEntry> {
    const index = await this.requireIndex(projectId, workspaceId);
    const entry = await this.repository.getFileEntry(projectId, workspaceId, path);
    if (entry === null) {
      throw new CodebaseError('CODEBASE_FILE_NOT_FOUND', 'path is not part of the codebase index', {
        path,
      });
    }
    void index;
    return entry;
  }

  /** Relationships touching one symbol, both directions. */
  async getSymbolRelationships(
    projectId: string,
    workspaceId: string,
    symbolId: string,
  ): Promise<readonly CodebaseIndex['relationships'][number][]> {
    const index = await this.requireIndex(projectId, workspaceId);
    return index.relationships.filter(
      (relationship) =>
        relationship.fromSymbolId === symbolId || relationship.toSymbolId === symbolId,
    );
  }

  /** Callers of a symbol (who calls it), from recorded `calls` edges. */
  async findCallers(
    projectId: string,
    workspaceId: string,
    symbolId: string,
  ): Promise<readonly CodeSearchResult[]> {
    const index = await this.requireIndex(projectId, workspaceId);
    const results: CodeSearchResult[] = [];
    for (const relationship of index.relationships) {
      if (relationship.toSymbolId !== symbolId || relationship.kind !== 'calls') continue;
      const caller = index.symbols.find((symbol) => symbol.symbolId === relationship.fromSymbolId);
      results.push({
        kind: 'symbol',
        title: caller?.name ?? relationship.fromPath ?? 'unknown caller',
        filePath: caller?.filePath ?? relationship.fromPath ?? null,
        range:
          caller !== undefined
            ? {
                startLine: caller.startLine,
                startColumn: caller.startColumn,
                endLine: caller.endLine,
                endColumn: caller.endColumn,
              }
            : null,
        symbolId: relationship.fromSymbolId ?? null,
        detail: `calls the queried symbol`,
        evidence: {
          reason: `recorded ${relationship.kind} relationship`,
          evidence: [relationship.evidence],
        },
      });
    }
    return results.slice(0, this.limits.maxSearchResults);
  }

  /** Callees of a symbol (what it calls), from recorded `calls` edges. */
  async findCallees(
    projectId: string,
    workspaceId: string,
    symbolId: string,
  ): Promise<readonly CodeSearchResult[]> {
    const index = await this.requireIndex(projectId, workspaceId);
    const results: CodeSearchResult[] = [];
    for (const relationship of index.relationships) {
      if (relationship.fromSymbolId !== symbolId || relationship.kind !== 'calls') continue;
      const callee = index.symbols.find((symbol) => symbol.symbolId === relationship.toSymbolId);
      results.push({
        kind: 'symbol',
        title: callee?.name ?? 'unresolved callee',
        filePath: callee?.filePath ?? relationship.fromPath ?? null,
        range:
          callee !== undefined
            ? {
                startLine: callee.startLine,
                startColumn: callee.startColumn,
                endLine: callee.endLine,
                endColumn: callee.endColumn,
              }
            : null,
        symbolId: relationship.toSymbolId ?? null,
        detail: callee !== undefined ? callee.kind : 'target not statically resolvable',
        evidence: {
          reason: `recorded ${relationship.kind} relationship`,
          evidence: [relationship.evidence],
        },
      });
    }
    return results.slice(0, this.limits.maxSearchResults);
  }

  /** Files that import/references the given symbol. */
  async findReferences(
    projectId: string,
    workspaceId: string,
    symbolId: string,
  ): Promise<readonly CodeSearchResult[]> {
    const index = await this.requireIndex(projectId, workspaceId);
    const results: CodeSearchResult[] = [];
    for (const relationship of index.relationships) {
      if (relationship.toSymbolId !== symbolId) continue;
      if (relationship.kind !== 'references' && relationship.kind !== 'imports') continue;
      results.push({
        kind: 'file',
        title: relationship.fromPath ?? 'unknown file',
        filePath: relationship.fromPath ?? null,
        range: null,
        symbolId: null,
        detail: `references the queried symbol`,
        evidence: {
          reason: `recorded ${relationship.kind} relationship`,
          evidence: [relationship.evidence],
        },
      });
    }
    return results.slice(0, this.limits.maxSearchResults);
  }

  async traceFeature(
    projectId: string,
    workspaceId: string,
    query: FeatureTraceQuery,
  ): Promise<FeatureTraceResult> {
    const index = await this.requireIndex(projectId, workspaceId);
    return traceFeature(index, {
      ...query,
      maxDepth: Math.min(query.maxDepth ?? 3, this.limits.maxTraceDepth),
    });
  }

  async deleteIndex(projectId: string, workspaceId: string): Promise<void> {
    await this.repository.delete(projectId, workspaceId);
    this.parseCache.delete(this.key(projectId, workspaceId));
  }
}
