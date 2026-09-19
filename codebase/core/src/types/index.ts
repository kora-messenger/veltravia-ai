/**
 * Core type model for Codebase Intelligence (Step 16).
 *
 * Everything here is SAFE INDEX DATA: paths, symbols, source ranges, and
 * evidence. The index deliberately does NOT copy whole source files, does
 * not store secret-shaped values, and does not treat source text as
 * anything other than untrusted project data. The Project Engine remains
 * the single source of truth for file contents and for all mutations -
 * Codebase Intelligence is an ANALYSIS layer, never a second engine.
 */

/** Lifecycle states of an index build. Mirrors the state machine in index-state/. */
export const CODEBASE_INDEX_BUILD_STATES = [
  'created',
  'scanning',
  'parsing',
  'resolving',
  'building_relationships',
  'completed',
  'failed',
  'cancelled',
] as const;

export type CodebaseIndexBuildState = (typeof CODEBASE_INDEX_BUILD_STATES)[number];

/** Long-term status of a STORED index (independent of a build run in flight). */
export const CODEBASE_INDEX_STATUSES = ['current', 'stale', 'building', 'failed'] as const;

export type CodebaseIndexStatus = (typeof CODEBASE_INDEX_STATUSES)[number];

/** Parse outcome for one indexed file. Never "pretend" to parse unsupported files. */
export const FILE_PARSE_STATUSES = ['parsed', 'unsupported', 'skipped', 'failed'] as const;

export type FileParseStatus = (typeof FILE_PARSE_STATUSES)[number];

/** Languages with first-class support. Anything else is `unsupported`. */
export const SOURCE_LANGUAGES = ['typescript', 'javascript', 'json', 'css', 'html'] as const;

export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];

/** Symbol kinds extractable where the parser allows. */
export const SYMBOL_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'variable',
  'constant',
  'method',
  'component',
  'enum',
  'namespace',
  'module',
  'route',
] as const;

export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** Explicit, closed set of relationship kinds. No free-form edges. */
export const RELATIONSHIP_KINDS = [
  'imports',
  'exports',
  'references',
  'calls',
  'extends',
  'implements',
  'contains',
  'defines',
  'renders',
  'routes_to',
] as const;

export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

/** A half-open source range, 1-based lines, 0-based columns (LSP convention). */
export interface SourceRange {
  /** Inclusive start line (1-based). */
  readonly startLine: number;
  readonly startColumn: number;
  /** Inclusive end line (1-based). */
  readonly endLine: number;
  readonly endColumn: number;
}

/** A workspace-relative POSIX path, already normalized by the provider. */
export type SourcePath = string;

/** One indexed file: safe metadata only - never the full content copy. */
export interface FileIndexEntry {
  /** Workspace-relative path, normalized, no leading slash. */
  readonly path: SourcePath;
  /** Detected language, or `null` when unknown/unsupported. */
  readonly language: SourceLanguage | null;
  /** Byte size of the source file. */
  readonly size: number;
  /** Project Engine node revision at index time (stale detection). */
  readonly revision: number;
  /** Best-effort content hash (hex) - identity, not content. */
  readonly hash: string;
  readonly parseStatus: FileParseStatus;
  /** Human-readable reason when `parseStatus` is `failed` or `skipped`. */
  readonly parseNote?: string;
  /** True when secret-shaped content was detected in this file (never the value). */
  readonly flaggedSecrets: boolean;
  readonly indexedAt: string;
}

/** Where a symbol lives. Ranges, not file bodies. */
export interface SymbolLocation extends SourceRange {
  readonly filePath: SourcePath;
}

/** An indexed source symbol. */
export interface IndexedSymbol {
  /** Stable id: sha-like digest of file + name + kind + range. */
  readonly symbolId: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly filePath: SourcePath;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  /** Lexical scope path, e.g. `AuthService` for one of its methods. */
  readonly scope: string;
  /** Whether the symbol is exported from its file. */
  readonly exported: boolean;
  /** Extra safe metadata (e.g. route method/path for `route` symbols). */
  readonly meta?: { readonly [key: string]: string };
}

/** A directed edge between two symbols, or a symbol and a file. */
export interface SymbolRelationship {
  readonly kind: RelationshipKind;
  readonly fromSymbolId?: string;
  readonly toSymbolId?: string;
  /** File-level edge endpoints used when a symbol is not resolvable. */
  readonly fromPath?: SourcePath;
  /** Raw module specifier for `imports` edges (e.g. "./auth-service"). */
  readonly toPath?: SourcePath;
  /** Why this relationship exists - the parser evidence, bounded text. */
  readonly evidence: string;
}

/** A statically detected HTTP route. Never executed. */
export interface DetectedRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  readonly path: string;
  readonly filePath: SourcePath;
  readonly range: SourceRange;
  /** Framework evidence, e.g. "fastify-style route registration". */
  readonly framework: string;
  /** Handler symbol name where resolvable, else null (honest). */
  readonly handlerSymbol: string | null;
}

/** A likely application entry point with explicit confidence. */
export interface DetectedEntryPoint {
  readonly filePath: SourcePath;
  readonly confidence: 'high' | 'medium' | 'low';
  /** Concrete reason(s), e.g. "declared as vite build.rollupOptions.input". */
  readonly evidence: readonly string[];
}

/** A likely UI component (React-style) detected from structure. */
export interface DetectedComponent {
  readonly symbolId: string;
  readonly name: string;
  readonly filePath: SourcePath;
  readonly range: SourceRange;
}

/** One edge of the dependency graph. */
export interface DependencyEdge {
  readonly fromPath: SourcePath;
  readonly toPath: SourcePath;
  /** Raw import specifier that produced this edge. */
  readonly specifier: string;
  readonly external: boolean;
  /** Package name for external edges, else null. */
  readonly package: string | null;
}

/** A framework/technology detection with the evidence that justifies it. */
export interface FrameworkDetection {
  readonly id: string;
  readonly name: string;
  /** Which signal produced the detection - never a bare guess. */
  readonly evidence: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
}

/** The stored codebase index - a bounded, revision-pinned analysis artifact. */
export interface CodebaseIndex {
  readonly indexId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  /** Workspace revision the index was built from. */
  readonly revision: number;
  readonly status: CodebaseIndexStatus;
  readonly buildState: CodebaseIndexBuildState;
  readonly languages: readonly SourceLanguage[];
  readonly frameworks: readonly FrameworkDetection[];
  readonly files: readonly FileIndexEntry[];
  readonly symbols: readonly IndexedSymbol[];
  readonly relationships: readonly SymbolRelationship[];
  readonly routes: readonly DetectedRoute[];
  readonly entryPoints: readonly DetectedEntryPoint[];
  readonly components: readonly DetectedComponent[];
  readonly dependencies: readonly DependencyEdge[];
  /** Counts exposed for cheap listing (the arrays above are bounded). */
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationshipCount: number;
  readonly dependencyCount: number;
  /** Structured build failure (present only when status === 'failed'). */
  readonly failure?: { readonly code: string; readonly message: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Source provider port (the ONLY way the core sees project files)
// ---------------------------------------------------------------------------

/** Provider-reported file metadata (the API maps Project Engine FileNodes onto this). */
export interface SourceFileMeta {
  readonly path: SourcePath;
  readonly size: number;
  readonly revision: number;
  readonly type: 'file' | 'directory';
}

/**
 * The single seam between Codebase Intelligence and project storage.
 *
 * Production: an adapter over the Project Engine's FileTreeManager (listAll
 * + readFile). Tests and the deterministic mock: fixture files. The core
 * NEVER touches the host filesystem and NEVER mutates anything through
 * this port - `readFileContent` is a read of already-authorized project
 * data, identical in authority to the coding agent's project.read-file
 * tool, just batched for analysis.
 */
export interface CodebaseSourceProvider {
  /** All file nodes of one workspace (metadata only, no content). */
  listFiles(workspaceId: string): Promise<readonly SourceFileMeta[]>;
  /** Content of ONE file. Throws for unknown paths/files. */
  readFileContent(workspaceId: string, path: SourcePath): Promise<string>;
  /** Current workspace revision (stale detection). */
  workspaceRevision(workspaceId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const CODE_SEARCH_TYPES = ['exact', 'symbol', 'file', 'relationship', 'structural'] as const;

export type CodeSearchType = (typeof CODE_SEARCH_TYPES)[number];

export const STRUCTURAL_QUERY_KINDS = ['routes', 'entry_points', 'components', 'exports'] as const;

export type StructuralQueryKind = (typeof STRUCTURAL_QUERY_KINDS)[number];

/** A bounded, typed search query. `projectId`/`workspaceId` are enforced by the manager. */
export interface CodeSearchQuery {
  readonly query: string;
  readonly searchType: CodeSearchType;
  readonly language?: SourceLanguage;
  readonly filePattern?: string;
  readonly symbolKind?: SymbolKind;
  readonly structuralKind?: StructuralQueryKind;
  readonly maxResults?: number;
  readonly includeRelationships?: boolean;
}

/** Why one result matched - bounded, evidence-backed, never a bare guess. */
export interface SearchResultEvidence {
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface CodeSearchResult {
  readonly kind: 'symbol' | 'file' | 'route' | 'component' | 'entry_point' | 'relationship';
  readonly title: string;
  readonly filePath: SourcePath | null;
  readonly range: SourceRange | null;
  readonly symbolId: string | null;
  readonly detail: string;
  readonly evidence: SearchResultEvidence;
  readonly relationships?: readonly SymbolRelationship[];
}

// ---------------------------------------------------------------------------
// Feature tracing
// ---------------------------------------------------------------------------

export interface FeatureTraceQuery {
  /** Natural description, e.g. "authentication". */
  readonly feature: string;
  readonly maxDepth?: number;
}

/** One node of a bounded feature map. Only index-backed relationships appear. */
export interface FeatureTraceNode {
  readonly key: string;
  readonly label: string;
  readonly kind: 'route' | 'component' | 'symbol' | 'file' | 'entry_point';
  readonly filePath: SourcePath | null;
  readonly range: SourceRange | null;
  readonly symbolId: string | null;
  readonly reason: string;
}

export interface FeatureTraceEdge {
  readonly fromKey: string;
  readonly toKey: string;
  readonly relationship: RelationshipKind | 'related';
  readonly evidence: string;
}

export interface FeatureTraceResult {
  readonly feature: string;
  readonly nodes: readonly FeatureTraceNode[];
  readonly edges: readonly FeatureTraceEdge[];
  /** Whether the traversal stopped early because of the hard ceilings. */
  readonly truncated: boolean;
  /** Explicit note when support is limited - the system never overclaims. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** A summary DERIVED from indexed evidence - the AI never invents it. */
export interface CodebaseSummary {
  readonly indexId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly languages: readonly SourceLanguage[];
  readonly frameworks: readonly FrameworkDetection[];
  readonly entryPoints: readonly DetectedEntryPoint[];
  readonly routes: readonly DetectedRoute[];
  readonly symbolCounts: readonly { readonly kind: SymbolKind; readonly count: number }[];
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationshipCount: number;
  readonly dependencyCount: number;
  readonly testFilePaths: readonly SourcePath[];
  readonly configFilePaths: readonly SourcePath[];
  readonly architectureHints: readonly string[];
  readonly flaggedSecretFileCount: number;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Hard resource limits (Phase 35) - no unlimited graph traversal, ever
// ---------------------------------------------------------------------------

export interface CodebaseLimits {
  /** Maximum files listed for indexing (larger workspaces index the first N). */
  readonly maxIndexedFiles: number;
  /** Files above this byte size are skipped with `parseStatus: 'skipped'`. */
  readonly maxSourceBytesPerFile: number;
  /** Maximum symbols retained per file (rest counted, not stored). */
  readonly maxSymbolsPerFile: number;
  /** Maximum symbols stored in the whole index. */
  readonly maxSymbolsTotal: number;
  /** Maximum relationships stored in the whole index. */
  readonly maxRelationshipsTotal: number;
  /** Maximum search results returned by one query. */
  readonly maxSearchResults: number;
  /** Hard depth ceiling for feature tracing. */
  readonly maxTraceDepth: number;
  /** Hard node ceiling for feature tracing. */
  readonly maxTraceNodes: number;
  /** Wall-clock ceiling for one index build (checked between files). */
  readonly maxIndexDurationMs: number;
  /** Maximum bytes of any single source file content read at once. */
  readonly maxReadBytes: number;
  /** Maximum evidence strings retained per relationship. */
  readonly maxEvidenceLength: number;
}

export const DEFAULT_CODEBASE_LIMITS: CodebaseLimits = {
  maxIndexedFiles: 2000,
  maxSourceBytesPerFile: 1_000_000,
  maxSymbolsPerFile: 400,
  maxSymbolsTotal: 20_000,
  maxRelationshipsTotal: 30_000,
  maxSearchResults: 50,
  maxTraceDepth: 6,
  maxTraceNodes: 120,
  maxIndexDurationMs: 60_000,
  maxReadBytes: 2_000_000,
  maxEvidenceLength: 400,
};

export function isSourceLanguage(value: unknown): value is SourceLanguage {
  return typeof value === 'string' && (SOURCE_LANGUAGES as readonly string[]).includes(value);
}

export function isSymbolKind(value: unknown): value is SymbolKind {
  return typeof value === 'string' && (SYMBOL_KINDS as readonly string[]).includes(value);
}

export function isCodeSearchType(value: unknown): value is CodeSearchType {
  return typeof value === 'string' && (CODE_SEARCH_TYPES as readonly string[]).includes(value);
}

export function isStructuralQueryKind(value: unknown): value is StructuralQueryKind {
  return typeof value === 'string' && (STRUCTURAL_QUERY_KINDS as readonly string[]).includes(value);
}
