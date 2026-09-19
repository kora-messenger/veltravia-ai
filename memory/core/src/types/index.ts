/**
 * Core domain types for the Project Memory & Knowledge System.
 *
 * Project memory is DATA, not an authority layer. A memory record describes
 * durable project knowledge (what the project does, how it is built, which
 * decisions were made); it can never redefine system policies, permissions,
 * connector authorization, confirmation requirements, sandbox restrictions,
 * or tool availability. The trust hierarchy is fixed:
 *
 *     SYSTEM POLICY
 *         |
 *     SECURITY / PERMISSIONS
 *         |
 *     TOOLS
 *         |
 *     PROJECT MEMORY  (reference data)
 *         |
 *     AI CONTEXT       (delimited, untrusted)
 */

/**
 * The memory taxonomy. A closed validated vocabulary (plus optional
 * deployment-registered extension types) - never arbitrary strings.
 */
export const MEMORY_TYPES = [
  'project_summary',
  'architecture',
  'technology',
  'convention',
  'design_decision',
  'requirement',
  'api_contract',
  'dependency',
  'testing_rule',
  'known_issue',
  'known_limitation',
  'user_preference',
  'documentation',
  'milestone',
  'workflow',
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Pattern every extension type must match (kebab_case, 2..40 chars). */
export const MEMORY_EXTENSION_TYPE_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * Provenance kinds. Every memory names WHERE it came from - the system
 * never invents provenance, and not all sources carry equal authority
 * (that ranking is applied by the context builder, not stored per record).
 */
export const MEMORY_SOURCE_KINDS = [
  'user',
  'project_file',
  'generated_plan',
  'generation_run',
  'test_run',
  'debugging_run',
  'connector',
  'documentation',
  'system_derived',
] as const;

export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

/** Where a memory came from. `referenceId` is optional but never fabricated. */
export interface MemoryProvenance {
  readonly kind: MemorySourceKind;
  /** Stable reference to the originating artifact/run/file (opaque id). */
  readonly referenceId?: string;
}

/** Structured confidence: how strongly the system currently supports the memory. */
export const MEMORY_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

export type MemoryConfidence = (typeof MEMORY_CONFIDENCE_LEVELS)[number];

/**
 * Lifecycle states. `candidate` memories come from automatic extraction and
 * carry NO authority until a human approves them. `rejected` is terminal.
 */
export const MEMORY_STATUSES = ['candidate', 'active', 'archived', 'rejected'] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Verification status of a memory's content against current reality. */
export const MEMORY_VERIFICATION_STATUSES = ['unverified', 'verified', 'stale'] as const;

export type MemoryVerificationStatus = (typeof MEMORY_VERIFICATION_STATUSES)[number];

/** A single project-scoped knowledge record. */
export interface ProjectMemory {
  readonly id: string;
  readonly projectId: string;
  /** Workspace scoping (optional): memory that belongs to one workspace. */
  readonly workspaceId: string | null;
  readonly type: MemoryType;
  readonly title: string;
  readonly content: string;
  readonly source: MemoryProvenance;
  readonly confidence: MemoryConfidence;
  readonly status: MemoryStatus;
  readonly verificationStatus: MemoryVerificationStatus;
  readonly lastVerifiedAt: string | null;
  /** Optimistic concurrency: bumped on every update; clients pass expectedRevision. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A validated candidate produced by extraction - becomes a stored memory with status `candidate`. */
export type MemoryCandidate = ProjectMemory;

/** Input shape for creating a memory (validated by the manager). */
export interface CreateMemoryInput {
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly content: string;
  readonly source: MemoryProvenance;
  readonly confidence?: MemoryConfidence;
  readonly verificationStatus?: MemoryVerificationStatus;
  readonly lastVerifiedAt?: string;
  /**
   * Initial lifecycle status. Public create defaults to `active`; only the
   * candidate path (extraction) stores `candidate`. Rejected/archived can
   * never be set at creation.
   */
  readonly status?: Extract<MemoryStatus, 'candidate' | 'active'>;
}

/** Input shape for updating a memory (partial; expectedRevision required). */
export interface UpdateMemoryInput {
  readonly title?: string;
  readonly content?: string;
  readonly type?: MemoryType;
  readonly confidence?: MemoryConfidence;
  readonly expectedRevision: number;
}

/** Search filter - every field optional, every result bounded. */
export interface MemorySearchQuery {
  readonly projectId: string;
  readonly workspaceId?: string;
  /** Workspace-neutral search when true (workspace-scoped records excluded). */
  readonly projectWide?: boolean;
  readonly type?: MemoryType;
  readonly status?: MemoryStatus;
  readonly sourceKind?: MemorySourceKind;
  readonly text?: string;
  readonly limit?: number;
}

/** Sort keys for deterministic listing. */
export const MEMORY_SORT_KEYS = ['recent', 'created', 'confidence', 'title'] as const;

export type MemorySortKey = (typeof MEMORY_SORT_KEYS)[number];

export interface MemoryListQuery {
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly type?: MemoryType;
  readonly status?: MemoryStatus;
  readonly limit?: number;
  readonly sort?: MemorySortKey;
}

/** Hard resource limits with ceilings. Nothing here is negotiable at runtime. */
export const MEMORY_LIMITS = {
  /** Maximum title length. */
  maxTitleChars: 120,
  /** Maximum content length per memory. */
  maxContentChars: 4000,
  /** Maximum memories stored per project (active + archived + candidates). */
  maxMemoriesPerProject: 500,
  /** Maximum memories returned by one search. */
  maxSearchResults: 50,
  /** Maximum memories included in one AI context. */
  maxContextMemories: 12,
  /** Maximum serialized characters of one AI memory context. */
  maxContextChars: 6000,
  /** Maximum candidates one workflow extraction may produce. */
  maxCandidatesPerWorkflow: 10,
  /** Maximum search text length. */
  maxQueryChars: 200,
  /** Maximum provenance reference id length. */
  maxReferenceIdChars: 128,
} as const;

/** Confidence ranking used for deterministic ordering (higher wins). */
export const MEMORY_CONFIDENCE_RANK: Readonly<Record<MemoryConfidence, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};
