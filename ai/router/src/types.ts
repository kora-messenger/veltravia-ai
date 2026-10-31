import type { AICapability } from '@veltravia/ai-core';

/**
 * Multi-model intelligence types (Step 28).
 *
 * The router answers one question for the whole platform: given this task, this
 * owner's connected providers, their stated preferences and what the models can
 * actually do, which model should run it - and why. It selects; it never calls a
 * provider. Execution stays with the Step 26 gateway and the Step 27 reasoning
 * runtime, so there is exactly one place where a model is chosen and exactly one
 * place where a call is made.
 */

// ---------------------------------------------------------------------------
// Task categories
// ---------------------------------------------------------------------------

/**
 * The task categories the router understands. A category is a REQUIREMENT, not a
 * label: it maps to the capabilities a model must declare before it is allowed
 * to run the task.
 */
export const TASK_CATEGORIES = [
  'general-conversation',
  'complex-reasoning',
  'coding',
  'document-analysis',
  'cross-source-intelligence',
  'web-research',
  'structured-data-extraction',
  'image-understanding',
  'audio-processing',
  'video-understanding',
  'embeddings',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export function isTaskCategory(value: unknown): value is TaskCategory {
  return typeof value === 'string' && (TASK_CATEGORIES as readonly string[]).includes(value);
}

/** What the caller would rather have, when it can be honoured. */
export const PREFERENCE_KINDS = ['balanced', 'lower-cost', 'faster', 'stronger-reasoning'] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export function isPreferenceKind(value: unknown): value is PreferenceKind {
  return typeof value === 'string' && (PREFERENCE_KINDS as readonly string[]).includes(value);
}

/** How a model was chosen. */
export const ROUTING_MODES = ['automatic', 'manual', 'project'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export function isRoutingMode(value: unknown): value is RoutingMode {
  return typeof value === 'string' && (ROUTING_MODES as readonly string[]).includes(value);
}

/**
 * What may happen when the first choice cannot run.
 *
 * `none` is the default: the caller is told and decides. `compatible-alternate`
 * allows one substitute at ROUTING time - before any provider is called - so a
 * fallback can never bill a second model for the same work.
 */
export const FALLBACK_POLICIES = ['none', 'compatible-alternate'] as const;
export type FallbackPolicy = (typeof FALLBACK_POLICIES)[number];

export function isFallbackPolicy(value: unknown): value is FallbackPolicy {
  return typeof value === 'string' && (FALLBACK_POLICIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Where a model's capabilities came from. Never blurred: a model whose
 * capabilities were typed in by the owner is not presented as vendor-confirmed.
 */
export type CapabilitySource = 'provider-reported' | 'catalog' | 'manual';

/** A provider connection as the router needs to see it (no credential). */
export interface ConnectionFacts {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  /** Mirrors the gateway's connection status. */
  readonly status: 'active' | 'invalid' | 'unverified' | 'disabled';
  readonly modelIds: readonly string[];
  readonly defaultModelId?: string;
  readonly lastValidatedAt?: string;
}

/** One provider as declared in the Step 26 catalog. */
export interface ProviderFacts {
  readonly providerId: string;
  readonly displayName: string;
  /** Capabilities the adapter can request for a model. */
  readonly modelCapabilities: readonly AICapability[];
  /** Model facts the vendor or the platform declares up front. */
  readonly models?: readonly ProviderModelSeed[];
  /** Whether the vendor reports its own model list. */
  readonly reportsModels?: boolean;
}

export interface ProviderModelSeed {
  readonly modelId: string;
  readonly displayName?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly capabilities?: readonly AICapability[];
}

/** A normalized catalog entry. One row per provider/model the owner may use. */
export interface CatalogModel {
  readonly providerId: string;
  readonly providerName: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: readonly AICapability[];
  readonly capabilitySource: CapabilitySource;
  /** Null when nothing reliable is known. Never guessed from a model name. */
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly streaming: boolean;
  readonly available: boolean;
  /** Plain-language reason when unavailable. */
  readonly unavailableReason: string | null;
  /** How this row was discovered. */
  readonly discoverySource: 'connection' | 'catalog' | 'discovery';
  readonly lastValidatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** A concrete provider/model pair the owner picked. */
export interface ModelChoice {
  readonly connectionId: string;
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * Everything the owner has told the router. Project and task entries are
 * overrides on top of the user-level default, in that order of specificity.
 */
export interface RouterPreferences {
  readonly ownerRef: string;
  readonly autoSelect: boolean;
  readonly preference: PreferenceKind;
  readonly defaultModel: ModelChoice | null;
  readonly allowFallback: boolean;
  readonly taskPreferences: Readonly<Record<string, ModelChoice>>;
  readonly projectPreferences: Readonly<Partial<Record<string, ProjectRoutingPreference>>>;
  readonly updatedAt: string;
}

export interface ProjectRoutingPreference {
  /** Absent means "inherit the user's default model". */
  readonly model?: ModelChoice;
  /** Absent means "inherit the user's automatic/manual setting". */
  readonly autoSelect?: boolean;
  /** Absent means "inherit the user's preference kind". */
  readonly preference?: PreferenceKind;
  /** Per-task overrides inside this project. */
  readonly taskPreferences?: Readonly<Record<string, ModelChoice>>;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RoutingRequest {
  readonly category: TaskCategory;
  readonly mode?: RoutingMode;
  readonly projectId?: string;
  /** Manual mode: the caller's explicit pick. */
  readonly connectionId?: string;
  readonly modelId?: string;
  /** The caller requires a streamed answer. */
  readonly needsStreaming?: boolean;
  /** Estimated prompt size, so the context window can be checked honestly. */
  readonly estimatedInputTokens?: number;
  /** Expected answer size, added to the prompt when checking the window. */
  readonly expectedOutputTokens?: number;
  /** Extra capabilities this particular request needs. */
  readonly requires?: readonly AICapability[];
  /** Reason the router was called, for the audit trail (bounded, scrubbed). */
  readonly purpose?: string;
}

export interface RejectedModel {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly reason: string;
}

export type RouterOutcome = 'routed' | 'unsupported' | 'needs-attention';

export interface RoutingAudit {
  readonly candidateCount: number;
  readonly consideredCount: number;
  readonly rejectedCount: number;
  /** Which facts were missing, so nothing is implied that was not known. */
  readonly missingEvidence: readonly string[];
  readonly durationMs: number;
}

/** The recorded, safe explanation of one decision. */
export interface RoutingDecision {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly category: TaskCategory;
  readonly mode: RoutingMode;
  readonly outcome: RouterOutcome;
  readonly requestedAt: string;
  /** Null unless the outcome is `routed`. */
  readonly selected: {
    readonly connectionId: string;
    readonly providerId: string;
    readonly providerName: string;
    readonly modelId: string;
    readonly displayName: string;
    readonly contextWindowTokens: number | null;
    readonly streaming: boolean;
    readonly capabilitySource: CapabilitySource;
  } | null;
  /** One plain sentence a person can read. */
  readonly summary: string;
  readonly capabilitiesRequired: readonly AICapability[];
  readonly preference: PreferenceKind;
  /** Which preference level decided this route. */
  readonly decidedBy:
    'manual-request' | 'task-preference' | 'project-preference' | 'user-default' | 'automatic';
  readonly rejected: readonly RejectedModel[];
  readonly warnings: readonly string[];
  readonly fallback: {
    readonly policy: FallbackPolicy;
    readonly used: boolean;
    /** The model the caller's preference named, when a fallback replaced it. */
    readonly replaced: string | null;
  };
  readonly costComparison: 'unavailable' | 'not-requested';
  readonly contextWindowTokens: number | null;
  readonly audit: RoutingAudit;
}

/** One scored candidate, kept internally and never sent as-is. */
export interface CandidateScore {
  readonly model: CatalogModel;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface RouteScope {
  readonly ownerRef: string;
  readonly projectId?: string;
}
