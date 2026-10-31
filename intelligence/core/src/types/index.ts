/** Cross-source intelligence domain types (Step 25).
 *
 * Everything here is provider-neutral. A source is described once, by a single
 * `SourceRef`, no matter whether it came from an uploaded document, a connected
 * app or a project workspace. Content is ALWAYS untrusted data and every claim
 * an answer makes points back at the evidence it came from. */

export const SOURCE_PROVIDERS = ['files', 'github', 'google_drive', 'notion', 'workspace'] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

export function isSourceProvider(value: unknown): value is SourceProvider {
  return typeof value === 'string' && (SOURCE_PROVIDERS as readonly string[]).includes(value);
}

export const SOURCE_TYPES = ['uploaded_document', 'connected_resource', 'project_file'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export function isSourceType(value: unknown): value is SourceType {
  return typeof value === 'string' && (SOURCE_TYPES as readonly string[]).includes(value);
}

/** The only trust tag a retrieved source can carry. Content never becomes a
 *  trusted instruction, no matter how it is phrased. */
export const UNTRUSTED = 'untrusted_data' as const;
export type TrustTag = typeof UNTRUSTED;

export interface SourceFreshness {
  readonly retrievedAt: string;
  readonly ageSeconds: number;
  readonly staleAfterSeconds: number;
  readonly stale: boolean;
}

/** Where a passage sits inside a source, in terms a reader can verify. */
export interface SourceLocator {
  readonly kind: 'page' | 'section' | 'line' | 'element';
  /** Human-readable location, e.g. "Requirements" or "line 41". */
  readonly label: string;
  readonly section: string | null;
  readonly path: string | null;
  readonly line: number | null;
  /** Character offsets inside the canonical source text. */
  readonly start: number;
  readonly end: number;
}

export interface SourceRef {
  readonly sourceId: string;
  readonly ownerRef: string;
  readonly provider: SourceProvider;
  readonly providerName: string;
  readonly sourceType: SourceType;
  readonly resourceId: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  /** Revision, checksum or provider ETag: the version the content came from. */
  readonly contentVersion: string;
  readonly retrievedAt: string;
  readonly modifiedAt: string | null;
  readonly sourceUrl: string | null;
  /** Scopes/permissions the owner granted for this source. */
  readonly permissions: readonly string[];
  readonly freshness: SourceFreshness;
  readonly trustTag: TrustTag;
}

/** A raw source handed in by an adapter. The registry owns owner scoping,
 *  retrieval timestamps, freshness and trust tagging, so an adapter cannot
 *  fabricate them. */
export interface RawSource {
  readonly resourceId: string;
  readonly name: string;
  readonly sourceType: SourceType;
  readonly mimeType: string | null;
  readonly text: string;
  readonly byteSize?: number | null;
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  readonly contentVersion: string;
  readonly modifiedAt?: string | null;
  readonly sourceUrl?: string | null;
  readonly permissions?: readonly string[];
  /** True when the adapter itself had to bound the content. */
  readonly truncated?: boolean;
}

export interface SourceSegment {
  readonly segmentId: string;
  readonly locator: SourceLocator;
  readonly heading: string | null;
  readonly text: string;
}

export interface SourceContent {
  readonly source: SourceRef;
  readonly text: string;
  readonly segments: readonly SourceSegment[];
  readonly truncated: boolean;
  readonly byteSize: number;
  readonly trustTag: TrustTag;
  readonly retrievedAt: string;
  /** True when the content contains instruction-shaped text. It is still never
   *  treated as an instruction: the flag only tells the UI and the audit log
   *  that the source tried. */
  readonly injectionRisk: boolean;
}

export interface ProviderAvailability {
  readonly provider: SourceProvider;
  readonly available: boolean;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchQuery {
  readonly text: string;
  readonly providers?: readonly SourceProvider[];
  readonly sourceTypes?: readonly SourceType[];
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  /** Only sources modified at or after this ISO timestamp. */
  readonly modifiedAfter?: string | null;
  readonly modifiedBefore?: string | null;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface SearchHit {
  readonly source: SourceRef;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly snippet: string;
  readonly locator: SourceLocator;
  readonly reasons: readonly string[];
  /** Sources with identical content collapse onto one hit. */
  readonly dedupeKey: string;
}

export interface SearchResponse {
  readonly query: SearchQuery;
  readonly hits: readonly SearchHit[];
  readonly totalMatched: number;
  readonly duplicatesRemoved: number;
  readonly sourcesScanned: number;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly searchedProviders: readonly SourceProvider[];
  readonly unavailableProviders: readonly ProviderAvailability[];
}

// ---------------------------------------------------------------------------
// Evidence and claims
// ---------------------------------------------------------------------------

export interface EvidenceRef {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly provider: SourceProvider;
  readonly resourceName: string;
  readonly locator: SourceLocator;
  readonly excerpt: string;
  readonly revision: string;
  readonly retrievedAt: string;
  readonly trustTag: TrustTag;
  /** True only when the excerpt was re-checked against the retrieved text. */
  readonly verified: boolean;
}

export const CLAIM_KINDS = [
  'verified_fact',
  'extracted_content',
  'inferred_relationship',
  'unsupported',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export interface Claim {
  readonly claimId: string;
  readonly statement: string;
  readonly kind: ClaimKind;
  readonly evidenceIds: readonly string[];
  /** 0..1. Deterministic providers derive it from evidence coverage. */
  readonly confidence: number;
}

export interface InformationGap {
  readonly gapId: string;
  readonly kind:
    'no_source' | 'not_retrieved' | 'unsupported_claim' | 'unavailable_provider' | 'stale_source';
  readonly description: string;
  readonly sourceIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Contradictions and relationships
// ---------------------------------------------------------------------------

export interface ContradictingStatement {
  readonly text: string;
  readonly sourceId: string;
  readonly resourceName: string;
  readonly evidenceId: string;
  readonly revision: string;
  readonly modifiedAt: string | null;
}

export const CONTRADICTION_KINDS = ['value_conflict', 'presence_conflict', 'superseded'] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

export interface Contradiction {
  readonly contradictionId: string;
  readonly kind: ContradictionKind;
  readonly topic: string;
  readonly statements: readonly ContradictingStatement[];
  readonly explanation: string;
  readonly confidence: number;
  /**
   * True only when the evidence itself settles the conflict (for example an
   * explicit "supersedes" statement naming the older source). The engine still
   * reports every statement: it never silently picks a side.
   */
  readonly resolvable: boolean;
  readonly resolution: string | null;
  readonly detectedBy: 'deterministic_rule';
}

export const RELATIONSHIP_KINDS = [
  'references',
  'describes_feature',
  'implements',
  'same_project',
  'supersedes',
  'mentions',
] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export interface Relationship {
  readonly relationshipId: string;
  readonly kind: RelationshipKind;
  readonly fromSourceId: string;
  readonly toSourceId: string;
  readonly explanation: string;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  /** Always true: relationships are derived, not asserted by a source. */
  readonly inferred: true;
}

export interface RelationshipGraphView {
  readonly nodes: readonly SourceRef[];
  readonly relationships: readonly Relationship[];
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Reasoning and answers
// ---------------------------------------------------------------------------

export const QUESTION_INTENTS = [
  'find',
  'compare',
  'contradictions',
  'summarize',
  'changes',
] as const;
export type QuestionIntent = (typeof QUESTION_INTENTS)[number];

export const REASONING_MODES = ['mock_reasoning', 'structural_extract', 'model_reasoning'] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export interface ReasoningDisclosure {
  readonly provider: string;
  readonly mode: ReasoningMode;
  /** True for every mode that is not a real model. */
  readonly simulated: boolean;
  readonly detail: string;
}

export interface SynthesisAnswer {
  readonly question: string;
  readonly intent: QuestionIntent;
  readonly status: 'answered' | 'partial' | 'no_evidence';
  readonly summary: string;
  readonly claims: readonly Claim[];
  readonly contradictions: readonly Contradiction[];
  readonly relationships: readonly Relationship[];
  readonly gaps: readonly InformationGap[];
  readonly sources: readonly SourceRef[];
  readonly evidence: readonly EvidenceRef[];
  readonly reasoning: ReasoningDisclosure;
  readonly searchedProviders: readonly SourceProvider[];
  readonly unavailableProviders: readonly ProviderAvailability[];
  readonly generatedAt: string;
  readonly truncated: boolean;
}

export interface ComparisonParticipant {
  readonly source: SourceRef;
  readonly evidence: readonly EvidenceRef[];
  readonly outline: readonly string[];
  readonly wordCount: number;
}

export interface ComparisonResult {
  readonly participants: readonly ComparisonParticipant[];
  readonly agreements: readonly Claim[];
  readonly contradictions: readonly Contradiction[];
  readonly onlyIn: readonly { readonly sourceId: string; readonly headings: readonly string[] }[];
  readonly reasoning: ReasoningDisclosure;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Synthesis jobs
// ---------------------------------------------------------------------------

export const SYNTHESIS_JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type SynthesisJobStatus = (typeof SYNTHESIS_JOB_STATUSES)[number];

export interface SynthesisJob {
  readonly jobId: string;
  readonly question: string;
  readonly status: SynthesisJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly result: SynthesisAnswer | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface IntelligenceLimits {
  readonly maxSourcesListed: number;
  readonly maxSourcesScanned: number;
  readonly maxContentBytes: number;
  readonly maxSegmentsPerSource: number;
  readonly maxExcerptChars: number;
  readonly maxEvidence: number;
  readonly maxClaims: number;
  readonly maxContradictions: number;
  readonly maxGraphNodes: number;
  readonly maxGraphEdges: number;
  readonly synthesisTimeoutMs: number;
  readonly contentCacheSeconds: number;
  readonly maxSearchResults: number;
  readonly staleAfterSeconds: number;
  readonly maxJobsPerOwner: number;
  readonly jobRetentionSeconds: number;
}

export const DEFAULT_INTELLIGENCE_LIMITS: IntelligenceLimits = {
  maxSourcesListed: 200,
  maxSourcesScanned: 40,
  maxContentBytes: 512 * 1024,
  maxSegmentsPerSource: 400,
  maxExcerptChars: 320,
  maxEvidence: 40,
  maxClaims: 24,
  maxContradictions: 20,
  maxGraphNodes: 60,
  maxGraphEdges: 160,
  synthesisTimeoutMs: 15000,
  contentCacheSeconds: 60,
  maxSearchResults: 50,
  staleAfterSeconds: 24 * 60 * 60,
  maxJobsPerOwner: 20,
  jobRetentionSeconds: 60 * 60,
};

/** Audit events are metadata only: no content, no excerpts, no secrets. */
export interface IntelligenceAuditSink {
  record(event: {
    readonly type: string;
    readonly ownerRef: string;
    readonly detail: string | null;
    readonly count: number | null;
  }): void;
}
